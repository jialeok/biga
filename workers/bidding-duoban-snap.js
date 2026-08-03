// Cloudflare Worker：竞价变化「最近多板%」行 9:25/9:26 两次自动抓取
// 触发方式：Cron Trigger（北京时间 9:25、9:26 = UTC 01:25、01:26）
// 环境变量：
//   SUPABASE_URL            - Supabase 项目 URL
//   SUPABASE_ANON_KEY       - Supabase anon key（fuyao-proxy 鉴权用）
//   SUPABASE_SERVICE_ROLE_KEY - Supabase service_role key（用于读写 bidding_data）
//   TZ                      - 可选，默认为 Asia/Shanghai
//
// 叠加效果实现：
//   第一次触发（9:25）：time930 = 值A，time930_initial = 值A，time930_initial_modifiedAt = 时间A
//   第二次触发（9:26）：time930 = 值B（最新），time930_initial = 值A（保持不变），time930_modifiedAt = 时间B
//   前端渲染时：格子按 time930 vs time920 变色；点击行弹窗显示首次/最终值及时间。

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(handleScheduled(env));
  },

  // 暴露 HTTP 入口，方便手动触发测试
  async fetch(request, env, ctx) {
    try {
      const result = await handleScheduled(env);
      return jsonResponse(result, result.ok ? 200 : 500);
    } catch (e) {
      return jsonResponse({ ok: false, error: e.message, stack: e.stack }, 500);
    }
  }
};

async function handleScheduled(env) {
  const logs = [];
  const tz = env.TZ || 'Asia/Shanghai';

  const today = getTodayStr(tz);
  logs.push(`today=${today}`);

  // 周末跳过（A股休市）
  if (isWeekend(today)) {
    logs.push('weekend, skip');
    return { ok: true, today, skipped: true, reason: 'weekend', logs };
  }

  // 1. 抓取「最近多板%」值
  const duobanValue = await fetchDuobanPct(env, logs);
  logs.push(`duoban=${duobanValue}`);

  // 2. 读取 bidding_data 当天「最近多板%」现有行
  const existing = await fetchExistingDuobanRow(env, today, logs);
  logs.push(`existing=${existing ? 'yes' : 'no'}`);

  // 3. 组装要写入的行（关键：保留 initial，更新 final）
  const row = buildDuobanRow(today, duobanValue, existing, logs);

  // 4. UPSERT
  await upsertBiddingRow(env, row, logs);
  logs.push('upsert bidding_data done');

  return { ok: true, today, duobanValue, row, logs };
}

// =====================================================================
// 抓取「最近多板%」：883410 成分股涨幅算术平均
// =====================================================================
async function fetchDuobanPct(env, logs) {
  const base = 'https://tonqfgeyxnnwicjopshn.supabase.co/functions/v1/fuyao-proxy';
  const authKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY;
  if (!authKey) throw new Error('SUPABASE_ANON_KEY 或 SUPABASE_SERVICE_ROLE_KEY 未设置');

  // 1) 成分股列表
  const listUrl = new URL(base);
  listUrl.searchParams.set('path', '/api/a-share-index/constituents/ths-stock-list');
  listUrl.searchParams.set('thscode', '883410.TI');
  logs.push(`fetch constituents: ${listUrl.toString().split('?')[0]}?...`);

  const listResp = await fetch(listUrl.toString(), { headers: { 'Authorization': `Bearer ${authKey}` } });
  if (!listResp.ok) {
    const text = await listResp.text().catch(() => '');
    throw new Error(`fuyao constituents HTTP ${listResp.status}: ${text.slice(0, 200)}`);
  }
  const listJson = await listResp.json();
  if (listJson.code !== 0) throw new Error(listJson.message || 'fuyao 成分股接口错误');
  const codes = ((listJson.data && listJson.data.item) || [])
    .map(it => it.thscode).filter(Boolean);
  if (codes.length === 0) throw new Error('883410 成分股为空');

  // 2) 批量快照（每 40 只）
  const pcts = [];
  for (let i = 0; i < codes.length; i += 40) {
    const chunk = codes.slice(i, i + 40);
    const snapUrl = new URL(base);
    snapUrl.searchParams.set('path', '/api/a-share/prices/snapshot');
    snapUrl.searchParams.set('thscodes', chunk.join(','));
    const snapResp = await fetch(snapUrl.toString(), { headers: { 'Authorization': `Bearer ${authKey}` } });
    if (!snapResp.ok) {
      const text = await snapResp.text().catch(() => '');
      throw new Error(`fuyao snapshot HTTP ${snapResp.status}: ${text.slice(0, 200)}`);
    }
    const snapJson = await snapResp.json();
    if (snapJson.code !== 0) throw new Error(snapJson.message || 'fuyao 快照接口错误');

    ((snapJson.data && snapJson.data.item) || []).forEach(it => {
      if (it && it.price_change_ratio_pct !== null && it.price_change_ratio_pct !== undefined) {
        let ratio = Number(it.price_change_ratio_pct);
        // 符号修正（与前端逻辑一致）
        const priceChange = it.price_change !== undefined && it.price_change !== null ? Number(it.price_change) : null;
        const curr = it.current_price !== undefined && it.current_price !== null ? Number(it.current_price) : null;
        const prev = it.prev_close !== undefined && it.prev_close !== null ? Number(it.prev_close) : null;
        const isActuallyDown = (priceChange !== null && priceChange < 0) || (curr !== null && prev !== null && curr < prev);
        if (isActuallyDown && ratio > 0) ratio = -ratio;
        if (typeof ratio === 'number' && !isNaN(ratio)) pcts.push(ratio);
      }
    });
  }

  if (pcts.length === 0) throw new Error('未获取到有效涨跌幅');
  const avg = pcts.reduce((a, b) => a + b, 0) / pcts.length;
  return avg.toFixed(2);
}

// =====================================================================
// 读取/写入 bidding_data
// =====================================================================
async function fetchExistingDuobanRow(env, date, logs) {
  const url = `${env.SUPABASE_URL}/rest/v1/bidding_data?date=eq.${encodeURIComponent(date)}&name=eq.${encodeURIComponent('最近多板%')}`;
  const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY;
  const resp = await fetch(url, {
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${key}`
    }
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Supabase select HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  const rows = await resp.json();
  return rows && rows.length > 0 ? rows[0] : null;
}

function buildDuobanRow(date, value, existing, logs) {
  const now = new Date().toISOString();
  const row = {
    date: date,
    name: '最近多板%',
    time930: String(value),
    updated_at: now
  };

  // 关键：已有 initial 则保留（第一次值），只更新 final；否则锁定 initial
  if (existing && existing.time930_initial !== undefined && existing.time930_initial !== null && String(existing.time930_initial).trim() !== '') {
    row.time930_initial = existing.time930_initial;
    row.time930_initial_modifiedAt = existing.time930_initial_modifiedAt || now;
    row.time930_modifiedAt = now;
    logs.push('mode: update final (keep initial)');
  } else {
    row.time930_initial = String(value);
    row.time930_initial_modifiedAt = now;
    // modifiedAt 为空表示尚未被二次修改
    logs.push('mode: lock initial');
  }

  // 如果已有 time920，自动计算 change 列（与前端 updateAllChangeValues 一致）
  if (existing && existing.time920 !== undefined && existing.time920 !== null && String(existing.time920).trim() !== '') {
    const v930 = parseFloat(value);
    const v920 = parseFloat(existing.time920);
    if (!isNaN(v930) && !isNaN(v920)) {
      if (v930 > v920) row.change = '增';
      else if (v930 < v920) row.change = '减';
      else row.change = '平';
    }
  }

  return row;
}

async function upsertBiddingRow(env, row, logs) {
  const url = `${env.SUPABASE_URL}/rest/v1/bidding_data?on_conflict=date,name`;
  const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY;
  logs.push(`upsert date=${row.date} name=${row.name} time930=${row.time930}`);
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates, return=minimal'
    },
    body: JSON.stringify(row)
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Supabase upsert HTTP ${resp.status}: ${text.slice(0, 300)}`);
  }
}

// =====================================================================
// 工具函数
// =====================================================================
function getTodayStr(tz) {
  return new Date().toLocaleDateString('en-CA', { timeZone: tz });
}

function isWeekend(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const day = d.getDay();
  return day === 0 || day === 6;
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}
