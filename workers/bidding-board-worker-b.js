/**
 * 猫爪 NumCat 看板 · Worker B（NumCat 专用）
 *
 * 部署到 Cloudflare 账号 B，只读写 NumCat 数据，完全不碰同花顺/腾讯行情。
 * 共 4 个 cron：
 *   1. 9:25  (UTC 01:25) → 抓封单家数，写入 bidding_data.time930（name='封单家数'）
 *   2. 9:26  (UTC 01:26) → 抓情绪看板，写入 emotion_data
 *   3. 9:40  (UTC 01:40) → 开盘后补抓情绪看板（盘前 am_pred 未发布时，开盘后重抓拿到今日预测）
 *   4. 16:00 (UTC 08:00) → 抓记忘看板昨收涨跌比，写入 jiwang_data
 *
 * 手动触发：GET /fetch?token=<FETCH_TOKEN>&point=t0925-seal|t0926|close|jiwang|auto
 * 公开刷新：GET /refresh-emotion（按 IP 限流，仅刷新预测量能）
 */

// ══════════════════════════ 配置区 ══════════════════════════
const CONFIG = {
  FUYAO_BASE: 'https://fuyao.aicubes.cn',
  SUPABASE_URL: 'https://tonqfgeyxnnwicjopshn.supabase.co',

  // 封单家数在 bidding_data 表中的行名
  ROW_SEAL: '封单家数',

  // NumCat 情绪周期接口（封单家数来源 + 情绪看板数据来源 + 记忘看板数据来源）
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
  '25 1 * * 1-5': 't0925-seal',
  '26 1 * * 1-5': 't0926',
  '40 1 * * 1-5': 't0926', // 开盘后补抓：盘前 am_pred 未发布时，开盘后重抓一次拿到今日预测
  '0 8 * * 1-5': 'close',
};
const SEAL_COLUMN = 'time930';

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

// ══════════════════════════ NumCat 情绪周期接口（通用）══════════════════════════

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
  const latest = findTodayItem(fields, items);
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
  let d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + 1);
  while (true) {
    const s = d.toISOString().split('T')[0];
    const dayOfWeek = d.getDay();
    if (dayOfWeek !== 0 && dayOfWeek !== 6 && !KNOWN_HOLIDAYS.has(s)) return s;
    d.setDate(d.getDate() + 1);
  }
}

// ══════════════════════════ Supabase 读写 ══════════════════════════

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

// ══════════════════════════ 封单家数 ══════════════════════════

async function runSeal(env, source) {
  const date = beijingToday();
  const logBase = { run_date: date, time_point: 't0925', source: source || 'cron', job: 'seal', worker: 'B' };

  if (!(await isTradingDay(env))) {
    await writeLog(env, Object.assign(logBase, { ok: false, detail: { skipped: '非交易日' } }));
    return { ok: false, error: '非交易日，已跳过' };
  }

  let sealResult;
  try {
    const numcat = await numcatEmoindic(env);
    const seal = numcat.sealCount;
    if (isNaN(seal)) {
      sealResult = { value: null, error: 'NumCat 封单家数字段 "' + CONFIG.SEAL_FIELD + '" 不是数字，可用字段: ' + numcat.availableFields.join(', ') };
    } else {
      sealResult = { value: String(Math.round(seal)) };
    }
  } catch (e) {
    sealResult = { value: null, error: e.message };
  }

  const now = new Date().toISOString();
  const row = { date: date, name: CONFIG.ROW_SEAL, updated_at: now };
  row[SEAL_COLUMN] = sealResult.value;

  let ok = true, writeError = null;
  if (sealResult.value !== null && sealResult.value !== undefined) {
    try { await upsertBiddingRows(env, [row]); }
    catch (e) { ok = false; writeError = e.message; }
  }
  await writeLog(env, Object.assign(logBase, { ok, detail: { written: sealResult.value !== null ? [row] : [], row: sealResult, writeError } }));
  return { ok, date, point: 't0925-seal', column: SEAL_COLUMN, written: sealResult.value !== null ? [row] : [], row: sealResult, writeError };
}

// ══════════════════════════ 情绪看板逻辑 ══════════════════════════

async function runEmotion(env, source, sharedFull) {
  const date = beijingToday();
  const logBase = { run_date: date, time_point: 't0926', source: source || 'cron', job: 'emotion', worker: 'B' };

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

  // 以日历上的「今天」为基准定位今日/昨日行
  const todayStr = beijingToday();            // e.g. 2026-07-30
  const todayCompact = beijingTodayCompact(); // e.g. 20260730
  let todayIdx = -1;
  let yesterdayIdx = -1;

  if (dateField) {
    const dateIdx = fields.indexOf(dateField);
    todayIdx = items.findIndex(function (it) {
      const v = String(it[dateIdx] || '').replace(/-/g, '');
      return v === todayStr || v === todayCompact;
    });

    if (todayIdx >= 0) {
      // 接口里有今天（盘中），昨天就是前一天
      yesterdayIdx = todayIdx > 0 ? todayIdx - 1 : todayIdx;
    } else {
      // 接口里还没今天（如开盘前或节假日），找小于今天的最晚那条作为昨天
      for (let i = items.length - 1; i >= 0; i--) {
        const v = String(items[i][dateIdx] || '').replace(/-/g, '');
        if (Number(v) < Number(todayCompact)) {
          yesterdayIdx = i;
          break;
        }
      }
      if (yesterdayIdx < 0) yesterdayIdx = items.length - 1;
    }
  }

  if (todayIdx < 0) todayIdx = items.length - 1;
  if (yesterdayIdx < 0) yesterdayIdx = todayIdx > 0 ? todayIdx - 1 : todayIdx;

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

  // predictVol 兜底：今日 am_pred 缺失（盘前/开盘后 NumCat 尚未发布预测）时回落到昨日预测，
  // 避免「预测」行在盘中消失、只剩昨日。predictVolFallback 供前端标注来源。
  let predictVolFallback = false;
  if (metrics.predictVol === null && yesterdayItem) {
    const yPred = pickEmotionValue(fields, yesterdayItem, CONFIG.EMOTION_FIELDS.predictVol);
    if (yPred !== null) {
      metrics.predictVol = yPred;
      predictVolFallback = true;
    }
  }
  metrics.predictVolFallback = predictVolFallback;

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
  const logBase = { run_date: date, time_point: 't0926', source: source || 'http', job: 'emotion-refresh', worker: 'B' };

  let full;
  try {
    full = await fetchNumCatEmotionFull(env);
  } catch (e) {
    await writeLog(env, Object.assign(logBase, { ok: false, detail: { error: e.message } }));
    return { ok: false, error: e.message };
  }

  const fields = full.fields;
  const dateField = findDateField(fields);
  const items = sortItemsByDate(fields, full.items);

  // 定位今日行：优先找日历今天，找不到则取小于今天的最近一条
  const todayStr = beijingToday();
  const todayCompact = beijingTodayCompact();
  let todayIdx = items.length - 1;

  if (dateField) {
    const dateIdx = fields.indexOf(dateField);
    const found = items.findIndex(function (it) {
      const v = String(it[dateIdx] || '').replace(/-/g, '');
      return v === todayStr || v === todayCompact;
    });
    if (found >= 0) {
      todayIdx = found;
    } else {
      for (let i = items.length - 1; i >= 0; i--) {
        const v = String(items[i][dateIdx] || '').replace(/-/g, '');
        if (Number(v) < Number(todayCompact)) {
          todayIdx = i;
          break;
        }
      }
    }
  }

  let predictVol = pickEmotionValue(fields, items[todayIdx], CONFIG.EMOTION_FIELDS.predictVol);
  let predictVolFallback = false;
  if (predictVol === null) {
    // 今日 am_pred 尚未发布，回落到昨日预测，避免「预测」行消失
    const fbItem = items[Math.max(0, todayIdx - 1)];
    const yPred = pickEmotionValue(fields, fbItem, CONFIG.EMOTION_FIELDS.predictVol);
    if (yPred !== null) {
      predictVol = yPred;
      predictVolFallback = true;
    } else {
      await writeLog(env, Object.assign(logBase, { ok: false, detail: { error: '未找到 am_pred 字段' } }));
      return { ok: false, error: 'NumCat 返回中未找到 am_pred 预测量能字段' };
    }
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
  metrics.predictVolFallback = predictVolFallback;

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

// ══════════════════════════ 记忘看板逻辑 ══════════════════════════

async function runJiwang(env, source, sharedFull) {
  const date = beijingToday();
  const logBase = { run_date: date, time_point: 'close', source: source || 'cron', job: 'jiwang', worker: 'B' };

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

// ══════════════════════════ 主流程 ══════════════════════════

async function runClose(env, source) {
  // 16:00 同时刷新记忘看板和情绪看板；情绪看板已改到 9:26 抓取，收盘再刷一次确保收盘后数据完整。
  let sharedFull = null;
  let sharedFullError = null;
  try {
    sharedFull = await fetchNumCatEmotionFull(env);
  } catch (e) {
    sharedFullError = e.message;
  }

  const jiwangPromise = sharedFull
    ? runJiwang(env, source, sharedFull)
    : Promise.resolve({ ok: false, error: 'NumCat 共享接口失败: ' + sharedFullError });

  const emotionPromise = sharedFull
    ? runEmotion(env, source, sharedFull)
    : Promise.resolve({ ok: false, error: 'NumCat 共享接口失败: ' + sharedFullError });

  const [jiwangResult, emotionResult] = await Promise.allSettled([
    jiwangPromise,
    emotionPromise
  ]);

  return {
    ok: (jiwangResult.status === 'fulfilled' && jiwangResult.value.ok) &&
        (emotionResult.status === 'fulfilled' && emotionResult.value.ok),
    jiwang: jiwangResult.status === 'fulfilled' ? jiwangResult.value : { ok: false, error: jiwangResult.reason?.message },
    emotion: emotionResult.status === 'fulfilled' ? emotionResult.value : { ok: false, error: emotionResult.reason?.message },
    sharedFullError
  };
}

function autoPoint() {
  const d = beijingNow();
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (mins >= 9 * 60 + 22 && mins < 9 * 60 + 25) return 't0925-seal';
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
    if (point === 't0925-seal') ctx.waitUntil(runSeal(env, 'cron'));
    else if (point === 't0926') ctx.waitUntil(runEmotion(env, 'cron'));
    else if (point === 'close') ctx.waitUntil(runClose(env, 'cron'));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true, service: 'bidding-board-worker-b', worker: 'B' }), { headers: { 'Content-Type': 'application/json' } });
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
      const validPoints = ['t0925-seal', 't0926', 'close'];
      if (!validPoints.includes(point)) {
        return new Response(JSON.stringify({ ok: false, error: 'point 必须是 t0925-seal|t0926|close|jiwang|auto' }), { headers: { 'Content-Type': 'application/json' } });
      }
      let result;
      if (point === 't0925-seal') result = await runSeal(env, 'http');
      else if (point === 't0926') result = await runEmotion(env, 'http');
      else if (point === 'close') result = await runClose(env, 'http');
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
    return new Response('bidding-board-worker-b', { status: 200 });
  },
};
