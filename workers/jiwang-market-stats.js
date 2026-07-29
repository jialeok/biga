// Cloudflare Worker：每日收盘后自动抓取涨跌家数，填入下一交易日记忘看板「昨收盘结果」
// 触发方式：Cron Trigger（北京时间 16:00 = UTC 08:00）
// 环境变量：
//   NUMCAT_API_KEY          - NumCat API Key
//   SUPABASE_URL            - Supabase 项目 URL
//   SUPABASE_SERVICE_ROLE_KEY - Supabase service_role key（用于绕过 RLS 安全更新）
//   TZ                      - 可选，默认为 Asia/Shanghai

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(handleScheduled(env));
  },

  // 同时暴露 HTTP 入口，方便手动触发测试
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

  // 1. 获取"今天"（北京时间）
  const today = getTodayStr(tz);
  logs.push(`today=${today}`);

  // 2. 从 NumCat 获取今日涨跌家数
  const stats = await fetchNumCatMarketStats(env, today, logs);
  logs.push(`stats: 下跌=${stats.down}, 上涨=${stats.up}`);

  // 3. 计算下一交易日
  const nextTradingDay = await getNextTradingDay(env, today, logs);
  logs.push(`nextTradingDay=${nextTradingDay}`);

  // 4. 更新 Supabase jiwang_data 表
  await updateJiwangShouguJieguo(env, nextTradingDay, stats, logs);
  logs.push('upsert jiwang_data done');

  return { ok: true, today, nextTradingDay, stats, logs };
}

// =====================================================================
// NumCat 情绪周期接口：获取当日上涨家数(s2)和下跌家数(s6)
// =====================================================================
async function fetchNumCatMarketStats(env, today, logs) {
  const apiKey = env.NUMCAT_API_KEY;
  if (!apiKey) {
    throw new Error('NUMCAT_API_KEY 环境变量未设置');
  }

  const url = 'https://numcat.net/api/reference-proxy/market/emoindic-daily';
  const body = {
    apiname: 'emoindic_daily',
    apikey: apiKey,
    params: {}
  };

  logs.push(`fetch numcat market stats: ${url}`);
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`NumCat API HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }

  const json = await resp.json();
  if (json.code !== 200) {
    throw new Error(`NumCat API 返回错误: ${json.message || JSON.stringify(json)}`);
  }

  const fields = json.data.fields;
  const items = json.data.items;
  if (!Array.isArray(fields) || !Array.isArray(items) || items.length === 0) {
    throw new Error('NumCat API 返回数据格式异常');
  }

  // 优先取最新一条（通常 items 按日期升序，最后一条为当日）
  let latest = items[items.length - 1];

  // 如果接口有 trade_date/trading_day 字段且能匹配 today，优先用匹配当天那一行
  const dateFieldIdx = ['trade_date', 'trading_day', 'date', 'tradedate'].find(name => {
    return fields.indexOf(name) >= 0;
  });
  if (dateFieldIdx) {
    const idx = fields.indexOf(dateFieldIdx);
    const match = items.find(it => normalizeDate(it[idx]) === today);
    if (match) latest = match;
  }

  const upIdx = fields.indexOf('s2');
  const downIdx = fields.indexOf('s6');
  if (upIdx < 0 || downIdx < 0) {
    throw new Error(`NumCat API 响应缺少 s2/s6 字段，可用字段: ${fields.join(', ')}`);
  }

  return {
    up: Number(latest[upIdx]),
    down: Number(latest[downIdx])
  };
}

// =====================================================================
// 下一交易日计算：优先使用 NumCat 交易日历，失败则本地简单推算
// =====================================================================
async function getNextTradingDay(env, today, logs) {
  try {
    const tradingDays = await fetchNumCatTradingDays(env, today, logs);
    // 找 today 之后的第一个交易日
    for (const d of tradingDays) {
      if (d > today) return d;
    }
    logs.push('numcat calendar 返回的日期未包含下一交易日，回退到本地计算');
  } catch (e) {
    logs.push(`numcat calendar error: ${e.message}，回退到本地计算`);
  }
  return localGetNextTradingDay(today);
}

async function fetchNumCatTradingDays(env, today, logs) {
  const apiKey = env.NUMCAT_API_KEY;
  const url = 'https://numcat.net/api/reference-proxy/calendar/range';

  // 向后查 15 个交易日，足够覆盖小长假
  const end = addDays(today, 30);
  const body = {
    apiname: 'calendar_range',
    apikey: apiKey,
    params: { start: today, end }
  };

  logs.push(`fetch numcat calendar: ${today} ~ ${end}`);
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`NumCat calendar HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }

  const json = await resp.json();
  if (json.code !== 200) {
    throw new Error(`NumCat calendar 返回错误: ${json.message || JSON.stringify(json)}`);
  }

  // 兼容两种常见返回：数组 或 { fields, items }
  if (Array.isArray(json.data)) {
    return json.data.map(normalizeDate).filter(Boolean).sort();
  }
  if (json.data && Array.isArray(json.data.items)) {
    const fields = json.data.fields || [];
    const dateIdx = fields.indexOf('date');
    if (dateIdx >= 0) {
      return json.data.items.map(it => normalizeDate(it[dateIdx])).filter(Boolean).sort();
    }
  }

  throw new Error('NumCat calendar 返回格式无法解析');
}

function localGetNextTradingDay(dateStr) {
  const KNOWN_HOLIDAYS = new Set([
    // 2025 年中国法定节假日（A股休市）示例，按需补充
    '2025-01-01', '2025-01-28', '2025-01-29', '2025-01-30', '2025-01-31',
    '2025-02-01', '2025-02-02', '2025-02-03', '2025-04-04', '2025-04-05',
    '2025-04-06', '2025-05-01', '2025-05-02', '2025-05-03', '2025-05-04',
    '2025-05-05', '2025-06-02', '2025-10-01', '2025-10-02', '2025-10-03',
    '2025-10-06', '2025-10-07', '2025-10-08'
  ]);

  let d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + 1);

  while (true) {
    const s = d.toISOString().split('T')[0];
    const dayOfWeek = d.getDay();
    if (dayOfWeek !== 0 && dayOfWeek !== 6 && !KNOWN_HOLIDAYS.has(s)) {
      return s;
    }
    d.setDate(d.getDate() + 1);
  }
}

// =====================================================================
// Supabase jiwang_data 表更新：只写入 shouguJieguo 字段
// =====================================================================
async function updateJiwangShouguJieguo(env, date, stats, logs) {
  const supabaseUrl = env.SUPABASE_URL;
  const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY 环境变量未设置');
  }

  // 格式：下跌家数:上涨家数（与前端约定一致）
  const shouguJieguo = `${stats.down}:${stats.up}`;

  const url = `${supabaseUrl}/rest/v1/jiwang_data`;
  const body = {
    date: date,
    shouguJieguo: shouguJieguo,
    updated_at: new Date().toISOString()
  };

  logs.push(`upsert jiwang_data date=${date} shouguJieguo=${shouguJieguo}`);
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'apikey': supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates, return=minimal'
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Supabase upsert HTTP ${resp.status}: ${text.slice(0, 300)}`);
  }

  return true;
}

// =====================================================================
// 工具函数
// =====================================================================
function getTodayStr(tz) {
  return new Date().toLocaleDateString('en-CA', { timeZone: tz });
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

function normalizeDate(value) {
  if (!value) return '';
  const s = String(value).trim().replace(/-/g, '');
  if (/^\d{8}$/.test(s)) {
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return '';
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
