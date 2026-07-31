/**
 * 竞价变化看板 · Worker A（同花顺/腾讯行情专用）
 *
 * 部署到 Cloudflare 账号 A，只读写同花顺/腾讯行情数据，完全不碰 NumCat。
 * 共 5 个 cron（注意 Cloudflare 星期编号：1=周日→7=周六，工作日用 2-6）：
 *   1. 9:15  (UTC 01:15, MON-FRI=2-6) → 抓竞价变化 5 行，写入 time915
 *   2. 9:20  (UTC 01:20, MON-FRI=2-6) → 抓竞价变化 5 行，写入 time920
 *   3. 9:25  (UTC 01:25, MON-FRI=2-6) → 抓竞价变化 5 行（不含封单），写入 time930
 *   4. 9:26  (UTC 01:26, MON-FRI=2-6) → 二次抓取「最近多板%」，写入 time930（保留初始值）
 *   5. 16:00 (UTC 08:00, MON-FRI=2-6) → 抓竞价收盘，写入 close
 *
 * 手动触发：GET /fetch?token=<FETCH_TOKEN>&point=t0915|t0920|t0925|t0926|close|auto
 *
 * ⚠️ 行名是 upsert 冲突键的一部分（date,name），ROW_NAMES 必须与看板上的行名
 *   【一字不差】，否则会插入重复行而不是更新。
 *
 * ⚠️ 历史坑：crons 里星期几用 1-5 在 Cloudflare 等于周日-周四，周五永远不触发！
 *    正确写法是 2-6（周一到周五）。
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
};

// ⚠️ Cloudflare 星期编号：1=周日, 2=周一, ..., 6=周五, 7=周六
// 周一到周五用 2-6，不是 1-5（1-5 = 周日到周四，周五会漏掉！）
// 双格式兼容：不管 Dashboard 上配的是 1-5（旧错版）还是 2-6（正确版），都能匹配到
const CRON_TO_POINT = {
  '15 1 * * 2-6': 't0915',
  '20 1 * * 2-6': 't0920',
  '25 1 * * 2-6': 't0925',
  '26 1 * * 2-6': 't0926',
  '0 8 * * 2-6': 'close',
  // 兼容旧的错误配置（1-5 = 周日-周四，周一到周四实际能触发，保留以平滑过渡）
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

function localIsTradingDay(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const dayOfWeek = d.getDay();
  if (dayOfWeek === 0 || dayOfWeek === 6) return false;
  return !KNOWN_HOLIDAYS.has(dateStr);
}

async function isTradingDay(env) {
  try {
    const data = await fuyaoGet(env, '/api/a-share/calendar/trading-days', {});
    const items = (data && data.item) || [];
    const today = beijingTodayCompact();
    return items.some(function (it) { return String(it.date) === today; });
  } catch (e) {
    console.warn('fuyao 交易日历失败，回退到本地日历:', e.message);
    return localIsTradingDay(beijingToday());
  }
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

// ══════════════════════════ 主流程 ══════════════════════════

async function runBidding(env, point, source) {
  const date = beijingToday();
  const column = POINT_TO_COLUMN[point];
  const logBase = { run_date: date, time_point: point, source: source || 'cron', job: 'bidding', worker: 'A' };
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
  const logBase = { run_date: date, time_point: 't0926', source: source || 'cron', job: 'duoban-second', worker: 'A' };

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

// ══════════════════════════ 入口 ═══════════════════════════

// 从 cron 表达式解析触发点：只看分钟+小时，不依赖星期几字段
// （Cloudflare 星期编号 1=周日→7=周六，容易写错；按时间匹配更可靠）
function cronToPoint(cronExpr) {
  // 先精确匹配（兼容旧配置）
  if (CRON_TO_POINT[cronExpr]) return CRON_TO_POINT[cronExpr];
  // 按 minute hour 提取匹配
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const min = parts[0], hour = parts[1];
  const key = min + ' ' + hour;
  const MIN_HOUR_TO_POINT = {
    '15 1': 't0915', '20 1': 't0920', '25 1': 't0925', '26 1': 't0926', '0 8': 'close',
  };
  return MIN_HOUR_TO_POINT[key] || null;
}

export default {
  async scheduled(event, env, ctx) {
    const point = cronToPoint(event.cron);
    if (!point) {
      console.error('[bidding-A] 无法识别 cron 表达式:', event.cron);
      return;
    }
    if (point === 't0926') ctx.waitUntil(runDuobanSecond(env, 'cron'));
    else ctx.waitUntil(runBidding(env, point, 'cron'));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true, service: 'bidding-board-worker-a', worker: 'A' }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/fetch') {
      const token = url.searchParams.get('token') || '';
      if (!env.FETCH_TOKEN || token !== env.FETCH_TOKEN) {
        return new Response(JSON.stringify({ ok: false, error: 'token 无效' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      }
      let point = url.searchParams.get('point') || 'auto';
      if (point === 'auto') {
        point = autoPoint();
        if (!point) return new Response(JSON.stringify({ ok: false, error: '当前北京时间不在任何抓取时段' }), { headers: { 'Content-Type': 'application/json' } });
      }
      if (!POINT_TO_COLUMN[point]) {
        return new Response(JSON.stringify({ ok: false, error: 'point 必须是 t0915|t0920|t0925|t0926|close|auto' }), { headers: { 'Content-Type': 'application/json' } });
      }
      let result;
      if (point === 't0926') result = await runDuobanSecond(env, 'http');
      else result = await runBidding(env, point, 'http');
      return new Response(JSON.stringify(result, null, 2), { headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('bidding-board-worker-a', { status: 200 });
  },
};
