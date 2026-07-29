/**
 * 竞价变化看板 · 定时抓取 Worker
 *
 * 每天 4 趟（北京时间 9:15 / 9:20 / 9:25 / 16:00，周一至周五）：
 *   1. 校验今天是否 A 股交易日（fuyao 交易日历），非交易日直接退出不写库
 *   2. 调 fuyao 官方 API 拉快照，计算 5 行的值
 *   3. upsert 进 Supabase bidding_data 表（只写本趟对应的那一列，其它列不动）
 *   4. 写 bidding_fetch_log 日志表，便于事后排查
 *
 * 新增：
 *   - 9:26 对「最近多板%」二次抓取，保留 9:25 首次值，实现叠加效果
 *   - 9:25 增加「9点25分封单家数」行，走 NumCat 情绪周期接口
 *
 * 手动触发：GET /fetch?token=<FETCH_TOKEN>&point=t0915|t0920|t0925|t0926|close|auto
 *   auto = 按当前北京时间自动判断该填哪一列
 *
 * ⚠️ 写入格式约定：time915/time920/time930/close 列一律存【纯数字字符串】
 *   （如 "2.15"、"38"），不带 % 不带"红"——前端渲染层 formatValue 会自动补后缀，
 *    带符号写入会出现 "2.15%%" 这类双重后缀错乱。
 *
 * ⚠️ 行名是 upsert 冲突键的一部分（date,name），ROW_NAMES 必须与看板上的行名
 *   【一字不差】，否则会插入重复行而不是更新。改了看板行名就要同步改这里。
 */

// ══════════════════════════ 配置区（按需修改后重新 deploy）══════════════════════════
const CONFIG = {
  FUYAO_BASE: 'https://fuyao.aicubes.cn',
  SUPABASE_URL: 'https://tonqfgeyxnnwicjopshn.supabase.co',

  // 看板行名（与前端模板逐字一致；账号溢出行本 Worker 永远不碰）
  ROW_LADDER: '最近多板%',
  ROW_SECTOR_ETF: '板块ETF(48)',
  ROW_TOP10: '昨日资金前十',
  ROW_BIG_ETF: '大盘ETF',
  ROW_MAIN_INDEX: '大盘（%）',
  ROW_SEAL: '9点25分封单家数',   // 新增：走 NumCat 情绪周期接口

  LADDER_INDEX: '883410.TI',   // 同花顺"最近多板"特色板块
  TOP10_INDEX: '883901.TI',    // 同花顺"昨日资金前十"特色板块
  MAIN_INDEX: '000001.SH',     // 上证指数（用户清单里的 1A0001 对应标准代码）

  // 大盘ETF 行：4 只宽基，取涨幅算术平均
  BIG_ETFS: ['510500.SH', '512100.SH', '510300.SH', '510050.SH'],

  // 板块ETF 行：48 只（45 只 A 股 ETF 走股票快照，3 只指数走指数快照）
  // type: 'stock' → /api/a-share/prices/snapshot；type: 'index' → /api/a-share-index/prices/snapshot
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

  // NumCat 情绪周期接口（封单家数来源）
  // 字段名请按实际接口返回调整；若返回字段不同，Worker 会在首次调用时列出所有可用字段
  NUMCAT_URL: 'https://numcat.net/api/reference-proxy/market/emoindic-daily',
  NUMCAT_APINAME: 'emoindic_daily',
  SEAL_FIELD: 's3',   // 封单家数字段，默认 s3；如果不对，看日志里的 available_fields
};

// cron 表达式 → 时间点（与 wrangler.toml 里 [triggers].crons 一一对应）
const CRON_TO_POINT = {
  '15 1 * * 1-5': 't0915',
  '20 1 * * 1-5': 't0920',
  '25 1 * * 1-5': 't0925',
  '26 1 * * 1-5': 't0926',   // 新增：9:26 对最近多板% 二次抓取
  '0 8 * * 1-5': 'close',
};
// 时间点 → bidding_data 表列名（time930 列存的是 9:25 的数据，历史遗留命名，不动表结构）
const POINT_TO_COLUMN = { t0915: 'time915', t0920: 'time920', t0925: 'time930', t0926: 'time930', close: 'close' };

// ══════════════════════════ 工具函数 ══════════════════════════

// 北京时间 yyyy-MM-dd / yyyyMMdd / 时分
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

// fuyao 官方 API GET（统一信封：code!==0 视为失败）
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

// NumCat 情绪周期接口 POST（封单家数来源）
async function numcatEmoindic(env) {
  const resp = await fetch(CONFIG.NUMCAT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apiname: CONFIG.NUMCAT_APINAME,
      apikey: env.NUMCAT_API_KEY,
      params: {}
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

  // 优先取最新一条；如可按日期匹配今天则更好
  let latest = items[items.length - 1];
  const dateField = ['trade_date', 'trading_day', 'date', 'tradedate'].find(name => fields.indexOf(name) >= 0);
  if (dateField) {
    const idx = fields.indexOf(dateField);
    const todayCompact = beijingTodayCompact();
    const match = items.find(it => {
      const v = String(it[idx] || '').replace(/-/g, '');
      return v === todayCompact || v === beijingToday();
    });
    if (match) latest = match;
  }

  const sealIdx = fields.indexOf(CONFIG.SEAL_FIELD);
  if (sealIdx < 0) {
    throw new Error('NumCat 情绪周期接口缺少字段 "' + CONFIG.SEAL_FIELD + '"，可用字段: ' + fields.join(', '));
  }
  return {
    sealCount: Number(latest[sealIdx]),
    availableFields: fields
  };
}

// 交易日校验：调交易日历（近一年序列），今天不在列表里 → false。
// 日历接口本身失败时【保守返回 false】：宁可漏跑一天（可手动补），不在节假日误写错误数据。
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

// 指数成分股（883410.TI / 883901.TI）
async function getConstituentThscodes(env, indexThscode) {
  const data = await fuyaoGet(env, '/api/a-share-index/constituents/ths-stock-list', { thscode: indexThscode });
  return ((data && data.item) || []).map(function (it) { return it.thscode; }).filter(Boolean);
}

// A 股快照（批量，每批 ≤40 只），返回 { thscode: pct(number) }
async function getStockSnapshotPcts(env, thscodes) {
  const result = {};
  const batchSize = 40;
  for (let i = 0; i < thscodes.length; i += batchSize) {
    const chunk = thscodes.slice(i, i + batchSize);
    const data = await fuyaoGet(env, '/api/a-share/prices/snapshot', { thscodes: chunk.join(',') });
    ((data && data.item) || []).forEach(function (it) {
      if (it && it.thscode !== undefined && it.price_change_ratio_pct !== null && it.price_change_ratio_pct !== undefined) {
        result[it.thscode] = Number(it.price_change_ratio_pct);
      }
    });
  }
  return result;
}

// 指数快照（批量），返回 { thscode: pct(number) }
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

// 腾讯行情快照（ETF/基金专用）：fuyao 的 A 股快照不覆盖基金代码（510500/560780 等
// 报 code=1002 Unknown thscode），腾讯 qt.gtimg.cn 免费无需 key、覆盖场内 ETF、
// 盘中实时更新。入参/返回的键都保持 fuyao 风格 thscode（'510500.SH'），便于统一取用。
// 返回文本是 GBK 编码，但我们只取数字字段（index 32 = 涨跌幅%），中文名乱码不影响。
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
    const pct = parseFloat(fields[32]); // 字段32 = 涨跌幅百分比（4.93 表示 +4.93%）
    if (!isNaN(pct)) {
      const num = m[1].slice(2);
      result[num + (m[1].slice(0, 2) === 'sz' ? '.SZ' : '.SH')] = pct;
    }
  }
  return result;
}

// 批量抓取 + 缺失补单：Worker 跑在 Cloudflare 海外节点，跨境请求腾讯接口偶发
// 丢一两只（实测 49 只批量丢过 sz159611，单独请求却正常），缺的几只单独再补一次。
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
  const sum = numbers.reduce(function (a, b) { return a + b; }, 0);
  return sum / numbers.length;
}
function fmtPct(n) {
  // 库存纯数字字符串（渲染层自动加 %）；保留两位小数
  return (Math.round(n * 100) / 100).toFixed(2);
}

// ══════════════════════════ 五行数据计算 ══════════════════════════
// 返回 { [rowName]: { value: string|null, error?: string, missing?: string[] } }
async function computeAllRows(env, point) {
  const rows = {};

  // 1. 最近多板%：883410 成分股涨幅算术平均
  try {
    const codes = await getConstituentThscodes(env, CONFIG.LADDER_INDEX);
    if (codes.length === 0) {
      rows[CONFIG.ROW_LADDER] = { value: null, error: '883410 成分股为空' };
    } else {
      const pcts = await getStockSnapshotPcts(env, codes);
      const vals = codes.map(function (c) { return pcts[c]; }).filter(function (v) { return typeof v === 'number' && !isNaN(v); });
      const avg = avgOf(vals);
      rows[CONFIG.ROW_LADDER] = avg === null
        ? { value: null, error: '成分股快照全部缺失(' + codes.length + '只)' }
        : { value: fmtPct(avg), missing: codes.length - vals.length > 0 ? [String(codes.length - vals.length) + '只无快照'] : undefined };
    }
  } catch (e) {
    rows[CONFIG.ROW_LADDER] = { value: null, error: e.message };
  }

  // 2. 板块ETF(48)：45 只 ETF 走腾讯行情（fuyao 不收基金代码）+ 3 只指数走 fuyao 指数快照，涨幅>0 的家数
  try {
    const stockCodes = CONFIG.SECTOR_ETFS.filter(function (e) { return e.type === 'stock'; }).map(function (e) { return e.code; });
    const indexCodes = CONFIG.SECTOR_ETFS.filter(function (e) { return e.type === 'index'; }).map(function (e) { return e.code; });
    const stockPcts = await getTencentSnapshotPcts(stockCodes);
    const indexPcts = await getIndexSnapshotPcts(env, indexCodes);
    let red = 0;
    const missing = [];
    CONFIG.SECTOR_ETFS.forEach(function (e) {
      const pct = e.type === 'stock' ? stockPcts[e.code] : indexPcts[e.code];
      if (typeof pct === 'number' && !isNaN(pct)) {
        if (pct > 0) red++;
      } else {
        missing.push(e.name);
      }
    });
    rows[CONFIG.ROW_SECTOR_ETF] = { value: String(red), missing: missing.length ? missing : undefined };
  } catch (e) {
    rows[CONFIG.ROW_SECTOR_ETF] = { value: null, error: e.message };
  }

  // 3. 昨日资金前十：883901 成分股上涨家数
  try {
    const codes = await getConstituentThscodes(env, CONFIG.TOP10_INDEX);
    if (codes.length === 0) {
      rows[CONFIG.ROW_TOP10] = { value: null, error: '883901 成分股为空（接口可能不支持该特色指数）' };
    } else {
      const pcts = await getStockSnapshotPcts(env, codes);
      let red = 0, have = 0;
      codes.forEach(function (c) {
        const v = pcts[c];
        if (typeof v === 'number' && !isNaN(v)) { have++; if (v > 0) red++; }
      });
      rows[CONFIG.ROW_TOP10] = have === 0
        ? { value: null, error: '883901 成分股快照全部缺失(' + codes.length + '只)' }
        : { value: String(red), missing: codes.length - have > 0 ? [String(codes.length - have) + '只无快照'] : undefined };
    }
  } catch (e) {
    rows[CONFIG.ROW_TOP10] = { value: null, error: e.message };
  }

  // 4. 大盘ETF：4 只宽基涨幅算术平均（同样走腾讯行情）
  try {
    const pcts = await getTencentSnapshotPcts(CONFIG.BIG_ETFS);
    const vals = CONFIG.BIG_ETFS.map(function (c) { return pcts[c]; }).filter(function (v) { return typeof v === 'number' && !isNaN(v); });
    const avg = avgOf(vals);
    rows[CONFIG.ROW_BIG_ETF] = avg === null
      ? { value: null, error: '大盘ETF快照全部缺失' }
      : { value: fmtPct(avg), missing: CONFIG.BIG_ETFS.length - vals.length > 0 ? [String(CONFIG.BIG_ETFS.length - vals.length) + '只无快照'] : undefined };
  } catch (e) {
    rows[CONFIG.ROW_BIG_ETF] = { value: null, error: e.message };
  }

  // 5. 大盘（%）：上证指数 000001.SH
  try {
    const pcts = await getIndexSnapshotPcts(env, [CONFIG.MAIN_INDEX]);
    const v = pcts[CONFIG.MAIN_INDEX];
    rows[CONFIG.ROW_MAIN_INDEX] = (typeof v === 'number' && !isNaN(v))
      ? { value: fmtPct(v) }
      : { value: null, error: '上证指数快照缺失' };
  } catch (e) {
    rows[CONFIG.ROW_MAIN_INDEX] = { value: null, error: e.message };
  }

  // 6. 9点25分封单家数：仅 9:25 这趟抓，其它时段不抓
  if (point === 't0925') {
    try {
      const numcat = await numcatEmoindic(env);
      const seal = numcat.sealCount;
      if (isNaN(seal)) {
        rows[CONFIG.ROW_SEAL] = { value: null, error: 'NumCat 封单家数字段 "' + CONFIG.SEAL_FIELD + '" 不是数字，可用字段: ' + numcat.availableFields.join(', ') };
      } else {
        rows[CONFIG.ROW_SEAL] = { value: String(Math.round(seal)) };
      }
    } catch (e) {
      rows[CONFIG.ROW_SEAL] = { value: null, error: e.message };
    }
  }

  return rows;
}

// ══════════════════════════ Supabase 读写 ══════════════════════════

function sbHeaders(env) {
  return {
    'apikey': env.SUPABASE_ANON_KEY,
    'Authorization': 'Bearer ' + env.SUPABASE_ANON_KEY,
    'Content-Type': 'application/json',
  };
}

// 读今日现有行（算增减列需要拿到 9:20 的值；二次抓取需要拿到 initial 字段）
async function readTodayRows(env, date) {
  const url = CONFIG.SUPABASE_URL + '/rest/v1/bidding_data?date=eq.' + encodeURIComponent(date) +
    '&select=name,time915,time920,time930,close,time930_initial,time930_initial_modifiedAt,time930_modifiedAt';
  const resp = await fetch(url, { headers: sbHeaders(env) });
  if (!resp.ok) throw new Error('读取 bidding_data 失败: HTTP ' + resp.status);
  return await resp.json();
}

// upsert（冲突键 date,name；payload 里没出现的列保留旧值——只写本趟那一列，安全）
async function upsertRows(env, rows) {
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

// 执行日志（独立小表；写日志失败不影响主流程）
async function writeLog(env, entry) {
  try {
    const url = CONFIG.SUPABASE_URL + '/rest/v1/bidding_fetch_log';
    await fetch(url, {
      method: 'POST',
      headers: Object.assign(sbHeaders(env), { 'Prefer': 'return=minimal' }),
      body: JSON.stringify(entry),
    });
  } catch (e) {
    console.error('写 bidding_fetch_log 失败（已忽略）:', e.message);
  }
}

// ══════════════════════════ 主流程 ══════════════════════════

async function runFetch(env, point, source) {
  const date = beijingToday();
  const column = POINT_TO_COLUMN[point];
  const logBase = { run_date: date, time_point: point, source: source || 'cron' };
  if (!column) {
    await writeLog(env, Object.assign(logBase, { ok: false, detail: { error: '未知 time_point: ' + point } }));
    return { ok: false, error: '未知 time_point: ' + point };
  }

  // 1. 交易日校验（非交易日不写库）
  if (!(await isTradingDay(env))) {
    await writeLog(env, Object.assign(logBase, { ok: false, detail: { skipped: '非交易日或日历校验失败' } }));
    return { ok: false, error: '非交易日，已跳过' };
  }

  // 2. 抓数 + 计算 5/6 行
  const computed = await computeAllRows(env, point);
  // 行级失败重试：某行为空时（典型场景：9:25:00 集合竞价刚结束，fuyao 对 883410
  // 成分股的快照在这个间隙可能返回空），等 45 秒整体重算一次，只把失败行的新结果补上。
  const failedRowNames = Object.keys(computed).filter(function (k) {
    return computed[k].value === null || computed[k].value === undefined;
  });
  if (failedRowNames.length > 0) {
    console.log('本趟有 ' + failedRowNames.length + ' 行未抓到(' + failedRowNames.join(',') + ')，45 秒后重试...');
    await new Promise(function (r) { setTimeout(r, 45000); });
    try {
      const retry = await computeAllRows(env, point);
      failedRowNames.forEach(function (k) {
        if (retry[k] && retry[k].value !== null && retry[k].value !== undefined) {
          computed[k] = retry[k];
          console.log('重试成功: ' + k + ' = ' + retry[k].value);
        }
      });
    } catch (e) {
      console.warn('45 秒重试失败（保留首次结果）:', e.message);
    }
  }
  const now = new Date().toISOString();

  // 3. 9:25 这趟：读出 9:20 的值算增减列（增/减/平），与前端编辑表单的规则一致
  let existingByName = {};
  if (point === 't0925') {
    try {
      (await readTodayRows(env, date)).forEach(function (r) { existingByName[(r.name || '').trim()] = r; });
    } catch (e) {
      console.error('读今日行失败（增减列将留空）:', e.message);
    }
  }

  // 4. 组装 upsert 行（某行抓数失败 → 该行本趟不写，保留旧值，记日志）
  const upsertPayload = [];
  const rowResults = {};
  Object.keys(computed).forEach(function (rowName) {
    const r = computed[rowName];
    rowResults[rowName] = r;
    if (r.value === null || r.value === undefined) return;
    const row = { date: date, name: rowName, updated_at: now };
    row[column] = r.value;
    if (point === 't0925') {
      const prev = existingByName[rowName];
      const v920 = prev ? parseFloat(prev.time920) : NaN;
      const v925 = parseFloat(r.value);
      if (!isNaN(v920) && !isNaN(v925)) {
        row.change = v925 > v920 ? '增' : (v925 < v920 ? '减' : '平');
      }
      // 9:20 没值 → 不写 change 字段（保留旧值），与前端"任一为空则清空"的交互逻辑不冲突
    }
    upsertPayload.push(row);
  });

  // 5. 写库 + 日志
  let ok = true, writeError = null;
  if (upsertPayload.length > 0) {
    try {
      await upsertRows(env, upsertPayload);
    } catch (e) {
      ok = false;
      writeError = e.message;
    }
  }
  await writeLog(env, Object.assign(logBase, {
    ok: ok,
    detail: { written: upsertPayload, rows: rowResults, writeError: writeError },
  }));

  return { ok: ok, date: date, point: point, column: column, written: upsertPayload, rows: rowResults, writeError: writeError };
}

// 9:26 二次抓取：只抓「最近多板%」，保留 9:25 首次值，更新最终值和时间
async function runFetchDuoban926(env, source) {
  const date = beijingToday();
  const logBase = { run_date: date, time_point: 't0926', source: source || 'cron' };

  // 1. 交易日校验
  if (!(await isTradingDay(env))) {
    await writeLog(env, Object.assign(logBase, { ok: false, detail: { skipped: '非交易日或日历校验失败' } }));
    return { ok: false, error: '非交易日，已跳过' };
  }

  // 2. 只抓最近多板%
  let duobanResult;
  try {
    const codes = await getConstituentThscodes(env, CONFIG.LADDER_INDEX);
    if (codes.length === 0) throw new Error('883410 成分股为空');
    const pcts = await getStockSnapshotPcts(env, codes);
    const vals = codes.map(function (c) { return pcts[c]; }).filter(function (v) { return typeof v === 'number' && !isNaN(v); });
    const avg = avgOf(vals);
    if (avg === null) throw new Error('成分股快照全部缺失');
    duobanResult = { value: fmtPct(avg), missing: codes.length - vals.length > 0 ? [String(codes.length - vals.length) + '只无快照'] : undefined };
  } catch (e) {
    duobanResult = { value: null, error: e.message };
  }

  // 3. 读取现有「最近多板%」行（带 initial 字段）
  let existing = null;
  try {
    const rows = await readTodayRows(env, date);
    existing = rows.find(function (r) { return (r.name || '').trim() === CONFIG.ROW_LADDER; }) || null;
  } catch (e) {
    console.error('读今日行失败:', e.message);
  }

  // 4. 组装：保留 initial，更新 final
  const now = new Date().toISOString();
  const row = { date: date, name: CONFIG.ROW_LADDER, time930: duobanResult.value, updated_at: now };

  if (existing && existing.time930_initial !== undefined && existing.time930_initial !== null && String(existing.time930_initial).trim() !== '') {
    // 已锁定过首次值：保持 initial 不变，更新 final 和 modifiedAt
    row.time930_initial = existing.time930_initial;
    row.time930_initial_modifiedAt = existing.time930_initial_modifiedAt || now;
    row.time930_modifiedAt = now;
  } else if (duobanResult.value !== null && duobanResult.value !== undefined) {
    // 没有 initial：本次视为首次（理论上 9:25 应已写过，容错）
    row.time930_initial = duobanResult.value;
    row.time930_initial_modifiedAt = now;
  }

  // change 列：与现有 time920 对比
  if (existing && existing.time920 !== undefined && existing.time920 !== null && String(existing.time920).trim() !== '' && duobanResult.value !== null) {
    const v926 = parseFloat(duobanResult.value);
    const v920 = parseFloat(existing.time920);
    if (!isNaN(v926) && !isNaN(v920)) {
      row.change = v926 > v920 ? '增' : (v926 < v920 ? '减' : '平');
    }
  }

  // 5. 写库 + 日志
  let ok = true, writeError = null;
  if (duobanResult.value !== null && duobanResult.value !== undefined) {
    try {
      await upsertRows(env, [row]);
    } catch (e) {
      ok = false;
      writeError = e.message;
    }
  }
  await writeLog(env, Object.assign(logBase, {
    ok: ok,
    detail: { written: duobanResult.value !== null ? [row] : [], row: duobanResult, writeError: writeError },
  }));

  return { ok: ok, date: date, point: 't0926', written: duobanResult.value !== null ? [row] : [], row: duobanResult, writeError: writeError };
}

// 手动触发 auto：按当前北京时间判断该填哪列
function autoPoint() {
  const d = beijingNow();
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (mins >= 9 * 60 + 10 && mins < 9 * 60 + 17) return 't0915';   // 09:10–09:17
  if (mins >= 9 * 60 + 17 && mins < 9 * 60 + 22) return 't0920';   // 09:17–09:22
  if (mins >= 9 * 60 + 22 && mins < 9 * 60 + 25) return 't0925';   // 09:22–09:25
  if (mins >= 9 * 60 + 25 && mins < 9 * 60 + 40) return 't0926';   // 09:25–09:40 视为二次抓取
  if (mins >= 15 * 60) return 'close';                             // 15:00 之后
  return null;
}

// ══════════════════════════ 入口 ══════════════════════════

export default {
  // 定时触发
  async scheduled(event, env, ctx) {
    const point = CRON_TO_POINT[event.cron];
    if (point === 't0926') {
      ctx.waitUntil(runFetchDuoban926(env, 'cron'));
    } else {
      ctx.waitUntil(runFetch(env, point, 'cron'));
    }
  },

  // HTTP 触发：/fetch?token=xxx&point=t0915|t0920|t0925|t0926|close|auto ；/health 健康检查
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true, service: 'bidding-board-worker' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.pathname === '/fetch') {
      const token = url.searchParams.get('token') || '';
      if (!env.FETCH_TOKEN || token !== env.FETCH_TOKEN) {
        return new Response(JSON.stringify({ ok: false, error: 'token 无效' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      }
      let point = url.searchParams.get('point') || 'auto';
      if (point === 'auto') {
        point = autoPoint();
        if (!point) {
          return new Response(JSON.stringify({ ok: false, error: '当前北京时间不在任何抓取时段（09:10-09:40 或 15:00 后），请显式指定 point 参数' }), { headers: { 'Content-Type': 'application/json' } });
        }
      }
      if (!POINT_TO_COLUMN[point]) {
        return new Response(JSON.stringify({ ok: false, error: 'point 必须是 t0915|t0920|t0925|t0926|close|auto' }), { headers: { 'Content-Type': 'application/json' } });
      }
      const result = point === 't0926'
        ? await runFetchDuoban926(env, 'http')
        : await runFetch(env, point, 'http');
      return new Response(JSON.stringify(result, null, 2), { headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('bidding-board-worker', { status: 200 });
  },
};
