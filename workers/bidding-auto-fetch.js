/**
 * Cloudflare Worker：早盘竞价自动抓取
 *
 * 交易日每天自动执行两个时段：
 *   1. 9:25（北京时间，UTC 01:25）
 *      - 同花顺 fuyao：获取最近多板（883410.TI）成分股 → 写入 auction_watchlist
 *      - 猫抓 numcat daily_auc（recentdays=5）：一次性获取5个交易日的竞价量+竞价涨幅+竞昨成交比
 *        → volume(万) = auc_vol / 100
 *        → changePct = "+X.XX%"
 *        → yestVolume(万) = auc_vol / auc_to_pre_vol_pct（反推昨日全天成交量）
 *        → 写入 market_metrics(scope='auction')
 *
 *   2. 16:00（北京时间，UTC 08:00）
 *      - 同花顺 fuyao snapshot：获取收盘涨幅 → 覆盖 market_metrics.change_pct
 *
 * numcat 额度：每天仅 9:25 消耗 1 次，16:00 用同花顺不消耗 numcat。
 *
 * 环境变量（通过 wrangler secret 设置）：
 *   NUMCAT_API_KEY           - 猫抓 API Key
 *   SUPABASE_SERVICE_ROLE_KEY - Supabase service_role key（读写表）
 *   SUPABASE_ANON_KEY        - Supabase anon key（fuyao-proxy 鉴权）
 *   FETCH_TOKEN              - 手动触发调试用 token
 *
 * 手动触发：GET /fetch?token=<FETCH_TOKEN>&point=morning|close|auto
 */

// ══════════════════════════ 配置区 ══════════════════════════
const CONFIG = {
  SUPABASE_URL: 'https://tonqfgeyxnnwicjopshn.supabase.co',
  FUYAO_PROXY_BASE: 'https://tonqfgeyxnnwicjopshn.supabase.co/functions/v1/fuyao-proxy',

  // 最近多板指数
  LADDER_THSCODE: '883410.TI',

  // numcat daily_auc 接口
  NUMCAT_DAILY_AUC_URL: 'https://numcat.net/api/reference-proxy/stock/daily_auc',
  NUMCAT_RECENT_DAYS: 5,

  // fuyao snapshot 批量大小
  SNAPSHOT_BATCH_SIZE: 40,
};

// 已知节假日（A股休市），与 bidding-board-worker-b.js 保持一致
const KNOWN_HOLIDAYS = new Set([
  '2025-01-01', '2025-01-28', '2025-01-29', '2025-01-30', '2025-01-31',
  '2025-02-01', '2025-02-02', '2025-02-03', '2025-04-04', '2025-04-05',
  '2025-04-06', '2025-05-01', '2025-05-02', '2025-05-03', '2025-05-04',
  '2025-05-05', '2025-06-02', '2025-10-01', '2025-10-02', '2025-10-03',
  '2025-10-06', '2025-10-07', '2025-10-08',
  '2026-01-01', '2026-01-02', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23', '2026-04-05',
  '2026-04-06', '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04',
  '2026-05-05', '2026-06-19', '2026-10-01', '2026-10-02', '2026-10-03',
  '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08'
]);

// ══════════════════════════ 工具函数 ══════════════════════════

function beijingNow() {
  return new Date(Date.now() + 8 * 3600 * 1000);
}

function beijingToday() {
  const d = beijingNow();
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}

function beijingTodayCompact() {
  return beijingToday().replace(/-/g, '');
}

function normalizeDate(value) {
  if (!value) return '';
  const s = String(value).trim().replace(/-/g, '');
  if (/^\d{8}$/.test(s)) return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return '';
}

function compactToDateStr(compact) {
  // "20260731" → "2026-07-31"
  if (!compact) return '';
  const s = String(compact).replace(/-/g, '');
  if (s.length === 8) return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
  return normalizeDate(compact);
}

function isWeekend(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const day = d.getDay();
  return day === 0 || day === 6;
}

function localIsTradingDay(dateStr) {
  if (isWeekend(dateStr)) return false;
  return !KNOWN_HOLIDAYS.has(dateStr);
}

async function fuyaoCalendarTradingDays(env) {
  // 调 fuyao 交易日历，返回最近 N 天交易日列表（升序）
  const authKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY;
  const url = new URL(CONFIG.FUYAO_PROXY_BASE);
  url.searchParams.set('path', '/api/a-share/calendar/trading-days');
  const resp = await fetch(url.toString(), { headers: { 'Authorization': 'Bearer ' + authKey } });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error('fuyao calendar HTTP ' + resp.status + ': ' + text.slice(0, 200));
  }
  const json = await resp.json();
  if (json.code !== 0) throw new Error('fuyao calendar 错误: ' + (json.message || 'code=' + json.code));
  const items = (json.data && json.data.item) || [];
  return items.map(it => normalizeDate(it.date)).filter(Boolean).sort();
}

async function isTradingDay(env, dateStr) {
  try {
    const dates = await fuyaoCalendarTradingDays(env);
    return dates.includes(dateStr);
  } catch (e) {
    console.warn('fuyao 交易日历失败，回退本地日历:', e.message);
    return localIsTradingDay(dateStr);
  }
}

function sbHeaders(env) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY;
  return {
    'apikey': key,
    'Authorization': 'Bearer ' + key,
    'Content-Type': 'application/json',
  };
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj, null, 2), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

// ══════════════════════════ fuyao 接口 ══════════════════════════

async function fuyaoProxyGet(env, path, params) {
  const authKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY;
  const url = new URL(CONFIG.FUYAO_PROXY_BASE);
  url.searchParams.set('path', path);
  for (const k in params) {
    if (params[k] !== undefined && params[k] !== null) {
      url.searchParams.set(k, params[k]);
    }
  }
  const resp = await fetch(url.toString(), { headers: { 'Authorization': 'Bearer ' + authKey } });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error('fuyao-proxy ' + path + ' HTTP ' + resp.status + ': ' + text.slice(0, 200));
  }
  const json = await resp.json();
  if (json.code !== 0) throw new Error('fuyao ' + path + ' 错误: ' + (json.message || 'code=' + json.code));
  return json.data;
}

// 获取最近多板成分股 → [{ name, code }]
async function fetchLadderConstituents(env) {
  const data = await fuyaoProxyGet(env, '/api/a-share-index/constituents/ths-stock-list', { thscode: CONFIG.LADDER_THSCODE });
  const items = (data && data.item) || [];
  return items.map(it => {
    const name = (it.name || '').trim();
    let code = '';
    if (it.ticker) code = String(it.ticker).trim();
    else if (it.thscode) {
      const c = String(it.thscode).trim().replace(/\..*$/, '');
      if (/^\d{6}$/.test(c)) code = c;
    }
    return { name, code };
  }).filter(s => s.name && s.code);
}

// fuyao snapshot 批量获取收盘涨幅 → { code: pctStr }
async function fetchSnapshotChangePct(env, codes) {
  const result = {};
  const batchSize = CONFIG.SNAPSHOT_BATCH_SIZE;
  for (let i = 0; i < codes.length; i += batchSize) {
    const chunk = codes.slice(i, i + batchSize);
    const thscodes = chunk.map(c => tickerToThscode(c)).filter(Boolean).join(',');
    if (!thscodes) continue;
    let data;
    try {
      data = await fuyaoProxyGet(env, '/api/a-share/prices/snapshot', { thscodes: thscodes });
    } catch (batchErr) {
      // 整批失败 → 降级逐只
      console.warn('snapshot 批量失败，降级逐只:', batchErr.message);
      for (const code of chunk) {
        const thscode = tickerToThscode(code);
        if (!thscode) continue;
        try {
          const d1 = await fuyaoProxyGet(env, '/api/a-share/prices/snapshot', { thscodes: thscode });
          ((d1 && d1.item) || []).forEach(it => applySnapshotItem(it, code, result));
        } catch (e1) { /* 跳过 */ }
      }
      continue;
    }
    const items = (data && data.item) || [];
    const codeSet = new Set(chunk);
    items.forEach(it => {
      // snapshot 返回 thscode，需匹配回 code
      const tcode = String(it.thscode || '').replace(/\..*$/, '');
      if (tcode && codeSet.has(tcode)) {
        applySnapshotItem(it, tcode, result);
      }
    });
  }
  return result;
}

function applySnapshotItem(it, code, result) {
  const pct = it.price_change_ratio_pct;
  if (pct === null || pct === undefined || pct === '') return;
  const n = Number(pct);
  if (isNaN(n)) return;
  // 符号修正（与前端逻辑一致）
  let ratio = n;
  const priceChange = it.price_change !== undefined && it.price_change !== null ? Number(it.price_change) : null;
  const curr = it.current_price !== undefined && it.current_price !== null ? Number(it.current_price) : null;
  const prev = it.prev_close !== undefined && it.prev_close !== null ? Number(it.prev_close) : null;
  const isActuallyDown = (priceChange !== null && priceChange < 0) || (curr !== null && prev !== null && curr < prev);
  if (isActuallyDown && ratio > 0) ratio = -ratio;
  result[code] = (ratio >= 0 ? '+' : '') + ratio.toFixed(2) + '%';
}

function tickerToThscode(code) {
  // 6位数字 → thscode（SH/SZ/BJ）
  const c = String(code).trim();
  if (!/^\d{6}$/.test(c)) return '';
  if (c.startsWith('6') || c.startsWith('9')) return c + '.SH';
  if (c.startsWith('4') || c.startsWith('8')) return c + '.BJ';
  return c + '.SZ';
}

// ══════════════════════════ numcat 接口 ══════════════════════════

async function numcatDailyAuc(env, symbols, recentDays) {
  // 一次调用拿 recentDays 个交易日的竞价数据
  const body = {
    apiname: 'daily_auc',
    apikey: env.NUMCAT_API_KEY,
    fields: 'symbol,name,tradedate,auc_vol,auc_pct_chg,auc_to_pre_vol_pct',
    params: {
      symbols: symbols,
      recentdays: recentDays
    }
  };
  const resp = await fetch(CONFIG.NUMCAT_DAILY_AUC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error('numcat daily_auc HTTP ' + resp.status + ': ' + text.slice(0, 200));
  }
  const json = await resp.json();
  if (json.code !== 200) throw new Error('numcat daily_auc 错误: ' + (json.message || JSON.stringify(json)));
  return json.data;
}

// ══════════════════════════ Supabase 写入 ══════════════════════════

async function upsertAuctionWatchlist(env, rows) {
  if (!rows || rows.length === 0) return;
  const url = CONFIG.SUPABASE_URL + '/rest/v1/auction_watchlist?on_conflict=date,stock';
  const resp = await fetch(url, {
    method: 'POST',
    headers: Object.assign(sbHeaders(env), { 'Prefer': 'resolution=merge-duplicates, return=minimal' }),
    body: JSON.stringify(rows)
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error('upsert auction_watchlist 失败: HTTP ' + resp.status + ': ' + text.slice(0, 300));
  }
}

async function upsertMarketMetrics(env, rows) {
  if (!rows || rows.length === 0) return;
  const url = CONFIG.SUPABASE_URL + '/rest/v1/market_metrics?on_conflict=date,stock,scope';
  const resp = await fetch(url, {
    method: 'POST',
    headers: Object.assign(sbHeaders(env), { 'Prefer': 'resolution=merge-duplicates, return=minimal' }),
    body: JSON.stringify(rows)
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error('upsert market_metrics 失败: HTTP ' + resp.status + ': ' + text.slice(0, 300));
  }
}

async function updateStockCodeMap(env, pairs) {
  // pairs: [{ name, code }] → 写入 stock_topics 表的 code 列（前端 stockCodeMap 来源）
  // 实际上 stockCodeMap 存在 localStorage，这里只需确保 auction_watchlist 的 code 列正确即可
  // 前端 loadHotStocksFromCloud / pullFromCloud 会从 auction_watchlist 读取 code 回填 stockCodeMap
}

// ══════════════════════════ 主流程 ══════════════════════════

async function runMorning(env) {
  const logs = [];
  const today = beijingToday();
  logs.push('today=' + today);

  // 周末/节假日跳过
  if (isWeekend(today) || !localIsTradingDay(today)) {
    logs.push('非交易日，跳过');
    return { ok: true, today, skipped: true, reason: '非交易日', logs };
  }

  // 1. 获取最近多板成分股
  logs.push('步骤1：获取最近多板成分股...');
  let constituents;
  try {
    constituents = await fetchLadderConstituents(env);
  } catch (e) {
    logs.push('获取成分股失败: ' + e.message);
    return { ok: false, today, error: '获取成分股失败: ' + e.message, logs };
  }
  logs.push('成分股数量: ' + constituents.length);
  if (constituents.length === 0) {
    return { ok: false, today, error: '883410 成分股为空', logs };
  }

  // 2. 写入 auction_watchlist（当日竞价列表）
  logs.push('步骤2：写入 auction_watchlist...');
  const nowIso = new Date().toISOString();
  const watchlistRows = constituents.map(c => ({
    date: today,
    stock: c.name,
    code: c.code,
    volume: '',
    yest_volume: '',
    note: '',
    change_pct: '',
    topics: '',
    source: 'worker',
    obs_auto_added: false,
    updated_at: nowIso,
    updated_by: 'auto-fetch-worker'
  }));
  try {
    await upsertAuctionWatchlist(env, watchlistRows);
    logs.push('auction_watchlist 写入 ' + watchlistRows.length + ' 行');
  } catch (e) {
    logs.push('写入 auction_watchlist 失败: ' + e.message);
    return { ok: false, today, error: '写入 auction_watchlist 失败: ' + e.message, logs };
  }

  // 3. 调 numcat daily_auc 获取5天竞价数据
  logs.push('步骤3：调用 numcat daily_auc (recentdays=' + CONFIG.NUMCAT_RECENT_DAYS + ')...');
  const symbols = constituents.map(c => c.code).join(',');
  let numcatData;
  try {
    numcatData = await numcatDailyAuc(env, symbols, CONFIG.NUMCAT_RECENT_DAYS);
  } catch (e) {
    logs.push('numcat 调用失败: ' + e.message);
    return { ok: false, today, error: 'numcat 调用失败: ' + e.message, logs };
  }

  const fields = numcatData.fields || [];
  const items = numcatData.items || [];
  logs.push('numcat 返回 fields=' + JSON.stringify(fields) + ' items=' + items.length + '行');

  const symIdx = fields.indexOf('symbol');
  const nameIdx = fields.indexOf('name');
  const dateIdx = fields.indexOf('tradedate');
  const volIdx = fields.indexOf('auc_vol');
  const pctIdx = fields.indexOf('auc_pct_chg');
  const ratioIdx = fields.indexOf('auc_to_pre_vol_pct');

  if (symIdx < 0 || dateIdx < 0 || volIdx < 0) {
    return { ok: false, today, error: 'numcat 返回字段不完整: ' + JSON.stringify(fields), logs };
  }

  // 4. 解析数据 → 按 date 分组 → 写入 market_metrics
  logs.push('步骤4：解析数据并写入 market_metrics...');
  const codeToName = {};
  constituents.forEach(c => { codeToName[c.code] = c.name; });

  // 按 tradedate 分组：dateStr → [{ stock, code, volume, changePct, yestVolume }]
  const metricsByDate = {};
  let parsedCount = 0;
  let yestVolDerivedCount = 0;

  items.forEach(row => {
    const code = String(row[symIdx] || '').trim();
    const tradedate = String(row[dateIdx] || '').trim();
    const aucVol = row[volIdx];
    const apiName = nameIdx >= 0 ? String(row[nameIdx] || '').trim() : '';
    if (!code || !tradedate || aucVol === null || aucVol === undefined) return;

    const dateStr = compactToDateStr(tradedate);
    if (!dateStr) return;

    const stockName = codeToName[code] || apiName || '';
    if (!stockName) return;

    // volume(万) = auc_vol(手) / 100
    const volNum = Number(aucVol);
    const volumeStr = isNaN(volNum) ? '' : String(Math.round(volNum / 100));

    // changePct = "+X.XX%"
    let changePctStr = '';
    if (pctIdx >= 0) {
      const pct = row[pctIdx];
      if (pct !== null && pct !== undefined && pct !== '') {
        const n = Number(pct);
        if (!isNaN(n)) {
          changePctStr = (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
        }
      }
    }

    // yestVolume(万) = auc_vol(手) / auc_to_pre_vol_pct
    // auc_to_pre_vol_pct = 竞价量 ÷ 昨日全天成交量 × 100
    // → 昨日全天成交量(手) = auc_vol * 100 / auc_to_pre_vol_pct
    // → 昨日全天成交量(万) = auc_vol * 100 / auc_to_pre_vol_pct / 100 = auc_vol / auc_to_pre_vol_pct
    let yestVolumeStr = '';
    if (ratioIdx >= 0) {
      const ratio = row[ratioIdx];
      if (ratio !== null && ratio !== undefined && ratio !== '') {
        const r = Number(ratio);
        if (!isNaN(r) && r > 0 && volNum > 0) {
          yestVolumeStr = String(Math.round(volNum / r));
          yestVolDerivedCount++;
        }
      }
    }

    if (!metricsByDate[dateStr]) metricsByDate[dateStr] = [];
    metricsByDate[dateStr].push({
      stock: stockName,
      code: code,
      volume: volumeStr,
      change_pct: changePctStr,
      yest_volume: yestVolumeStr
    });
    parsedCount++;
  });

  logs.push('解析完成: ' + parsedCount + '条, 涉及 ' + Object.keys(metricsByDate).length + ' 个交易日, 反推昨日成交量 ' + yestVolDerivedCount + ' 条');

  // 写入 market_metrics
  let totalMetricsWritten = 0;
  const dateKeys = Object.keys(metricsByDate);
  for (const dateStr of dateKeys) {
    const rows = metricsByDate[dateStr].map(m => ({
      date: dateStr,
      stock: m.stock,
      code: m.code,
      volume: m.volume,
      yest_volume: m.yest_volume,
      change_pct: m.change_pct,
      scope: 'auction',
      source: 'worker',
      updated_at: nowIso,
      updated_by: 'auto-fetch-worker'
    }));
    try {
      await upsertMarketMetrics(env, rows);
      totalMetricsWritten += rows.length;
      logs.push('  market_metrics ' + dateStr + ': ' + rows.length + ' 行');
    } catch (e) {
      logs.push('  market_metrics ' + dateStr + ' 写入失败: ' + e.message);
    }
  }

  logs.push('完成: auction_watchlist ' + watchlistRows.length + ' 行, market_metrics ' + totalMetricsWritten + ' 行');
  return {
    ok: true,
    today,
    constituentsCount: constituents.length,
    numcatItems: items.length,
    metricsDates: dateKeys.length,
    metricsWritten: totalMetricsWritten,
    yestVolDerived: yestVolDerivedCount,
    logs
  };
}

async function runClose(env) {
  const logs = [];
  const today = beijingToday();
  logs.push('today=' + today);

  if (isWeekend(today) || !localIsTradingDay(today)) {
    logs.push('非交易日，跳过');
    return { ok: true, today, skipped: true, reason: '非交易日', logs };
  }

  // 1. 读取当日 auction_watchlist 获取股票列表
  logs.push('步骤1：读取当日 auction_watchlist...');
  const readUrl = CONFIG.SUPABASE_URL + '/rest/v1/auction_watchlist?date=eq.' + encodeURIComponent(today) + '&select=stock,code';
  let watchlist;
  try {
    const resp = await fetch(readUrl, { headers: sbHeaders(env) });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error('HTTP ' + resp.status + ': ' + text.slice(0, 200));
    }
    watchlist = await resp.json();
  } catch (e) {
    logs.push('读取 auction_watchlist 失败: ' + e.message);
    return { ok: false, today, error: '读取 auction_watchlist 失败: ' + e.message, logs };
  }
  logs.push('auction_watchlist 读取 ' + watchlist.length + ' 只');

  if (watchlist.length === 0) {
    logs.push('当日列表为空，跳过');
    return { ok: true, today, skipped: true, reason: '当日列表为空', logs };
  }

  // 2. fuyao snapshot 批量获取收盘涨幅
  logs.push('步骤2：调用 fuyao snapshot 获取收盘涨幅...');
  const codes = watchlist.map(w => w.code).filter(Boolean);
  const pctMap = await fetchSnapshotChangePct(env, codes);
  logs.push('snapshot 返回 ' + Object.keys(pctMap).length + ' 只涨幅');

  // 3. 写入 market_metrics（只覆盖 change_pct）
  logs.push('步骤3：写入 market_metrics change_pct...');
  const nowIso = new Date().toISOString();
  const metricsRows = watchlist.filter(w => w.code && pctMap[w.code]).map(w => ({
    date: today,
    stock: w.stock,
    code: w.code,
    change_pct: pctMap[w.code],
    scope: 'auction',
    source: 'worker',
    updated_at: nowIso,
    updated_by: 'auto-fetch-worker-close'
  }));

  try {
    await upsertMarketMetrics(env, metricsRows);
    logs.push('market_metrics 写入 ' + metricsRows.length + ' 行 change_pct');
  } catch (e) {
    logs.push('写入 market_metrics 失败: ' + e.message);
    return { ok: false, today, error: '写入 market_metrics 失败: ' + e.message, logs };
  }

  logs.push('完成: 收盘涨幅覆盖 ' + metricsRows.length + ' 只');
  return {
    ok: true,
    today,
    stocksCount: watchlist.length,
    pctUpdated: metricsRows.length,
    logs
  };
}

function autoPoint() {
  const d = beijingNow();
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  // 9:25 ~ 9:40 → morning
  if (mins >= 9 * 60 + 25 && mins < 9 * 60 + 40) return 'morning';
  // 15:00 之后 → close
  if (mins >= 15 * 60) return 'close';
  return null;
}

// ══════════════════════════ 入口 ═══════════════════════════

export default {
  async scheduled(event, env, ctx) {
    const point = cronToPoint(event.cron);
    if (!point) {
      console.error('[auto-fetch] 无法识别 cron:', event.cron);
      return;
    }
    if (point === 'morning') {
      ctx.waitUntil(runMorning(env).catch(e => console.error('[auto-fetch] morning error:', e.message)));
    } else if (point === 'close') {
      ctx.waitUntil(runClose(env).catch(e => console.error('[auto-fetch] close error:', e.message)));
    }
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return jsonResponse({ ok: true, service: 'bidding-auto-fetch' });
    }

    if (url.pathname === '/fetch') {
      const token = url.searchParams.get('token') || '';
      if (!env.FETCH_TOKEN || token !== env.FETCH_TOKEN) {
        return jsonResponse({ ok: false, error: 'token 无效' }, 403);
      }
      let point = url.searchParams.get('point') || 'auto';
      if (point === 'auto') {
        point = autoPoint();
        if (!point) {
          return jsonResponse({ ok: false, error: '当前北京时间不在任何抓取时段（9:25~9:40=morning, 15:00后=close）' });
        }
      }
      if (!['morning', 'close'].includes(point)) {
        return jsonResponse({ ok: false, error: 'point 必须是 morning|close|auto' });
      }
      try {
        const result = point === 'morning' ? await runMorning(env) : await runClose(env);
        return jsonResponse(result, result.ok ? 200 : 500);
      } catch (e) {
        return jsonResponse({ ok: false, error: e.message, stack: e.stack }, 500);
      }
    }

    return new Response('bidding-auto-fetch', { status: 200 });
  }
};

// 从 cron 表达式解析触发点
function cronToPoint(cronExpr) {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const min = parts[0], hour = parts[1];
  const key = min + ' ' + hour;
  // 01:25 UTC = 09:25 北京时间 → morning
  // 08:00 UTC = 16:00 北京时间 → close
  const MAP = {
    '25 1': 'morning',
    '0 8': 'close',
  };
  return MAP[key] || null;
}
