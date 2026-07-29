/**
 * 竞价变化 + 记忘看板 + 情绪看板 · 合并定时抓取 Worker
 *
 * 共 5 个 cron（Cloudflare Free 账号上限 5 个）：
 *   1. 9:15  (UTC 01:15) → 抓竞价变化 5 行，写入 time915
 *   2. 9:20  (UTC 01:20) → 抓竞价变化 5 行，写入 time920
 *   3. 9:25  (UTC 01:25) → 抓竞价变化 5 行 + 猫爪封单家数，写入 time930
 *   4. 9:26  (UTC 01:26) → 二次抓取「最近多板%」+ 情绪看板（早盘参考）
 *   5. 16:00 (UTC 08:00) → 抓记忘看板昨收盘涨跌家数 + 竞价收盘
 *
 * 手动触发：GET /fetch?token=<FETCH_TOKEN>&point=t0915|t0920|t0925|t0926|close|jiwang|auto
 *
 * ⚠️ 行名是 upsert 冲突键的一部分（date,name），ROW_NAMES 必须与看板上的行名
 *   【一字不差】，否则会插入重复行而不是更新。
 */

// ══════════════════════════ 配置区 ══════════════════════════
const CONFIG = {
  FUYAO_BASE: 'https://fuyao.aicubes.cn',
  SUPABASE_URL: 'https://tonqfgeyxnnwicjopshn.supabase.co',

  // 竞价变化看板行名
  ROW_LADDER: '最近多板%',
  ROW_SECTOR_ETF: '板块ETF(48)',
  ROW_TOP10: '昨日资金前十',
  ROW_BIG_ETF: '大盘ETF',
  ROW_MAIN_INDEX: '大盘（%）',
  ROW_SEAL: '封单家数',

  LADDER_INDEX: '883410.TI',
  TOP10_INDEX: '883901.TI',
  MAIN_INDEX: '000001.SH',
  BIG_ETFS: ['510500.SH', '512100.SH', '510300.SH', '510050.SH'],

  SECTOR_ETFS: [
    { code: '560780.SH', name: '半导体设备ETF', type: 'stock' },
    { code: '159995.SZ', name: '芯片ETF华夏', type: 'stock' },
    { code: '512480.SH', name: '半导体ETF国', type: 'stock' },
    { code: '159732.SZ', name: '消费电子ETF', type: 'stock' },
    { code: '515880.SH', name: '通信ETF国泰', type: 'stock' },
    { code: '560800.SH', name: '数字经济ETF', type: 'stock' },
    { code: '159819.SZ', name: '人工智能ETF', type: 'stock' },
    { code: '159206.SZ', name: '卫星ETF永赢', type: 'stock' },
    { code: '515750.SH', name: '科技50ETF', type: 'stock' },
    { code: '159608.SZ', name: '稀有金属ETF', type: 'stock' },
    { code: '159998.SZ', name: '计算机ETF天弘', type: 'stock' },
    { code: '561160.SH', name: '电池ETF富国', type: 'stock' },
    { code: '159857.SZ', name: '光伏ETF天弘', type: 'stock' },
    { code: '516780.SH', name: '稀土ETF华泰', type: 'stock' },
    { code: '562500.SH', name: '机器人ETF华夏', type: 'stock' },
    { code: '515400.SH', name: '大数据ETF富国', type: 'stock' },
    { code: '560860.SH', name: '工业有色ETF', type: 'stock' },
    { code: '516510.SH', name: '云计算ETF易', type: 'stock' },
    { code: '516390.SH', name: '新能源车ETF', type: 'stock' },
    { code: '563010.SH', name: '电信ETF易方达', type: 'stock' },
    { code: '159875.SZ', name: '新能源ETF嘉实', type: 'stock' },
    { code: '516100.SH', name: '金融科技ETF', type: 'stock' },
    { code: '886078.TI', name: '商业航天', type: 'index' },
    { code: '512660.SH', name: '军工ETF国泰', type: 'stock' },
    { code: '560280.SH', name: '工程机械ETF', type: 'stock' },
    { code: '515230.SH', name: '软件ETF国泰', type: 'stock' },
    { code: '159996.SZ', name: '家电ETF国泰', type: 'stock' },
    { code: '885939.TI', name: '海峡两岸', type: 'index' },
    { code: '159227.SZ', name: '航空航天ETF', type: 'stock' },
    { code: '518880.SH', name: '黄金ETF华安', type: 'stock' },
    { code: '000001.SH', name: '上证指数', type: 'index' },
    { code: '159869.SZ', name: '游戏ETF华夏', type: 'stock' },
    { code: '515150.SH', name: '一带一路ETF', type: 'stock' },
    { code: '516620.SH', name: '影视ETF国泰', type: 'stock' },
    { code: '515120.SH', name: '创新药ETF广发', type: 'stock' },
    { code: '516910.SH', name: '物流ETF富国', type: 'stock' },
    { code: '159842.SZ', name: '券商ETF银华', type: 'stock' },
    { code: '159666.SZ', name: '交通运输ETF', type: 'stock' },
    { code: '512200.SH', name: '房地产ETF南方', type: 'stock' },
    { code: '159766.SZ', name: '旅游ETF富国', type: 'stock' },
    { code: '562600.SH', name: '医疗器械ETF', type: 'stock' },
    { code: '159611.SH', name: '电力ETF广发', type: 'stock' },
    { code: '167301.SZ', name: '保险主题LOF', type: 'stock' },
    { code: '159825.SZ', name: '农业ETF富国', type: 'stock' },
    { code: '159309.SZ', name: '油气ETF汇添富', type: 'stock' },
    { code: '512690.SH', name: '酒ETF鹏华', type: 'stock' },
    { code: '515220.SH', name: '煤炭ETF国泰', type: 'stock' },
    { code: '159887.SZ', name: '银行ETF富国', type: 'stock' },
  ],

  // NumCat 情绪周期接口（封单家数来源 + 情绪看板数据来源）
  // 字段含义见：https://numcat.net/api-docs?scope=stock#tag/%E5%B8%82%E5%9C%BA%E7%BB%9F%E8%AE%A1/POST/api/reference-proxy/market/emoindic-daily
  NUMCAT_URL: 'https://numcat.net/api/reference-proxy/market/emoindic-daily',
  NUMCAT_APINAME: 'emoindic_daily',
  NUMCAT_RECENT_DAYS: 10, // 拉取最近 N 个交易日（情绪看板需要 5 日趋势，多取几天防止节假日断档）
  SEAL_FIELD: 'owfd_0925_count',

  // 情绪看板：字段映射（NumCat 情绪周期接口字段名 → 内部指标名）
  // 按顺序匹配第一个存在的字段；情绪指标统一取【昨日】数据，预测量能取【今日】am_pred。
  EMOTION_FIELDS: {
    amount:        ['am', 'amount', 's_amount', 'total_amount', 's7', 's_amt'],           // 成交额（元）
    predictVol:    ['am_pred', 'am_prednumber', 'predict_vol', 'predict_volume', 's_pv'], // 预测量能（元）
    amountDiff:    ['am_diff', 'amount_diff'],                                             // 成交额环比差值（元）
    limitUp:       ['u5', 'limit_up', 'zhangting', 'zt_count', 's1', 's4'],                // 涨停家数
    limitDown:     ['d3', 'limit_down', 'dieting', 'dt_count', 's5'],                      // 跌停家数
    onceLimit:     ['u6', 'once_limit', 'yiziban', 'yzb_count', 's9'],                     // 一字板家数
    highestLb:     ['l17', 'highest_lb', 'max_lb', 'highest_limit', 's10'],                // 最高连板天数
    zhaban:        ['u12', 'zhaban', 'bomb', 'zhb_count', 's11'],                          // 炸板家数
    zhabanRate:    ['fp108', 'zhaban_rate', 'bomb_rate', 'zhb_rate', 's12'],               // 炸板率（%）
  },

  // 记忘看板配置
  JIWANG_TABLE: 'jiwang_data',
  EMOTION_TABLE: 'emotion_data',
};

const CRON_TO_POINT = {
  '15 1 * * 1-5': 't0915',
  '20 1 * * 1-5': 't0920',
  '25 1 * * 1-5': 't0925',
  '26 1 * * 1-5': 't0926',
  '0 8 * * 1-5': 'close',
};
const POINT_TO_COLUMN = { t0915: 'time915', t0920: 'time920', t0925: 'time930', t0926: 'time930', close: 'close' };

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

function sbHeaders(env) {
  return {
    'apikey': env.SUPABASE_ANON_KEY,
    'Authorization': 'Bearer ' + env.SUPABASE_ANON_KEY,
    'Content-Type': 'application/json',
  };
}

async function fuyaoGet(env, path, params) {
  const url = new URL(CONFIG.FUYAO_BASE + path);
  for (const k in params) {
    if (params[k] !== undefined && params[k] !== null) url.searchParams.set(k, params[k]);
  }
  const resp = await fetch(url.toString(), { headers: { 'X-api-key': env.FUYAO_API_KEY } });
  const data = await resp.json();
  if (data.code !== 0) throw new Error('fuyao ' + path + ' 错误: code=' + data.code + ' ' + (data.message || ''));
  return data.data;
}

async function isTradingDay(env) {
  try {
    const data = await fuyaoGet(env, '/api/a-share/calendar/trading-days', {});
    const items = (data && data.item) || [];
    const today = beijingTodayCompact();
    return items.some(function (it) { return String(it.date) === today; });
  } catch (e) {
    console.error('交易日历校验失败，保守按非交易日处理:', e.message);
    return false;
  }
}

// ══════════════════════════ NumCat 情绪周期接口（通用）══════════════════════════
// 一次性拉取完整数据，供 s2/s6（记忘看板）、owfd_0925_count（封单家数）、情绪看板共用，节省额度。

async function fetchNumCatEmotionFull(env) {
  const resp = await fetch(CONFIG.NUMCAT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apiname: CONFIG.NUMCAT_APINAME,
      apikey: env.NUMCAT_API_KEY,
      params: { recentdays: CONFIG.NUMCAT_RECENT_DAYS }
    })
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error('NumCat API HTTP ' + resp.status + ': ' + text.slice(0, 200));
  }
  const json = await resp.json();
  if (json.code !== 200) throw new Error('NumCat API 错误: ' + (json.message || JSON.stringify(json)));
  const fields = json.data.fields;
  const items = json.data.items;
  if (!Array.isArray(fields) || !Array.isArray(items) || items.length === 0) {
    throw new Error('NumCat API 返回数据格式异常');
  }
  return { fields, items };
}

async function numcatEmoindic(env) {
  const { fields, items } = await fetchNumCatEmotionFull(env);
  let latest = findTodayItem(fields, items);
  const sealIdx = fields.indexOf(CONFIG.SEAL_FIELD);
  if (sealIdx < 0) {
    throw new Error('NumCat 情绪周期接口缺少字段 "' + CONFIG.SEAL_FIELD + '"，可用字段: ' + fields.join(', '));
  }
  return { sealCount: Number(latest[sealIdx]), availableFields: fields };
}

// 从 fields + items 中按候选字段名提取指标值（返回第一个匹配到的字段值）
function pickEmotionValue(fields, item, candidates) {
  for (const name of candidates) {
    const idx = fields.indexOf(name);
    if (idx >= 0) {
      const v = item[idx];
      if (v !== null && v !== undefined && v !== '') return Number(v);
    }
  }
  return null;
}

// 定位日期字段名
function findDateField(fields) {
  return ['tradedate', 'trade_date', 'trading_day', 'date'].find(name => fields.indexOf(name) >= 0);
}

// 把接口返回的 items 按日期升序排列（NumCat 可能降序返回，统一处理）
function sortItemsByDate(fields, items) {
  const dateField = findDateField(fields);
  if (!dateField) return items.slice();
  const idx = fields.indexOf(dateField);
  return items.slice().sort(function (a, b) {
    const da = String(a[idx] || '').replace(/-/g, '');
    const db = String(b[idx] || '').replace(/-/g, '');
    return Number(da) - Number(db);
  });
}

// 取接口返回中最晚日期那一行的索引（已升序排列后即为最后一行）
function findLatestItemIndex(fields, items) {
  const sorted = sortItemsByDate(fields, items);
  return { sorted, index: sorted.length - 1 };
}

// ══════════════════════════ 竞价变化计算 ══════════════════════════

async function getConstituentThscodes(env, indexThscode) {
  const data = await fuyaoGet(env, '/api/a-share-index/constituents/ths-stock-list', { thscode: indexThscode });
  return ((data && data.item) || []).map(function (it) { return it.thscode; }).filter(Boolean);
}

async function getStockSnapshotPcts(env, thscodes) {
  const result = {};
  for (let i = 0; i < thscodes.length; i += 40) {
    const chunk = thscodes.slice(i, i + 40);
    const data = await fuyaoGet(env, '/api/a-share/prices/snapshot', { thscodes: chunk.join(',') });
    ((data && data.item) || []).forEach(function (it) {
      if (it && it.thscode !== undefined && it.price_change_ratio_pct !== null && it.price_change_ratio_pct !== undefined) {
        result[it.thscode] = Number(it.price_change_ratio_pct);
      }
    });
  }
  return result;
}

async function getIndexSnapshotPcts(env, thscodes) {
  const result = {};
  const data = await fuyaoGet(env, '/api/a-share-index/prices/snapshot', { thscodes: thscodes.join(',') });
  ((data && data.item) || []).forEach(function (it) {
    if (it && it.thscode !== undefined && it.price_change_ratio_pct !== null && it.price_change_ratio_pct !== undefined) {
      result[it.thscode] = Number(it.price_change_ratio_pct);
    }
  });
  return result;
}

async function _tencentFetchOnce(thscodes) {
  const tqCodes = thscodes.map(function (c) {
    const num = c.split('.')[0];
    return (c.slice(-2) === 'SZ' ? 'sz' : 'sh') + num;
  });
  const resp = await fetch('https://qt.gtimg.cn/q=' + tqCodes.join(','));
  const text = await resp.text();
  const result = {};
  const re = /v_([a-z]{2}\d{6})="([^"]*)"/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const fields = m[2].split('~');
    const pct = parseFloat(fields[32]);
    if (!isNaN(pct)) {
      const num = m[1].slice(2);
      result[num + (m[1].slice(0, 2) === 'sz' ? '.SZ' : '.SH')] = pct;
    }
  }
  return result;
}

async function getTencentSnapshotPcts(thscodes) {
  const result = await _tencentFetchOnce(thscodes);
  const missing = thscodes.filter(function (c) { return result[c] === undefined; });
  if (missing.length > 0) {
    try {
      const retry = await _tencentFetchOnce(missing);
      Object.assign(result, retry);
    } catch (e) {
      console.warn('腾讯行情缺失补单失败（保留原结果）:', e.message);
    }
  }
  return result;
}

function avgOf(numbers) {
  if (!numbers.length) return null;
  return numbers.reduce(function (a, b) { return a + b; }, 0) / numbers.length;
}
function fmtPct(n) {
  return (Math.round(n * 100) / 100).toFixed(2);
}

async function computeBiddingRows(env, point) {
  const rows = {};

  try {
    const codes = await getConstituentThscodes(env, CONFIG.LADDER_INDEX);
    if (codes.length === 0) rows[CONFIG.ROW_LADDER] = { value: null, error: '883410 成分股为空' };
    else {
      const pcts = await getStockSnapshotPcts(env, codes);
      const vals = codes.map(c => pcts[c]).filter(v => typeof v === 'number' && !isNaN(v));
      const avg = avgOf(vals);
      rows[CONFIG.ROW_LADDER] = avg === null
        ? { value: null, error: '成分股快照全部缺失(' + codes.length + '只)' }
        : { value: fmtPct(avg), missing: codes.length - vals.length > 0 ? [String(codes.length - vals.length) + '只无快照'] : undefined };
    }
  } catch (e) { rows[CONFIG.ROW_LADDER] = { value: null, error: e.message }; }

  try {
    const stockCodes = CONFIG.SECTOR_ETFS.filter(e => e.type === 'stock').map(e => e.code);
    const indexCodes = CONFIG.SECTOR_ETFS.filter(e => e.type === 'index').map(e => e.code);
    const stockPcts = await getTencentSnapshotPcts(stockCodes);
    const indexPcts = await getIndexSnapshotPcts(env, indexCodes);
    let red = 0;
    const missing = [];
    CONFIG.SECTOR_ETFS.forEach(e => {
      const pct = e.type === 'stock' ? stockPcts[e.code] : indexPcts[e.code];
      if (typeof pct === 'number' && !isNaN(pct)) { if (pct > 0) red++; }
      else missing.push(e.name);
    });
    rows[CONFIG.ROW_SECTOR_ETF] = { value: String(red), missing: missing.length ? missing : undefined };
  } catch (e) { rows[CONFIG.ROW_SECTOR_ETF] = { value: null, error: e.message }; }

  try {
    const codes = await getConstituentThscodes(env, CONFIG.TOP10_INDEX);
    if (codes.length === 0) rows[CONFIG.ROW_TOP10] = { value: null, error: '883901 成分股为空' };
    else {
      const pcts = await getStockSnapshotPcts(env, codes);
      let red = 0, have = 0;
      codes.forEach(c => { const v = pcts[c]; if (typeof v === 'number' && !isNaN(v)) { have++; if (v > 0) red++; } });
      rows[CONFIG.ROW_TOP10] = have === 0
        ? { value: null, error: '883901 成分股快照全部缺失(' + codes.length + '只)' }
        : { value: String(red), missing: codes.length - have > 0 ? [String(codes.length - have) + '只无快照'] : undefined };
    }
  } catch (e) { rows[CONFIG.ROW_TOP10] = { value: null, error: e.message }; }

  try {
    const pcts = await getTencentSnapshotPcts(CONFIG.BIG_ETFS);
    const vals = CONFIG.BIG_ETFS.map(c => pcts[c]).filter(v => typeof v === 'number' && !isNaN(v));
    const avg = avgOf(vals);
    rows[CONFIG.ROW_BIG_ETF] = avg === null
      ? { value: null, error: '大盘ETF快照全部缺失' }
      : { value: fmtPct(avg), missing: CONFIG.BIG_ETFS.length - vals.length > 0 ? [String(CONFIG.BIG_ETFS.length - vals.length) + '只无快照'] : undefined };
  } catch (e) { rows[CONFIG.ROW_BIG_ETF] = { value: null, error: e.message }; }

  try {
    const pcts = await getIndexSnapshotPcts(env, [CONFIG.MAIN_INDEX]);
    const v = pcts[CONFIG.MAIN_INDEX];
    rows[CONFIG.ROW_MAIN_INDEX] = (typeof v === 'number' && !isNaN(v)) ? { value: fmtPct(v) } : { value: null, error: '上证指数快照缺失' };
  } catch (e) { rows[CONFIG.ROW_MAIN_INDEX] = { value: null, error: e.message }; }

  if (point === 't0925') {
    try {
      const numcat = await numcatEmoindic(env);
      const seal = numcat.sealCount;
      if (isNaN(seal)) rows[CONFIG.ROW_SEAL] = { value: null, error: 'NumCat 封单家数字段 "' + CONFIG.SEAL_FIELD + '" 不是数字，可用字段: ' + numcat.availableFields.join(', ') };
      else rows[CONFIG.ROW_SEAL] = { value: String(Math.round(seal)) };
    } catch (e) { rows[CONFIG.ROW_SEAL] = { value: null, error: e.message }; }
  }

  return rows;
}

// ══════════════════════════ Supabase 读写 ══════════════════════════

async function readTodayBiddingRows(env, date) {
  const url = CONFIG.SUPABASE_URL + '/rest/v1/bidding_data?date=eq.' + encodeURIComponent(date) +
    '&select=name,time915,time920,time930,close,time930_initial,time930_initial_modifiedAt,time930_modifiedAt';
  const resp = await fetch(url, { headers: sbHeaders(env) });
  if (!resp.ok) throw new Error('读取 bidding_data 失败: HTTP ' + resp.status);
  return await resp.json();
}

async function upsertBiddingRows(env, rows) {
  const url = CONFIG.SUPABASE_URL + '/rest/v1/bidding_data?on_conflict=date%2Cname';
  const resp = await fetch(url, {
    method: 'POST',
    headers: Object.assign(sbHeaders(env), { 'Prefer': 'resolution=merge-duplicates' }),
    body: JSON.stringify(rows),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error('upsert bidding_data 失败: HTTP ' + resp.status + ' ' + text.slice(0, 300));
  }
}

async function writeLog(env, entry) {
  try {
    await fetch(CONFIG.SUPABASE_URL + '/rest/v1/bidding_fetch_log', {
      method: 'POST',
      headers: Object.assign(sbHeaders(env), { 'Prefer': 'return=minimal' }),
      body: JSON.stringify(entry),
    });
  } catch (e) { console.error('写 bidding_fetch_log 失败（已忽略）:', e.message); }
}

// ══════════════════════════ 记忘看板逻辑 ══════════════════════════

function findTodayItem(fields, items) {
  const sorted = sortItemsByDate(fields, items);
  return sorted[sorted.length - 1];
}

function buildJiwangStats(fields, items) {
  const latest = findTodayItem(fields, items);
  const upIdx = fields.indexOf('s2');
  const downIdx = fields.indexOf('s6');
  if (upIdx < 0 || downIdx < 0) throw new Error('NumCat API 响应缺少 s2/s6 字段，可用字段: ' + fields.join(', '));
  return { up: Number(latest[upIdx]), down: Number(latest[downIdx]) };
}

async function fetchNumCatMarketStats(env) {
  const { fields, items } = await fetchNumCatEmotionFull(env);
  return buildJiwangStats(fields, items);
}

async function getNextTradingDay(env, today) {
  try {
    const data = await fuyaoGet(env, '/api/a-share/calendar/trading-days', {});
    const items = (data && data.item) || [];
    const dates = items.map(it => normalizeDate(it.date)).filter(Boolean).sort();
    for (const d of dates) if (d > today) return d;
    console.warn('fuyao calendar 未找到下一交易日，回退到本地计算');
  } catch (e) {
    console.warn('fuyao calendar 错误，回退到本地计算:', e.message);
  }
  return localGetNextTradingDay(today);
}

function localGetNextTradingDay(dateStr) {
  const KNOWN_HOLIDAYS = new Set([
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
    if (dayOfWeek !== 0 && dayOfWeek !== 6 && !KNOWN_HOLIDAYS.has(s)) return s;
    d.setDate(d.getDate() + 1);
  }
}

async function updateJiwangShouguJieguo(env, date, stats) {
  const shouguJieguo = stats.down + ':' + stats.up;
  const url = CONFIG.SUPABASE_URL + '/rest/v1/' + CONFIG.JIWANG_TABLE;
  const body = { date: date, shouguJieguo: shouguJieguo, updated_at: new Date().toISOString() };
  const resp = await fetch(url, {
    method: 'POST',
    headers: Object.assign(sbHeaders(env), {
      'Prefer': 'resolution=merge-duplicates, return=minimal'
    }),
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error('Supabase upsert 失败: HTTP ' + resp.status + ': ' + text.slice(0, 300));
  }
}

// ══════════════════════════ 情绪看板逻辑 ══════════════════════════

async function runEmotion(env, source, sharedFull) {
  const date = beijingToday();
  const logBase = { run_date: date, time_point: 't0926', source: source || 'cron', job: 'emotion' };

  if (!(await isTradingDay(env))) {
    await writeLog(env, Object.assign(logBase, { ok: false, detail: { skipped: '非交易日' } }));
    return { ok: false, error: '非交易日，已跳过' };
  }

  let full;
  try {
    full = sharedFull || await fetchNumCatEmotionFull(env);
  } catch (e) {
    await writeLog(env, Object.assign(logBase, { ok: false, detail: { error: e.message } }));
    return { ok: false, error: e.message };
  }

  const fields = full.fields;
  const dateField = findDateField(fields);

  // 接口返回可能按日期降序，先统一升序排列
  const items = sortItemsByDate(fields, full.items);

  // 定位今日行与昨日行：情绪指标取昨日收盘数据，预测量能取今日实时快照
  // 以接口返回的最晚日期作为「今日」行（若市场未开盘，则可能是昨日收盘价快照）
  const todayIdx = items.length - 1;
  const yesterdayIdx = todayIdx > 0 ? todayIdx - 1 : todayIdx;
  const todayItem = items[todayIdx];
  const yesterdayItem = items[yesterdayIdx];

  // 提取指标：predictVol 取今日，其余取昨日
  const metrics = {};
  const missingFields = [];
  for (const key of Object.keys(CONFIG.EMOTION_FIELDS)) {
    const item = key === 'predictVol' ? todayItem : yesterdayItem;
    const val = pickEmotionValue(fields, item, CONFIG.EMOTION_FIELDS[key]);
    metrics[key] = val;
    if (val === null) missingFields.push(key + '(' + CONFIG.EMOTION_FIELDS[key].join('/') + ')');
  }

  // 昨日成交额环比差值（亿）：优先用昨日行的 am_diff，否则用昨日-前日计算
  let amountDiff = null;
  const rawAmDiff = pickEmotionValue(fields, yesterdayItem, CONFIG.EMOTION_FIELDS.amountDiff);
  if (rawAmDiff !== null) {
    amountDiff = rawAmDiff / 1e8;
  } else if (yesterdayIdx > 0) {
    const prevItem = items[yesterdayIdx - 1];
    const yestAmount = pickEmotionValue(fields, yesterdayItem, CONFIG.EMOTION_FIELDS.amount);
    const prevAmount = pickEmotionValue(fields, prevItem, CONFIG.EMOTION_FIELDS.amount);
    if (yestAmount !== null && prevAmount !== null) {
      amountDiff = (yestAmount - prevAmount) / 1e8;
    }
  }
  metrics.amountDiff = amountDiff !== null ? Number(amountDiff.toFixed(2)) : null;

  // 组装五日数据：以昨日为终点，向前取最多 5 个交易日（不包含今日）
  const fiveDays = items.slice(Math.max(0, yesterdayIdx - 4), yesterdayIdx + 1).map(function (item) {
    const row = {};
    for (const key of Object.keys(CONFIG.EMOTION_FIELDS)) {
      row[key] = pickEmotionValue(fields, item, CONFIG.EMOTION_FIELDS[key]);
    }
    if (dateField) {
      const dIdx = fields.indexOf(dateField);
      row._date = normalizeDate(item[dIdx]);
    } else {
      row._date = '';
    }
    return row;
  });

  // 写入 emotion_data 表
  const url = CONFIG.SUPABASE_URL + '/rest/v1/' + CONFIG.EMOTION_TABLE;
  const body = {
    date: date,
    metrics: metrics,
    five_days: fiveDays,
    api_fields: fields,
    updated_at: new Date().toISOString()
  };

  let writeError = null;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: Object.assign(sbHeaders(env), {
        'Prefer': 'resolution=merge-duplicates, return=minimal'
      }),
      body: JSON.stringify(body)
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error('HTTP ' + resp.status + ': ' + text.slice(0, 300));
    }
  } catch (e) {
    writeError = e.message;
  }

  await writeLog(env, Object.assign(logBase, {
    ok: !writeError,
    detail: {
      todayIdx,
      yesterdayIdx,
      metrics,
      amountDiff,
      missingFields,
      availableFields: fields,
      fiveDaysCount: fiveDays.length,
      writeError
    }
  }));

  return {
    ok: !writeError,
    date,
    metrics,
    amountDiff,
    missingFields,
    availableFields: fields,
    todayDate: todayItem && dateField ? normalizeDate(todayItem[fields.indexOf(dateField)]) : '',
    yesterdayDate: yesterdayItem && dateField ? normalizeDate(yesterdayItem[fields.indexOf(dateField)]) : '',
    fiveDaysCount: fiveDays.length,
    fiveDaysPreview: fiveDays.map(function (d) { return { date: d._date, limitUp: d.limitUp }; }),
    writeError
  };
}

// 独立刷新情绪看板的「预测量能」字段：只调 NumCat 一次，只更新 metrics.predictVol。
async function refreshEmotionPredictVol(env, source) {
  const date = beijingToday();
  const logBase = { run_date: date, time_point: 't0926', source: source || 'http', job: 'emotion-refresh' };

  let full;
  try {
    full = await fetchNumCatEmotionFull(env);
  } catch (e) {
    await writeLog(env, Object.assign(logBase, { ok: false, detail: { error: e.message } }));
    return { ok: false, error: e.message };
  }

  const fields = full.fields;
  const items = sortItemsByDate(fields, full.items);

  // 定位今日行：以接口返回的最晚日期那一行为准
  const todayIdx = items.length - 1;

  const predictVol = pickEmotionValue(fields, items[todayIdx], CONFIG.EMOTION_FIELDS.predictVol);
  if (predictVol === null) {
    await writeLog(env, Object.assign(logBase, { ok: false, detail: { error: '未找到 am_pred 字段' } }));
    return { ok: false, error: 'NumCat 返回中未找到 am_pred 预测量能字段' };
  }

  // 读取当天已有记录，只更新 predictVol
  const readUrl = CONFIG.SUPABASE_URL + '/rest/v1/' + CONFIG.EMOTION_TABLE + '?date=eq.' + encodeURIComponent(date) + '&select=metrics';
  let metrics = {};
  try {
    const readResp = await fetch(readUrl, { headers: sbHeaders(env) });
    if (readResp.ok) {
      const rows = await readResp.json();
      if (rows && rows[0] && rows[0].metrics) metrics = rows[0].metrics;
    }
  } catch (e) {
    console.warn('读取 emotion_data 失败:', e.message);
  }
  metrics.predictVol = predictVol;

  const updateUrl = CONFIG.SUPABASE_URL + '/rest/v1/' + CONFIG.EMOTION_TABLE + '?date=eq.' + encodeURIComponent(date);
  let writeError = null;
  try {
    const resp = await fetch(updateUrl, {
      method: 'POST',
      headers: Object.assign(sbHeaders(env), {
        'Prefer': 'resolution=merge-duplicates, return=minimal'
      }),
      body: JSON.stringify({ date: date, metrics: metrics, updated_at: new Date().toISOString() })
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error('HTTP ' + resp.status + ': ' + text.slice(0, 300));
    }
  } catch (e) {
    writeError = e.message;
  }

  await writeLog(env, Object.assign(logBase, {
    ok: !writeError,
    detail: { todayIdx, predictVol, predictYi: predictVol / 1e8, writeError }
  }));

  return {
    ok: !writeError,
    date,
    predictVol,
    predictYi: predictVol / 1e8,
    writeError
  };
}

// ══════════════════════════ 主流程 ══════════════════════════

async function runBidding(env, point, source) {
  const date = beijingToday();
  const column = POINT_TO_COLUMN[point];
  const logBase = { run_date: date, time_point: point, source: source || 'cron', job: 'bidding' };
  if (!column) return { ok: false, error: '未知 time_point: ' + point };

  if (!(await isTradingDay(env))) {
    await writeLog(env, Object.assign(logBase, { ok: false, detail: { skipped: '非交易日' } }));
    return { ok: false, error: '非交易日，已跳过' };
  }

  const computed = await computeBiddingRows(env, point);
  const failedRowNames = Object.keys(computed).filter(k => computed[k].value === null || computed[k].value === undefined);
  if (failedRowNames.length > 0) {
    console.log('本趟有 ' + failedRowNames.length + ' 行未抓到(' + failedRowNames.join(',') + ')，45 秒后重试...');
    await new Promise(r => setTimeout(r, 45000));
    try {
      const retry = await computeBiddingRows(env, point);
      failedRowNames.forEach(k => { if (retry[k] && retry[k].value !== null && retry[k].value !== undefined) computed[k] = retry[k]; });
    } catch (e) { console.warn('45 秒重试失败:', e.message); }
  }

  const now = new Date().toISOString();
  let existingByName = {};
  if (point === 't0925') {
    try { (await readTodayBiddingRows(env, date)).forEach(r => existingByName[(r.name || '').trim()] = r); }
    catch (e) { console.error('读今日行失败:', e.message); }
  }

  const upsertPayload = [];
  const rowResults = {};
  Object.keys(computed).forEach(rowName => {
    const r = computed[rowName];
    rowResults[rowName] = r;
    if (r.value === null || r.value === undefined) return;
    const row = { date: date, name: rowName, updated_at: now };
    row[column] = r.value;
    if (point === 't0925') {
      const prev = existingByName[rowName];
      const v920 = prev ? parseFloat(prev.time920) : NaN;
      const v925 = parseFloat(r.value);
      if (!isNaN(v920) && !isNaN(v925)) row.change = v925 > v920 ? '增' : (v925 < v920 ? '减' : '平');
    }
    upsertPayload.push(row);
  });

  let ok = true, writeError = null;
  if (upsertPayload.length > 0) {
    try { await upsertBiddingRows(env, upsertPayload); }
    catch (e) { ok = false; writeError = e.message; }
  }
  await writeLog(env, Object.assign(logBase, { ok, detail: { written: upsertPayload, rows: rowResults, writeError } }));
  return { ok, date, point, column, written: upsertPayload, rows: rowResults, writeError };
}

async function runDuobanSecond(env, source) {
  const date = beijingToday();
  const logBase = { run_date: date, time_point: 't0926', source: source || 'cron', job: 'duoban-second' };

  if (!(await isTradingDay(env))) {
    await writeLog(env, Object.assign(logBase, { ok: false, detail: { skipped: '非交易日' } }));
    return { ok: false, error: '非交易日，已跳过' };
  }

  let duobanResult;
  try {
    const codes = await getConstituentThscodes(env, CONFIG.LADDER_INDEX);
    if (codes.length === 0) throw new Error('883410 成分股为空');
    const pcts = await getStockSnapshotPcts(env, codes);
    const vals = codes.map(c => pcts[c]).filter(v => typeof v === 'number' && !isNaN(v));
    const avg = avgOf(vals);
    if (avg === null) throw new Error('成分股快照全部缺失');
    duobanResult = { value: fmtPct(avg), missing: codes.length - vals.length > 0 ? [String(codes.length - vals.length) + '只无快照'] : undefined };
  } catch (e) { duobanResult = { value: null, error: e.message }; }

  let existing = null;
  try {
    const rows = await readTodayBiddingRows(env, date);
    existing = rows.find(r => (r.name || '').trim() === CONFIG.ROW_LADDER) || null;
  } catch (e) { console.error('读今日行失败:', e.message); }

  const now = new Date().toISOString();
  const row = { date: date, name: CONFIG.ROW_LADDER, time930: duobanResult.value, updated_at: now };

  if (existing && existing.time930_initial !== undefined && existing.time930_initial !== null && String(existing.time930_initial).trim() !== '') {
    row.time930_initial = existing.time930_initial;
    row.time930_initial_modifiedAt = existing.time930_initial_modifiedAt || now;
    row.time930_modifiedAt = now;
  } else if (duobanResult.value !== null && duobanResult.value !== undefined) {
    row.time930_initial = duobanResult.value;
    row.time930_initial_modifiedAt = now;
  }

  if (existing && existing.time920 !== undefined && existing.time920 !== null && String(existing.time920).trim() !== '' && duobanResult.value !== null) {
    const v926 = parseFloat(duobanResult.value);
    const v920 = parseFloat(existing.time920);
    if (!isNaN(v926) && !isNaN(v920)) row.change = v926 > v920 ? '增' : (v926 < v920 ? '减' : '平');
  }

  let ok = true, writeError = null;
  if (duobanResult.value !== null && duobanResult.value !== undefined) {
    try { await upsertBiddingRows(env, [row]); }
    catch (e) { ok = false; writeError = e.message; }
  }
  await writeLog(env, Object.assign(logBase, { ok, detail: { written: duobanResult.value !== null ? [row] : [], row: duobanResult, writeError } }));
  return { ok, date, point: 't0926', written: duobanResult.value !== null ? [row] : [], row: duobanResult, writeError };
}

async function runDuobanAndEmotion(env, source) {
  const [duobanResult, emotionResult] = await Promise.allSettled([
    runDuobanSecond(env, source),
    runEmotion(env, source)
  ]);
  return {
    ok: (duobanResult.status === 'fulfilled' && duobanResult.value.ok) &&
        (emotionResult.status === 'fulfilled' && emotionResult.value.ok),
    duoban: duobanResult.status === 'fulfilled' ? duobanResult.value : { ok: false, error: duobanResult.reason?.message },
    emotion: emotionResult.status === 'fulfilled' ? emotionResult.value : { ok: false, error: emotionResult.reason?.message }
  };
}

async function runJiwang(env, source, sharedFull) {
  const date = beijingToday();
  const logBase = { run_date: date, time_point: 'close', source: source || 'cron', job: 'jiwang' };

  if (!(await isTradingDay(env))) {
    await writeLog(env, Object.assign(logBase, { ok: false, detail: { skipped: '非交易日' } }));
    return { ok: false, error: '非交易日，已跳过' };
  }

  try {
    const stats = sharedFull
      ? buildJiwangStats(sharedFull.fields, sharedFull.items)
      : await fetchNumCatMarketStats(env);
    const nextTradingDay = await getNextTradingDay(env, date);
    await updateJiwangShouguJieguo(env, nextTradingDay, stats);
    await writeLog(env, Object.assign(logBase, { ok: true, detail: { today: date, nextTradingDay, stats } }));
    return { ok: true, today: date, nextTradingDay, stats };
  } catch (e) {
    await writeLog(env, Object.assign(logBase, { ok: false, detail: { error: e.message } }));
    return { ok: false, error: e.message };
  }
}

async function runClose(env, source) {
  // 记忘看板依赖 NumCat 情绪周期接口；情绪看板已改到 9:26 抓取，此处不再调用。
  let sharedFull = null;
  let sharedFullError = null;
  try {
    sharedFull = await fetchNumCatEmotionFull(env);
  } catch (e) {
    sharedFullError = e.message;
  }

  // NumCat 接口失败时，记忘看板直接复用该错误，避免额外消耗调用额度。
  const jiwangPromise = sharedFull
    ? runJiwang(env, source, sharedFull)
    : Promise.resolve({ ok: false, error: 'NumCat 共享接口失败: ' + sharedFullError });

  const [jiwangResult, biddingResult] = await Promise.allSettled([
    jiwangPromise,
    runBidding(env, 'close', source)
  ]);

  return {
    ok: (jiwangResult.status === 'fulfilled' && jiwangResult.value.ok) &&
        (biddingResult.status === 'fulfilled' && biddingResult.value.ok),
    jiwang: jiwangResult.status === 'fulfilled' ? jiwangResult.value : { ok: false, error: jiwangResult.reason?.message },
    bidding: biddingResult.status === 'fulfilled' ? biddingResult.value : { ok: false, error: biddingResult.reason?.message },
    sharedFullError
  };
}

function autoPoint() {
  const d = beijingNow();
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (mins >= 9 * 60 + 10 && mins < 9 * 60 + 17) return 't0915';
  if (mins >= 9 * 60 + 17 && mins < 9 * 60 + 22) return 't0920';
  if (mins >= 9 * 60 + 22 && mins < 9 * 60 + 25) return 't0925';
  if (mins >= 9 * 60 + 25 && mins < 9 * 60 + 40) return 't0926';
  if (mins >= 15 * 60) return 'close';
  return null;
}

// 简易 IP 频率限制（按 Worker 进程内存，足够防止误刷/滥用）
const REFRESH_RATE_LIMIT = new Map();
function checkRefreshRateLimit(ip) {
  const now = Date.now();
  const windowMs = 60 * 1000; // 1 分钟窗口
  const maxRequests = 10;     // 每 IP 每分钟最多 10 次
  const record = REFRESH_RATE_LIMIT.get(ip);
  if (!record || now > record.resetAt) {
    REFRESH_RATE_LIMIT.set(ip, { count: 1, resetAt: now + windowMs });
    return { ok: true };
  }
  if (record.count >= maxRequests) {
    return { ok: false, retryAfter: Math.ceil((record.resetAt - now) / 1000) };
  }
  record.count++;
  return { ok: true };
}

// ══════════════════════════ 入口 ═══════════════════════════

export default {
  async scheduled(event, env, ctx) {
    const point = CRON_TO_POINT[event.cron];
    if (point === 't0926') ctx.waitUntil(runDuobanAndEmotion(env, 'cron'));
    else if (point === 'close') ctx.waitUntil(runClose(env, 'cron'));
    else ctx.waitUntil(runBidding(env, point, 'cron'));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true, service: 'market-automation-worker' }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/fetch') {
      const token = url.searchParams.get('token') || '';
      if (!env.FETCH_TOKEN || token !== env.FETCH_TOKEN) {
        return new Response(JSON.stringify({ ok: false, error: 'token 无效' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      }
      let point = url.searchParams.get('point') || 'auto';
      if (point === 'jiwang') point = 'close';
      if (point === 'auto') {
        point = autoPoint();
        if (!point) return new Response(JSON.stringify({ ok: false, error: '当前北京时间不在任何抓取时段' }), { headers: { 'Content-Type': 'application/json' } });
      }
      if (!POINT_TO_COLUMN[point] && point !== 'close') {
        return new Response(JSON.stringify({ ok: false, error: 'point 必须是 t0915|t0920|t0925|t0926|close|jiwang|auto' }), { headers: { 'Content-Type': 'application/json' } });
      }
      let result;
      if (point === 't0926') result = await runDuobanAndEmotion(env, 'http');
      else if (point === 'close') result = await runClose(env, 'http');
      else result = await runBidding(env, point, 'http');
      return new Response(JSON.stringify(result, null, 2), { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/refresh-emotion') {
      // 公开端点：只允许刷新预测量能；按 IP 限流防止额度被刷爆。
      const clientIp = request.headers.get('CF-Connecting-IP') || 'unknown';
      const limit = checkRefreshRateLimit(clientIp);
      if (!limit.ok) {
        return new Response(JSON.stringify({ ok: false, error: '刷新太频繁，请 ' + limit.retryAfter + ' 秒后再试' }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': String(limit.retryAfter) }
        });
      }
      const result = await refreshEmotionPredictVol(env, 'http');
      return new Response(JSON.stringify(result, null, 2), {
        status: result.ok ? 200 : 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response('market-automation-worker', { status: 200 });
  },
};
