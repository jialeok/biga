/**
 * Cloudflare Worker：早盘竞价自动抓取
 *
 * 交易日每天自动执行两个时段：
 *   1. 9:25（北京时间，UTC 01:25）
 *      - 同花顺 fuyao ths-stock-list：获取最近多板（883410.TI）成分股 → 写入 auction_watchlist
 *      - 猫抓 numcat daily_auc（recentdays=5）：一次性获取5个交易日的竞价量+竞价涨幅+竞昨成交比
 *        → volume(万) = auc_vol / 100
 *        → changePct(当天临时) = "+X.XX%"（竞价涨幅，16:00 被 snapshot 覆盖）
 *        → yestVolume(万) = auc_vol / auc_to_pre_vol_pct（反推昨日全天成交量）
 *        → 写入 market_metrics(scope='auction')
 *      - 同花顺 fuyao historical（并发50只，adjust=none）：获取4个历史交易日收盘价
 *        → pct_chg = (close - prev_close) / prev_close * 100（不复权，口径和 snapshot 一致）
 *        → 覆盖 market_metrics.change_pct（历史4天）
 *
 *   2. 16:00（北京时间，UTC 08:00）
 *      - 同花顺 fuyao snapshot：获取当天收盘涨幅 → 覆盖 market_metrics.change_pct(当天)
 *
 * numcat 额度：每天仅 9:25 消耗 1 次，历史涨幅和当天收盘涨幅全走同花顺（新账号 FUYAO_API_KEY_HISTORY）。
 *
 * 环境变量（通过 wrangler secret 设置）：
 *   NUMCAT_API_KEY            - 猫抓 API Key
 *   SUPABASE_SERVICE_ROLE_KEY - Supabase service_role key（读写表）
 *   SUPABASE_ANON_KEY         - Supabase anon key（fuyao-proxy 鉴权）
 *   FUYAO_API_KEY_HISTORY     - 同花顺新账号 key（直连 historical，避免拖慢主账号）
 *   FETCH_TOKEN               - 手动触发调试用 token
 *
 * 手动触发：GET /fetch?token=<FETCH_TOKEN>&point=morning|close|auto
 */

// ══════════════════════════ 配置区 ══════════════════════════
const CONFIG = {
  SUPABASE_URL: 'https://tonqfgeyxnnwicjopshn.supabase.co',
  FUYAO_PROXY_BASE: 'https://tonqfgeyxnnwicjopshn.supabase.co/functions/v1/fuyao-proxy',

  // fuyao 直连（历史K线用新账号 key，避免拖慢主账号）
  FUYAO_DIRECT_BASE: 'https://fuyao.aicubes.cn',

  // 最近多板指数
  LADDER_THSCODE: '883410.TI',

  // numcat daily_auc 接口
  NUMCAT_DAILY_AUC_URL: 'https://numcat.net/api/reference-proxy/stock/daily_auc',
  NUMCAT_RECENT_DAYS: 5,

  // fuyao snapshot 批量大小
  SNAPSHOT_BATCH_SIZE: 40,

  // fuyao historical 并发数（同时发起的请求数，避免被限流）
  HISTORICAL_CONCURRENCY: 10,
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

// 取"截止到 todayStr（含）"最近 n 个真实交易日，升序返回 ["YYYY-MM-DD", ...]
// 【FIX 2026-08-03】用于替代 numcat recentdays，明确知道本次请求到底要哪几天，
// 优先走 fuyao 交易日历（准确对齐节假日/临时休市），失败时回退本地节假日表推算。
async function getRecentTradingDays(env, todayStr, n) {
  try {
    const dates = await fuyaoCalendarTradingDays(env);
    const upToToday = dates.filter(d => d <= todayStr);
    if (upToToday.length > 0) {
      return upToToday.slice(-n);
    }
  } catch (e) {
    console.warn('[RECENT-TD] fuyao 交易日历失败，回退本地日历: ' + e.message);
  }
  // 本地回退：从 todayStr 往前数，跳过周末和已知节假日
  const result = [];
  let ms = Date.parse(todayStr + 'T00:00:00+08:00');
  for (let i = 0; i < 60 && result.length < n; i++) {
    const d = new Date(ms);
    const s = d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
    if (localIsTradingDay(s)) result.unshift(s);
    ms -= 24 * 3600 * 1000;
  }
  return result;
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

// fuyao snapshot 批量获取收盘涨幅 → { pctMap: { code: pctStr }, stats: {...} }
// 【FIX 2026-08-03】原版本整批失败→逐只失败时静默 continue，字段空时静默 return，
// 调用方拿到空对象也以为"成功但没数据"，无法区分"接口故障"和"真没数据"。
// 改成：返回 stats 统计（batchFail/singleFail/emptyField/notMatched/success），
// 让 runClose 能据此判断覆盖率、决定是否重试、是否报失败。
async function fetchSnapshotChangePct(env, codes) {
  const result = {};
  const stats = {
    totalInput: codes.length,
    batchOk: 0,
    batchFail: 0,
    singleOk: 0,
    singleFail: 0,
    itemsReturned: 0,
    emptyField: 0,    // 接口返回了股票但 price_change_ratio_pct 为空
    notMatched: 0,    // 返回的 thscode 不在本次请求列表里
    success: 0        // 最终写入 result 的数量
  };
  const batchSize = CONFIG.SNAPSHOT_BATCH_SIZE;
  for (let i = 0; i < codes.length; i += batchSize) {
    const chunk = codes.slice(i, i + batchSize);
    const thscodes = chunk.map(c => tickerToThscode(c)).filter(Boolean).join(',');
    if (!thscodes) continue;
    let data;
    try {
      data = await fuyaoProxyGet(env, '/api/a-share/prices/snapshot', { thscodes: thscodes });
      stats.batchOk++;
    } catch (batchErr) {
      // 整批失败 → 降级逐只
      stats.batchFail++;
      console.warn('snapshot 批量失败，降级逐只:', batchErr.message);
      for (const code of chunk) {
        const thscode = tickerToThscode(code);
        if (!thscode) continue;
        try {
          const d1 = await fuyaoProxyGet(env, '/api/a-share/prices/snapshot', { thscodes: thscode });
          stats.singleOk++;
          const items1 = (d1 && d1.item) || [];
          stats.itemsReturned += items1.length;
          items1.forEach(it => applySnapshotItem(it, code, result, stats));
        } catch (e1) {
          stats.singleFail++;
          /* 跳过单只失败，不影响其它 */
        }
      }
      continue;
    }
    const items = (data && data.item) || [];
    stats.itemsReturned += items.length;
    const codeSet = new Set(chunk);
    items.forEach(it => {
      // snapshot 返回 thscode，需匹配回 code
      const tcode = String(it.thscode || '').replace(/\..*$/, '');
      if (tcode && codeSet.has(tcode)) {
        applySnapshotItem(it, tcode, result, stats);
      } else {
        stats.notMatched++;
      }
    });
  }
  stats.success = Object.keys(result).length;
  return { pctMap: result, stats };
}

// 【FIX 2026-08-03】增加 stats 参数，空值不再静默 return，而是累计 emptyField 计数，
// 让调用方能区分"接口故障返回空"和"真无数据"。
function applySnapshotItem(it, code, result, stats) {
  const pct = it.price_change_ratio_pct;
  if (pct === null || pct === undefined || pct === '') {
    if (stats) stats.emptyField++;
    return;
  }
  const n = Number(pct);
  if (isNaN(n)) {
    if (stats) stats.emptyField++;
    return;
  }
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

// 毫秒时间戳 → "YYYY-MM-DD"（按 Asia/Shanghai 时区）
function msToDateStr(ms) {
  // fuyao date_ms 是 Asia/Shanghai 时区当日零点对应的毫秒时间戳
  // 加 8 小时偏移后用 UTC 方法解析，避免 Worker 运行时本地时区干扰
  const d = new Date(ms + 8 * 3600 * 1000);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}

// "YYYY-MM-DD" → 当日零点（Asia/Shanghai）的毫秒时间戳
function dateStrToMs(dateStr) {
  // dateStr 视为北京零点 → 对应 UTC 毫秒 = Date.parse(dateStr + 'T00:00:00+08:00')
  return Date.parse(dateStr + 'T00:00:00+08:00');
}

// 直连 fuyao（用新账号 key，绕过 supabase proxy）
// 返回 { thscode, items: [{ dateStr, close }] } 失败返回 { thscode, error }
async function fuyaoDirectHistorical(env, thscode, startMs, endMs) {
  const apiKey = env.FUYAO_API_KEY_HISTORY || env.FUYAO_API_KEY;
  if (!apiKey) {
    return { thscode, error: '缺少 FUYAO_API_KEY_HISTORY' };
  }
  const url = new URL(CONFIG.FUYAO_DIRECT_BASE + '/api/a-share/prices/historical');
  url.searchParams.set('thscode', thscode);
  url.searchParams.set('interval', '1d');
  url.searchParams.set('start', String(startMs));
  url.searchParams.set('end', String(endMs));
  url.searchParams.set('adjust', 'none'); // 不复权，和 snapshot 口径一致
  try {
    const resp = await fetch(url.toString(), { headers: { 'X-api-key': apiKey } });
    const json = await resp.json();
    if (json.code !== 0) {
      return { thscode, error: 'fuyao historical code=' + json.code + ' ' + (json.message || '') };
    }
    const items = ((json.data && json.data.item) || []).map(it => ({
      dateStr: msToDateStr(it.date_ms),
      close: Number(it.close_price)
    })).filter(it => !isNaN(it.close));
    // 按日期升序，确保 prev_close 错位计算正确
    items.sort((a, b) => a.dateStr < b.dateStr ? -1 : (a.dateStr > b.dateStr ? 1 : 0));
    return { thscode, items };
  } catch (e) {
    return { thscode, error: e.message };
  }
}

// 并发抓取所有成分股的历史K线，计算4个历史交易日的收盘涨幅
// 返回 { dateStr: { code: "+X.XX%" } }
async function fetchHistoricalPctChg(env, constituents, historicalDates) {
  if (!constituents.length || !historicalDates.length) return {};
  const result = {}; // dateStr → { code: pctStr }
  historicalDates.forEach(d => { result[d] = {}; });

  // 窗口：最早历史日 -7天（覆盖前一日收盘用于 pct_chg 计算） ~ 今天
  const earliest = historicalDates.slice().sort()[0];
  const startMs = dateStrToMs(earliest) - 7 * 24 * 3600 * 1000;
  const endMs = Date.now();

  const targetSet = new Set(historicalDates);
  let successCount = 0, failCount = 0;

  // 分批并发（每批 HISTORICAL_CONCURRENCY 个）
  const concurrency = CONFIG.HISTORICAL_CONCURRENCY;
  for (let i = 0; i < constituents.length; i += concurrency) {
    const chunk = constituents.slice(i, i + concurrency);
    const promises = chunk.map(c => {
      const thscode = tickerToThscode(c.code);
      if (!thscode) return Promise.resolve(null);
      return fuyaoDirectHistorical(env, thscode, startMs, endMs);
    });
    const results = await Promise.all(promises);
    results.forEach((r, idx) => {
      if (!r) return;
      const code = chunk[idx].code;
      if (r.error) {
        failCount++;
        return;
      }
      // 逐日算 pct_chg = (close[i] - close[i-1]) / close[i-1] * 100
      for (let j = 1; j < r.items.length; j++) {
        const dateStr = r.items[j].dateStr;
        if (!targetSet.has(dateStr)) continue;
        const prevClose = r.items[j - 1].close;
        const currClose = r.items[j].close;
        if (!prevClose || isNaN(prevClose) || prevClose === 0) continue;
        const pct = (currClose - prevClose) / prevClose * 100;
        if (isNaN(pct)) continue;
        result[dateStr][code] = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
      }
      successCount++;
    });
  }

  return { byDate: result, successCount, failCount };
}

// ══════════════════════════ numcat 接口 ══════════════════════════

async function numcatDailyAuc(env, symbols, startDateYMD, endDateYMD) {
  // 【FIX 2026-08-03】改用显式 startdate/enddate（YYYYMMDD），不再用 recentdays。
  // recentdays 是"猫抓自己认为最近 N 个有数据的交易日"，不保证严格对齐 A股交易日历，
  // 也不保证包含"今天"（尤其 9:25 请求时，猫抓可能还没来得及把当天数据入库，
  // 于是 recentdays=5 返回的是过去5个某些日子，今天缺失且没有任何报错/日志线索）。
  // 前端手动"连抓三天补全"按钮一直用的是 startdate+enddate（显式日期），这里保持一致，
  // 这样才能明确知道"这次请求到底要哪几天"，返回缺哪天也能立刻定位。
  const body = {
    apiname: 'daily_auc',
    apikey: env.NUMCAT_API_KEY,
    fields: 'symbol,name,tradedate,auc_vol,auc_pct_chg,auc_to_pre_vol_pct',
    params: {
      symbols: symbols,
      startdate: startDateYMD,
      enddate: endDateYMD
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
  // 【FIX 2026-08-03】加 missing=default：批次里某一行没带某个字段时，
  // 保留该字段云端原值，而不是被 upsert 成列默认值（通常是 NULL）。
  // 必须配合"每个批次内所有行 key 集合一致"使用（PostgREST 要求批量 insert 的 JSON 数组 key 统一，
  // key 不一致的行，多出/缺失的 key 会被忽略而不是报错，行为不可预期）。
  const resp = await fetch(url, {
    method: 'POST',
    headers: Object.assign(sbHeaders(env), { 'Prefer': 'resolution=merge-duplicates, missing=default, return=minimal' }),
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
  // 【BUG-FIX】不写 volume/yest_volume/change_pct/note/topics 字段：
  // 这些字段的真实值由步骤4写入 market_metrics 表。如果这里把空串写进 watchlist，
  // 后续每个交易日的 morning 都会用空串覆盖用户在前端手动编辑过的值。
  // Supabase upsert 只更新 row 中包含的字段，省略字段 = 保留原值。
  logs.push('步骤2：写入 auction_watchlist...');
  const nowIso = new Date().toISOString();
  const watchlistRows = constituents.map(c => ({
    date: today,
    stock: c.name,
    code: c.code,
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

  // 3. 调 numcat daily_auc 获取竞价数据
  // 【FIX 2026-08-03】先算出"预期要拿到数据的 N 个交易日"（含今天），再用显式 startdate/enddate 请求，
  // 不再用 recentdays——recentdays 不保证严格对齐交易日历，也不保证包含"今天"
  // （尤其 9:25 请求时，猫抓可能还没来得及入库当天数据，此前完全没有任何提示）。
  const expectedDates = await getRecentTradingDays(env, today, CONFIG.NUMCAT_RECENT_DAYS);
  logs.push('步骤3：预期交易日=' + JSON.stringify(expectedDates));
  if (expectedDates.length === 0 || expectedDates[expectedDates.length - 1] !== today) {
    logs.push('⚠️ 预期交易日列表不包含今天(' + today + ')，交易日历可能有问题，仍继续尝试');
  }
  const startYMD = expectedDates.length > 0 ? expectedDates[0].replace(/-/g, '') : today.replace(/-/g, '');
  const endYMD = today.replace(/-/g, '');
  logs.push('步骤3：调用 numcat daily_auc (startdate=' + startYMD + ' enddate=' + endYMD + ')...');
  const symbols = constituents.map(c => c.code).join(',');
  let numcatData;
  try {
    numcatData = await numcatDailyAuc(env, symbols, startYMD, endYMD);
  } catch (e) {
    logs.push('numcat 调用失败: ' + e.message);
    return { ok: false, today, error: 'numcat 调用失败: ' + e.message, logs };
  }

  const fields = numcatData.fields || [];
  let items = numcatData.items || [];
  logs.push('numcat 返回 fields=' + JSON.stringify(fields) + ' items=' + items.length + '行');

  // 【FIX 2026-08-03】按预期交易日统计实际返回的行数，缺口清清楚楚打在日志里，
  // 不再"拿到几天算几天、缺了也不知道"。
  const dateIdxPre = fields.indexOf('tradedate');
  const computeGotDates = (rows) => new Set(rows.map(row => compactToDateStr(String(row[dateIdxPre] || '').trim())).filter(Boolean));
  let missingDatesAfterNumcat = []; // 函数作用域，供最后汇总用
  if (dateIdxPre >= 0) {
    let gotDates = computeGotDates(items);
    let missingDates = expectedDates.filter(d => !gotDates.has(d));
    if (missingDates.length > 0) {
      logs.push('⚠️ numcat 缺失交易日: ' + JSON.stringify(missingDates) + '（预期 ' + JSON.stringify(expectedDates) + '，实际含 ' + JSON.stringify(Array.from(gotDates).sort()) + '）');
    } else {
      logs.push('numcat 覆盖了全部 ' + expectedDates.length + ' 个预期交易日');
    }

    // 【FIX 2026-08-03】若"今天"这个交易日缺失，大概率是竞价撮合(9:25整)和 numcat 入库有时间差
    // （worker cron 恰好也在 9:25 触发，二者几乎同时），做 2 次延迟重试（20秒/40秒），
    // 只重试"今天"这一天缺失的情况，避免历史日缺失（数据源本身问题）也无谓重试。
    if (missingDates.includes(today)) {
      const retryDelaysSec = [20, 40];
      for (let attempt = 0; attempt < retryDelaysSec.length && missingDates.includes(today); attempt++) {
        const waitSec = retryDelaysSec[attempt];
        logs.push('⏳ 今天(' + today + ')数据缺失，' + waitSec + '秒后重试第' + (attempt + 1) + '次...');
        await new Promise(r => setTimeout(r, waitSec * 1000));
        try {
          const retryData = await numcatDailyAuc(env, symbols, startYMD, endYMD);
          const retryItems = retryData.items || [];
          const retryGotDates = computeGotDates(retryItems);
          if (retryGotDates.has(today)) {
            items = retryItems;
            gotDates = retryGotDates;
            missingDates = expectedDates.filter(d => !gotDates.has(d));
            logs.push('✅ 重试第' + (attempt + 1) + '次成功拿到今天数据，items=' + items.length + '行');
          } else {
            logs.push('第' + (attempt + 1) + '次重试仍未拿到今天数据（items=' + retryItems.length + '行）');
          }
        } catch (e) {
          logs.push('第' + (attempt + 1) + '次重试请求失败: ' + e.message);
        }
      }
      if (missingDates.includes(today)) {
        logs.push('❌ 重试后今天(' + today + ')数据仍缺失，本次不会写入今天的 market_metrics，需要手动补抓');
      }
    }
    missingDatesAfterNumcat = missingDates;
  }

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

  // 5. fuyao historical 并发抓历史交易日的收盘涨幅，覆盖/补齐 numcat 的竞价涨幅
  //    当天(D)涨幅先用 numcat auc_pct_chg 临时占位，16:00 由 snapshot 覆盖
  //    历史日(D-1~D-4)用 fuyao 不复权收盘价算 pct_chg，口径和 16:00 snapshot 一致
  //
  //    【FIX 2026-08-03】原逻辑只对"numcat 有返回、但缺涨幅"的日期做 fuyao 兜底，
  //    如果 numcat 这一天整个都没返回（比如 7/28 那种情况），这一天压根不会出现在
  //    metricsByDate 里，historicalDates 也就收集不到它，fuyao 兜底根本不会跑，
  //    表现就是"5个交易日里有几天完全是空的，没有任何解释"。
  //    改成：以"预期交易日"为准，不管 numcat 有没有返回都尝试用 fuyao 兜底 change_pct
  //    （volume/yest_volume 只有 numcat 的 auc_vol/auc_to_pre_vol_pct 能算，fuyao historical
  //    没有对应数据，这两个字段缺了目前无法从其它数据源补，只能清楚地记录缺口）。
  const numcatCoveredDates = new Set(Object.keys(metricsByDate));
  const historicalDates = expectedDates.filter(d => d < today).sort();
  const phantomDates = historicalDates.filter(d => !numcatCoveredDates.has(d)); // numcat 完全没返回的历史日
  if (phantomDates.length > 0) {
    logs.push('⚠️ numcat 完全未返回以下历史交易日（volume/yest_volume 本次无法补齐，change_pct 会尝试用 fuyao historical 兜底）: ' + JSON.stringify(phantomDates));
  }
  let histPctStats = null;
  if (historicalDates.length > 0) {
    logs.push('步骤5：fuyao historical 并发抓取 ' + historicalDates.length + ' 个历史交易日收盘涨幅...');
    try {
      histPctStats = await fetchHistoricalPctChg(env, constituents, historicalDates);
      logs.push('fuyao historical: 成功 ' + histPctStats.successCount + ' 只, 失败 ' + histPctStats.failCount + ' 只');
      // 合并：覆盖/补齐历史日的 change_pct
      let mergedCount = 0;
      let phantomFilledCount = 0;
      historicalDates.forEach(d => {
        const pctMap = histPctStats.byDate[d] || {};
        if (metricsByDate[d]) {
          // numcat 原本就有这一天的行，覆盖 change_pct
          metricsByDate[d].forEach(m => {
            if (pctMap[m.code]) {
              m.change_pct = pctMap[m.code];
              mergedCount++;
            }
          });
        } else if (Object.keys(pctMap).length > 0) {
          // numcat 完全没返回这一天，但 fuyao historical 有数据：
          // 建一份只带 change_pct（无 volume/yest_volume）的行，好过完全没有
          metricsByDate[d] = constituents
            .filter(c => pctMap[c.code])
            .map(c => ({ stock: c.name, code: c.code, volume: '', yest_volume: '', change_pct: pctMap[c.code] }));
          phantomFilledCount += metricsByDate[d].length;
        }
      });
      logs.push('历史涨幅合并 ' + mergedCount + ' 条' + (phantomFilledCount > 0 ? '，另外用 fuyao 补齐了 numcat 完全缺失日期的涨幅 ' + phantomFilledCount + ' 条（这些行没有 volume/yest_volume）' : ''));
    } catch (e) {
      logs.push('fuyao historical 失败(保留 numcat 竞价涨幅): ' + e.message);
    }
  } else {
    logs.push('步骤5：无历史交易日，跳过 fuyao historical');
  }

  // 写入 market_metrics
  // 【FIX 2026-08-03】Supabase merge-duplicates upsert 是整行替换，payload 里出现的字段一律覆盖旧值，
  // 哪怕新值是空字符串。之前 volume/change_pct/yest_volume 算不出来时仍然带着 '' 一起发，
  // 会把云端原本正常的值冲成空——这是用户反馈"有时候数据反而变空"的一个诱因。
  // 改成：字段算不出来就不放进 payload 里，配合 missing=default 让 Supabase 保留原值。
  // PostgREST 批量 insert 要求同一批 JSON 数组里所有对象 key 集合一致，key 不一致会被忽略，
  // 所以这里按"这一行到底带了哪些字段"分桶，同一桶内 key 完全一致，分开发送。
  let totalMetricsWritten = 0;
  let metricsWriteFailures = 0; // 【修复4】market_metrics 写入失败批次计数,用于暴露表未就绪/RLS 阻止
  const dateKeys = Object.keys(metricsByDate);
  for (const dateStr of dateKeys) {
    const shapeBuckets = {}; // shapeKey → rows[]
    metricsByDate[dateStr].forEach(m => {
      const hasVolume = m.volume !== '';
      const hasYestVolume = m.yest_volume !== '';
      const hasChangePct = m.change_pct !== '';
      const shapeKey = (hasVolume ? 'v' : '') + (hasYestVolume ? 'y' : '') + (hasChangePct ? 'p' : '');
      const row = {
        date: dateStr,
        stock: m.stock,
        code: m.code,
        scope: 'auction',
        source: 'worker',
        updated_at: nowIso,
        updated_by: 'auto-fetch-worker'
      };
      if (hasVolume) row.volume = m.volume;
      if (hasYestVolume) row.yest_volume = m.yest_volume;
      if (hasChangePct) row.change_pct = m.change_pct;
      if (!shapeBuckets[shapeKey]) shapeBuckets[shapeKey] = [];
      shapeBuckets[shapeKey].push(row);
    });
    try {
      let dateWritten = 0;
      for (const shapeKey of Object.keys(shapeBuckets)) {
        await upsertMarketMetrics(env, shapeBuckets[shapeKey]);
        dateWritten += shapeBuckets[shapeKey].length;
      }
      totalMetricsWritten += dateWritten;
      logs.push('  market_metrics ' + dateStr + ': ' + dateWritten + ' 行 (' + Object.keys(shapeBuckets).length + ' 个字段组合批次)');
    } catch (e) {
      metricsWriteFailures++;
      logs.push('  market_metrics ' + dateStr + ' 写入失败: ' + e.message);
    }
  }

  // 【FIX 2026-08-03】汇总数据完整性：今天缺失 / 历史日完全缺失(volume+yest_volume 缺) 一次性说清楚，
  // 不用再从几十行 logs 里自己找。
  const todayMissing = missingDatesAfterNumcat.includes(today);
  const summaryParts = [];
  if (todayMissing) summaryParts.push('❌ 今天(' + today + ')竞价数据缺失，需手动补抓');
  if (phantomDates.length > 0) summaryParts.push('⚠️ 历史日 volume/yest_volume 缺失: ' + phantomDates.join(', '));
  if (metricsWriteFailures > 0) summaryParts.push('❌ market_metrics 写入失败 ' + metricsWriteFailures + ' 个日期批次(可能表未就绪/RLS 阻止/字段不符),数据未落库');
  const completenessSummary = summaryParts.length > 0 ? summaryParts.join('；') : '✅ 本次 ' + expectedDates.length + ' 个交易日数据完整';
  logs.push('数据完整性汇总: ' + completenessSummary);

  logs.push('完成: auction_watchlist ' + watchlistRows.length + ' 行, market_metrics ' + totalMetricsWritten + ' 行');
  return {
    ok: metricsWriteFailures === 0 || totalMetricsWritten > 0,
    today,
    constituentsCount: constituents.length,
    numcatItems: items.length,
    metricsDates: dateKeys.length,
    metricsWritten: totalMetricsWritten,
    yestVolDerived: yestVolDerivedCount,
    metricsWriteFailures: metricsWriteFailures,
    expectedDates: expectedDates,
    todayDataMissing: todayMissing,
    historicalDatesMissingFromNumcat: phantomDates,
    completenessSummary: completenessSummary,
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

  // 【FIX 2026-08-03 Bug1】原版本 watchlist 为空时返回 ok:true + skipped:true，
  // scheduled handler 打的日志是 "runClose 完成 ok=true"，看起来完全正常，
  // 但实际是 morning cron 失败导致 watchlist 没写入，close 啥也没干。
  // 改成：明确报警返回 ok:false，让 scheduled 日志立刻能看出问题。
  if (watchlist.length === 0) {
    logs.push('❌ 当日 auction_watchlist 为空，说明今早 morning cron 未成功写入 watchlist，close 无法覆盖涨幅');
    logs.push('❌ 请检查今早 9:25 morning cron 是否触发、numcat/fuyao 接口是否正常');
    return {
      ok: false,
      today,
      error: '当日 auction_watchlist 为空（morning cron 可能未成功）',
      skipped: true,
      reason: '当日列表为空',
      logs
    };
  }

  // 2. fuyao snapshot 批量获取收盘涨幅
  // 【FIX 2026-08-03 Bug2】原版本一次性调 snapshot，pctMap 为空也照样 ok:true。
  // 但实际遇到过 snapshot 接口在 16:00 整点恰好返回空（限流/收盘数据未结算/接口抖动），
  // 手动重试第二次才能拿到数据。改成：覆盖率 < 50% 时延迟 60 秒重试一次，
  // 再不行 120 秒再试一次（cron 走 scheduled + ctx.waitUntil，不受 HTTP 超时影响）。
  const codes = watchlist.map(w => w.code).filter(Boolean);
  const COVERAGE_THRESHOLD = 0.5; // 低于 50% 视为失败，触发重试
  const RETRY_DELAYS_SEC = [60, 120];

  let snapshotResult = await fetchSnapshotChangePct(env, codes);
  let pctMap = snapshotResult.pctMap;
  let stats = snapshotResult.stats;
  let coverage = codes.length > 0 ? stats.success / codes.length : 0;
  logs.push('步骤2：调用 fuyao snapshot 获取收盘涨幅...');
  logs.push('snapshot 第1次: success=' + stats.success + '/' + codes.length + ' (覆盖率 ' + (coverage * 100).toFixed(1) + '%)'
    + ' batchOk=' + stats.batchOk + ' batchFail=' + stats.batchFail
    + ' singleOk=' + stats.singleOk + ' singleFail=' + stats.singleFail
    + ' itemsReturned=' + stats.itemsReturned
    + ' emptyField=' + stats.emptyField + ' notMatched=' + stats.notMatched);

  // 覆盖率不足重试
  for (let attempt = 0; attempt < RETRY_DELAYS_SEC.length && coverage < COVERAGE_THRESHOLD; attempt++) {
    const waitSec = RETRY_DELAYS_SEC[attempt];
    logs.push('⏳ snapshot 覆盖率 ' + (coverage * 100).toFixed(1) + '% 低于阈值 ' + (COVERAGE_THRESHOLD * 100) + '%，'
      + waitSec + '秒后重试第' + (attempt + 1) + '次...');
    await new Promise(r => setTimeout(r, waitSec * 1000));
    try {
      const retryResult = await fetchSnapshotChangePct(env, codes);
      const retryCoverage = codes.length > 0 ? retryResult.stats.success / codes.length : 0;
      logs.push('snapshot 第' + (attempt + 2) + '次: success=' + retryResult.stats.success + '/' + codes.length
        + ' (覆盖率 ' + (retryCoverage * 100).toFixed(1) + '%)'
        + ' batchOk=' + retryResult.stats.batchOk + ' batchFail=' + retryResult.stats.batchFail
        + ' singleOk=' + retryResult.stats.singleOk + ' singleFail=' + retryResult.stats.singleFail
        + ' itemsReturned=' + retryResult.stats.itemsReturned
        + ' emptyField=' + retryResult.stats.emptyField + ' notMatched=' + retryResult.stats.notMatched);
      if (retryResult.stats.success > stats.success) {
        // 重试结果更好，采用重试结果
        pctMap = retryResult.pctMap;
        stats = retryResult.stats;
        coverage = retryCoverage;
        logs.push('✅ 重试第' + (attempt + 1) + '次结果更好，采用重试结果 (success=' + stats.success + ')');
      } else {
        logs.push('第' + (attempt + 1) + '次重试结果未改善 (success=' + retryResult.stats.success + ')');
      }
    } catch (e) {
      logs.push('第' + (attempt + 1) + '次重试请求失败: ' + e.message);
    }
  }

  // 覆盖率仍为 0，明确失败
  if (stats.success === 0) {
    logs.push('❌ snapshot 接口未返回任何涨幅（可能接口故障/限流/收盘数据未结算），本次未覆盖任何涨幅');
    return {
      ok: false,
      today,
      error: 'snapshot 接口未返回任何涨幅数据',
      stocksCount: watchlist.length,
      snapshotStats: stats,
      logs
    };
  }

  // 覆盖率低但非 0，记录告警但继续写入（部分覆盖好过完全不覆盖）
  if (coverage < COVERAGE_THRESHOLD) {
    logs.push('⚠️ snapshot 覆盖率仅 ' + (coverage * 100).toFixed(1) + '%，部分股票涨幅未覆盖（可能停牌/接口部分失败），仍写入已获取的 ' + stats.success + ' 只');
  } else {
    logs.push('snapshot 覆盖率 ' + (coverage * 100).toFixed(1) + '%，正常');
  }

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

  // 【FIX 2026-08-03】数据完整性汇总，对齐 runMorning 的格式
  const summaryParts = [];
  if (coverage < COVERAGE_THRESHOLD) summaryParts.push('⚠️ snapshot 覆盖率低 ' + (coverage * 100).toFixed(1) + '%');
  const uncoveredCount = watchlist.length - metricsRows.length;
  if (uncoveredCount > 0) summaryParts.push('未覆盖 ' + uncoveredCount + ' 只（可能停牌/接口未返回）');
  const completenessSummary = summaryParts.length > 0 ? summaryParts.join('；') : '✅ 涨幅覆盖完整 ' + metricsRows.length + '/' + watchlist.length;
  logs.push('数据完整性汇总: ' + completenessSummary);

  logs.push('完成: 收盘涨幅覆盖 ' + metricsRows.length + ' 只');
  return {
    ok: true,
    today,
    stocksCount: watchlist.length,
    pctUpdated: metricsRows.length,
    coverage: coverage,
    snapshotStats: stats,
    completenessSummary: completenessSummary,
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
    // 【FIX 2026-08-04】之前只在报错(catch)时打一行 e.message，正常跑完(哪怕数据不全，
    // 只要没 throw)整份详细 logs 数组直接被丢弃，Cloudflare Workers Logs 里查不到任何过程。
    // 改成：不管成功/失败，都把完整 logs 数组 console.log 出来，方便事后在 Workers Logs
    // 里按 cron 类型的 invocation 翻到今天这次到底发生了什么（预期交易日/缺失交易日/重试情况等）。
    if (point === 'morning') {
      ctx.waitUntil(
        runMorning(env)
          .then(result => {
            console.log('[auto-fetch] runMorning 完成 ok=' + result.ok + ' completenessSummary=' + (result.completenessSummary || ''));
            console.log('[auto-fetch] runMorning 完整日志:', JSON.stringify(result.logs || []));
          })
          .catch(e => console.error('[auto-fetch] morning error:', e.message))
      );
    } else if (point === 'close') {
      ctx.waitUntil(
        runClose(env)
          .then(result => {
            console.log('[auto-fetch] runClose 完成 ok=' + result.ok);
            console.log('[auto-fetch] runClose 完整日志:', JSON.stringify(result.logs || []));
          })
          .catch(e => console.error('[auto-fetch] close error:', e.message))
      );
    }
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return jsonResponse({ ok: true, service: 'bidding-auto-fetch' });
    }

    // 注：runMorning 内新增的"今天缺失重试"最多会等 20+40=60 秒才返回。
    // cron 触发走 scheduled() + ctx.waitUntil()，不受此影响；
    // 但手动访问 /fetch?point=morning 是直接 await 的 HTTP 请求，
    // 如果触发了重试，浏览器/请求方需要能等待 60 秒以上不超时。
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
