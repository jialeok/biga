/**
 * 竞价变化看板 · 定时抓取 Worker
 *
 * 每天 4 趟（北京时间 9:15 / 9:20 / 9:25 / 16:00，周一至周五）：
 *   1. 校验今天是否 A 股交易日（fuyao 交易日历），非交易日直接退出不写库
 *   2. 调 fuyao 官方 API 拉快照，计算 5 行的值
 *   3. upsert 进 Supabase bidding_data 表（只写本趟对应的那一列，其它列不动）
 *   4. 写 bidding_fetch_log 日志表，便于事后排查
 *
 * 手动触发：GET /fetch?token=<FETCH_TOKEN>&point=t0915|t0920|t0925|close|auto
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
};

// cron 表达式 → 时间点（与 wrangler.toml 里 [triggers].crons 一一对应）
const CRON_TO_POINT = {
  '15 1 * * 1-5': 't0915',
  '20 1 * * 1-5': 't0920',
  '25 1 * * 1-5': 't0925',
  '0 8 * * 1-5': 'close',
};
// 时间点 → bidding_data 表列名（time930 列存的是 9:25 的数据，历史遗留命名，不动表结构）
const POINT_TO_COLUMN = { t0915: 'time915', t0920: 'time920', t0925: 'time930', close: 'close' };
