/**
 * remaining-boards.js
 * 剩余看板独立拆分模块：stocks / rank / multi / hotspot / pattern / tagTitles
 * - 不依赖 allData 全量加载
 * - 各自直接读写 Supabase 独立表
 * - 与 index.html 中既有的 getter/setter 兼容：通过内存缓存 + 覆盖 getter 实现透明切换
 */
(function () {
  'use strict';

  const SUPABASE_URL = 'https://tonqfgeyxnnwicjopshn.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRvbnFmZ2V5eG5ud2ljam9wc2huIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2NjY3NzEsImV4cCI6MjA5NDI0Mjc3MX0.el-W10JIjr9iQXEKNxV7nLNdhZfOQp6waTY7ZSH27Jg';

  let _supabaseClient = null;
  function getSupabase() {
    if (!_supabaseClient) {
      _supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    }
    return _supabaseClient;
  }

  const MODULE_KEYS = ['stocks', 'rank', 'multi', 'hotspot', 'pattern', 'tagTitles'];

  // 内存缓存（与 allData[key] 指向同一对象，避免两份状态）
  const _stocksMemCache = window._stocksMemCache = {};
  const _rankMemCache = window._rankMemCache = {};
  const _multiMemCache = window._multiMemCache = {};
  const _hotspotMemCache = window._hotspotMemCache = {};
  const _patternMemCache = window._patternMemCache = {};
  const _tagTitlesMemCache = window._tagTitlesMemCache = {};

  const _caches = {
    stocks: _stocksMemCache,
    rank: _rankMemCache,
    multi: _multiMemCache,
    hotspot: _hotspotMemCache,
    pattern: _patternMemCache,
    tagTitles: _tagTitlesMemCache
  };

  // 脏日期跟踪：每个模块维护一个 Set<date>
  const _dirty = {
    stocks: new Set(),
    rank: new Set(),
    multi: new Set(),
    hotspot: new Set(),
    pattern: new Set(),
    tagTitles: new Set()
  };

  // 上次成功推送到云端的状态快照（用于 diff）
  const _lastPushed = {
    stocks: {},
    rank: {},
    multi: {},
    hotspot: {},
    pattern: {},
    tagTitles: {}
  };

  let _pushDebounceTimer = null;
  let _isPushing = false;
  let _lastLoadDate = null;

  function formatNowIso() {
    return new Date().toISOString();
  }

  function _moduleKey(name) {
    return 'stockApp_v42_' + name;
  }

  function _readLegacyObject(key) {
    try {
      return JSON.parse(localStorage.getItem(key) || '{}');
    } catch (e) {
      return {};
    }
  }

  function _dateRe() {
    return /^\d{4}-\d{2}-\d{2}$/;
  }

  function _isDateKey(k) {
    return typeof k === 'string' && _dateRe().test(k);
  }

  function _toast(msg) {
    if (typeof showToast === 'function') showToast(msg);
    else console.log('[RB]', msg);
  }

  function _warn(msg) {
    console.warn('[RB]', msg);
  }

  // ==========================================================================
  // 字段映射：camelCase（前端） <-> snake_case（Supabase）
  // ==========================================================================
  const STOCK_FIELD_MAP = {
    id: 'local_id',
    name: 'name',
    stage: 'stage',
    adjust: 'adjust',
    open: 'open',
    close: 'close',
    turnover: 'turnover',
    kbiliangkai: 'kbiliangkai',
    sfliangneng: 'sfliangneng',
    xgcaiti: 'xgcaiti',
    nextDay: 'next_day',
    bomb: 'bomb',
    bought: 'bought',
    sold: 'sold',
    sellHigh: 'sell_high',
    sell1120: 'sell_1120',
    sell1450: 'sell_1450',
    hold: 'hold',
    watch: 'watch',
    dragon: 'dragon',
    pattern: 'pattern',
    axis: 'axis',
    comment: 'comment',
    remark: 'remark',
    remarkType: 'remark_type',
    track: 'track',
    soldRecords: 'sold_records',
    isSold: 'is_sold',
    recentMulti: 'recent_multi',
    topicDirection: 'topic_direction',
    sectorEtf: 'sector_etf',
    nishi: 'nishi',
    shunshi: 'shunshi',
    inheritedHold: 'inherited_hold'
  };

  function _stockToRow(date, stock) {
    const row = { date };
    Object.keys(STOCK_FIELD_MAP).forEach(key => {
      const col = STOCK_FIELD_MAP[key];
      let val = stock[key];
      if (val === undefined) val = null;
      row[col] = val;
    });
    return row;
  }

  function _rowToStock(row) {
    const stock = {};
    Object.keys(STOCK_FIELD_MAP).forEach(key => {
      const col = STOCK_FIELD_MAP[key];
      let val = row[col];
      if (val === null) val = undefined;
      stock[key] = val;
    });
    return stock;
  }

  // ==========================================================================
  // 从 localStorage 预加载到内存缓存（保证首屏立即有数据，后台再迁移/同步到 Supabase）
  // ==========================================================================
  function preloadLegacyToCaches() {
    for (const key of MODULE_KEYS) {
      const legacy = _readLegacyObject(_moduleKey(key));
      if (!legacy || Object.keys(legacy).length === 0) continue;
      if (key === 'stocks') {
        Object.keys(legacy).forEach(date => {
          if (!_isDateKey(date)) return;
          const list = legacy[date] || [];
          if (Array.isArray(list) && list.length > 0) _stocksMemCache[date] = list;
        });
      } else if (key === 'rank') {
        Object.assign(_rankMemCache, legacy);
      } else if (key === 'multi') {
        Object.assign(_multiMemCache, legacy);
      } else if (key === 'hotspot') {
        Object.assign(_hotspotMemCache, legacy);
      } else if (key === 'pattern') {
        Object.assign(_patternMemCache, legacy);
      } else if (key === 'tagTitles') {
        Object.assign(_tagTitlesMemCache, legacy);
      }
    }
  }

  // ==========================================================================
  // 迁移：从 localStorage 一次性搬到 Supabase
  // ==========================================================================
  async function migrateLegacyBoardsToSupabase() {
    if (localStorage.getItem('stockApp_v42_remaining_migrated') === '1') return;

    for (const key of MODULE_KEYS) {
      const legacy = _readLegacyObject(_moduleKey(key));
      if (!legacy || Object.keys(legacy).length === 0) continue;

      try {
        if (key === 'stocks') {
          const rows = [];
          Object.keys(legacy).forEach(date => {
            if (!_isDateKey(date)) return;
            const list = legacy[date] || [];
            list.forEach(stock => {
              if (!stock || !stock.name) return;
              rows.push(_stockToRow(date, stock));
            });
          });
          if (rows.length > 0) {
            const sb = getSupabase();
            await sb.from('stocks_data').upsert(rows, { onConflict: 'date,name' });
          }
        } else if (key === 'rank' || key === 'multi') {
          const sb = getSupabase();
          for (const date of Object.keys(legacy)) {
            if (!_isDateKey(date)) continue;
            const data = legacy[date];
            if (!data || (Array.isArray(data) && data.length === 0)) continue;
            await sb.from(key + '_data').upsert({ date, data }, { onConflict: 'date' });
          }
        } else if (key === 'hotspot') {
          const sb = getSupabase();
          for (const date of Object.keys(legacy)) {
            if (!_isDateKey(date)) continue;
            const content = legacy[date] || '';
            if (!content) continue;
            await sb.from('hotspot_data').upsert({ date, content }, { onConflict: 'date' });
          }
        } else if (key === 'pattern') {
          const sb = getSupabase();
          for (const date of Object.keys(legacy)) {
            if (!_isDateKey(date)) continue;
            const p = legacy[date] || {};
            await sb.from('pattern_data').upsert({
              date,
              content: p.content || '',
              update_flag: !!p.update,
              keep_flag: !!p.keep
            }, { onConflict: 'date' });
          }
        } else if (key === 'tagTitles') {
          const sb = getSupabase();
          for (const date of Object.keys(legacy)) {
            if (!_isDateKey(date)) continue;
            const data = legacy[date];
            if (!data) continue;
            await sb.from('tag_titles_data').upsert({ date, data }, { onConflict: 'date' });
          }
        }
      } catch (e) {
        _warn('迁移 ' + key + ' 失败: ' + (e.message || e));
      }
    }

    localStorage.setItem('stockApp_v42_remaining_migrated', '1');
  }

  // ==========================================================================
  // 加载（按日期）
  // ==========================================================================
  async function loadStocksForDate(date) {
    if (!date) return;
    try {
      const sb = getSupabase();
      const { data, error } = await sb
        .from('stocks_data')
        .select('*')
        .eq('date', date)
        .order('local_id', { ascending: false });
      if (error) throw error;
      const list = (data || []).map(_rowToStock);
      // 云端无数据时保留本地已预加载的数据，避免首屏空白或覆盖旧数据
      if (list.length > 0 || !_stocksMemCache[date]) {
        _stocksMemCache[date] = list;
        _lastPushed.stocks[date] = JSON.stringify(list);
      }
    } catch (e) {
      _warn('loadStocksForDate ' + date + ' 失败: ' + (e.message || e));
    }
  }

  async function loadRankForDate(date) {
    if (!date) return;
    try {
      const sb = getSupabase();
      const { data, error } = await sb
        .from('rank_data')
        .select('*')
        .eq('date', date)
        .maybeSingle();
      if (error) throw error;
      const hasData = data && Array.isArray(data.data);
      const val = hasData ? data.data : (_rankMemCache[date] || []);
      _rankMemCache[date] = val;
      _lastPushed.rank[date] = JSON.stringify(val);
    } catch (e) {
      _warn('loadRankForDate ' + date + ' 失败: ' + (e.message || e));
    }
  }

  async function loadMultiForDate(date) {
    if (!date) return;
    try {
      const sb = getSupabase();
      const { data, error } = await sb
        .from('multi_data')
        .select('*')
        .eq('date', date)
        .maybeSingle();
      if (error) throw error;
      const hasData = data && Array.isArray(data.data);
      const val = hasData ? data.data : (_multiMemCache[date] || []);
      _multiMemCache[date] = val;
      _lastPushed.multi[date] = JSON.stringify(val);
    } catch (e) {
      _warn('loadMultiForDate ' + date + ' 失败: ' + (e.message || e));
    }
  }

  async function loadHotspotForDate(date) {
    if (!date) return;
    try {
      const sb = getSupabase();
      const { data, error } = await sb
        .from('hotspot_data')
        .select('*')
        .eq('date', date)
        .maybeSingle();
      if (error) throw error;
      const hasData = data && typeof data.content === 'string';
      const val = hasData ? data.content : (_hotspotMemCache[date] || '');
      _hotspotMemCache[date] = val;
      _lastPushed.hotspot[date] = val;
    } catch (e) {
      _warn('loadHotspotForDate ' + date + ' 失败: ' + (e.message || e));
    }
  }

  async function loadPatternForDate(date) {
    if (!date) return;
    try {
      const sb = getSupabase();
      const { data, error } = await sb
        .from('pattern_data')
        .select('*')
        .eq('date', date)
        .maybeSingle();
      if (error) throw error;
      const defaultVal = { content: '', update: false, keep: false };
      const val = data
        ? { content: data.content || '', update: !!data.update_flag, keep: !!data.keep_flag }
        : (_patternMemCache[date] || defaultVal);
      _patternMemCache[date] = val;
      _lastPushed.pattern[date] = JSON.stringify(val);
    } catch (e) {
      _warn('loadPatternForDate ' + date + ' 失败: ' + (e.message || e));
    }
  }

  async function loadTagTitlesForDate(date) {
    if (!date) return;
    try {
      const sb = getSupabase();
      const { data, error } = await sb
        .from('tag_titles_data')
        .select('*')
        .eq('date', date)
        .maybeSingle();
      if (error) throw error;
      const defaultVal = {
        recentMulti: { tags: [], active: {}, score: 0 },
        sectorEtf: { tags: [], active: {}, score: 0 },
        topicDirection: { tags: [], active: {}, score: 0 },
        consecutiveUp: { duoban: 0, bankuai: 0, ticai: 0 }
      };
      const hasData = data && data.data && typeof data.data === 'object';
      const val = hasData ? data.data : (_tagTitlesMemCache[date] || defaultVal);
      _tagTitlesMemCache[date] = val;
      _lastPushed.tagTitles[date] = JSON.stringify(val);
    } catch (e) {
      _warn('loadTagTitlesForDate ' + date + ' 失败: ' + (e.message || e));
    }
  }

  async function loadAllRemainingForDate(date) {
    if (!date) return;
    await Promise.all([
      loadStocksForDate(date),
      loadRankForDate(date),
      loadMultiForDate(date),
      loadHotspotForDate(date),
      loadPatternForDate(date),
      loadTagTitlesForDate(date)
    ]);
  }

  // ==========================================================================
  // 保存（按日期）
  // ==========================================================================
  async function saveStocksForDate(date) {
    if (!date) return;
    const list = _stocksMemCache[date];
    if (!Array.isArray(list)) return;
    try {
      const sb = getSupabase();
      // 先删后插：保证该日期股票清单与本地一致
      await sb.from('stocks_data').delete().eq('date', date);
      if (list.length > 0) {
        const rows = list.filter(s => s && s.name).map(s => _stockToRow(date, s));
        if (rows.length > 0) {
          await sb.from('stocks_data').insert(rows);
        }
      }
      _lastPushed.stocks[date] = JSON.stringify(list);
    } catch (e) {
      _warn('saveStocksForDate ' + date + ' 失败: ' + (e.message || e));
      throw e;
    }
  }

  async function saveRankForDate(date) {
    if (!date) return;
    const data = _rankMemCache[date] || [];
    try {
      const sb = getSupabase();
      await sb.from('rank_data').upsert({ date, data }, { onConflict: 'date' });
      _lastPushed.rank[date] = JSON.stringify(data);
    } catch (e) {
      _warn('saveRankForDate ' + date + ' 失败: ' + (e.message || e));
      throw e;
    }
  }

  async function saveMultiForDate(date) {
    if (!date) return;
    const data = _multiMemCache[date] || [];
    try {
      const sb = getSupabase();
      await sb.from('multi_data').upsert({ date, data }, { onConflict: 'date' });
      _lastPushed.multi[date] = JSON.stringify(data);
    } catch (e) {
      _warn('saveMultiForDate ' + date + ' 失败: ' + (e.message || e));
      throw e;
    }
  }

  async function saveHotspotForDate(date) {
    if (!date) return;
    const content = _hotspotMemCache[date] || '';
    try {
      const sb = getSupabase();
      await sb.from('hotspot_data').upsert({ date, content }, { onConflict: 'date' });
      _lastPushed.hotspot[date] = content;
    } catch (e) {
      _warn('saveHotspotForDate ' + date + ' 失败: ' + (e.message || e));
      throw e;
    }
  }

  async function savePatternForDate(date) {
    if (!date) return;
    const p = _patternMemCache[date] || { content: '', update: false, keep: false };
    try {
      const sb = getSupabase();
      await sb.from('pattern_data').upsert({
        date,
        content: p.content || '',
        update_flag: !!p.update,
        keep_flag: !!p.keep
      }, { onConflict: 'date' });
      _lastPushed.pattern[date] = JSON.stringify(p);
    } catch (e) {
      _warn('savePatternForDate ' + date + ' 失败: ' + (e.message || e));
      throw e;
    }
  }

  async function saveTagTitlesForDate(date) {
    if (!date) return;
    const data = _tagTitlesMemCache[date] || {
      recentMulti: { tags: [], active: {}, score: 0 },
      sectorEtf: { tags: [], active: {}, score: 0 },
      topicDirection: { tags: [], active: {}, score: 0 },
      consecutiveUp: { duoban: 0, bankuai: 0, ticai: 0 }
    };
    try {
      const sb = getSupabase();
      await sb.from('tag_titles_data').upsert({ date, data }, { onConflict: 'date' });
      _lastPushed.tagTitles[date] = JSON.stringify(data);
    } catch (e) {
      _warn('saveTagTitlesForDate ' + date + ' 失败: ' + (e.message || e));
      throw e;
    }
  }

  // ==========================================================================
  // 脏标记 + 推送调度
  // ==========================================================================
  function markRemainingDirty(module, date) {
    if (!module || !date || !_dirty[module]) return;
    _dirty[module].add(date);
  }

  function markAllRemainingDirty(date) {
    if (!date) return;
    MODULE_KEYS.forEach(key => _dirty[key].add(date));
  }

  // 扫描 stocks 缓存，把所有与上次推送不一致的日期标脏
  function scanStocksDirty() {
    Object.keys(_stocksMemCache).forEach(date => {
      if (!_isDateKey(date)) return;
      const snap = JSON.stringify(_stocksMemCache[date]);
      if (_lastPushed.stocks[date] !== snap) {
        _dirty.stocks.add(date);
      }
    });
  }

  async function pushAllRemainingDirty() {
    if (_isPushing) return;
    _isPushing = true;
    try {
      scanStocksDirty();
      const tasks = [];
      MODULE_KEYS.forEach(key => {
        _dirty[key].forEach(date => {
          if (key === 'stocks') tasks.push(saveStocksForDate(date).then(() => _dirty.stocks.delete(date)).catch(() => {}));
          else if (key === 'rank') tasks.push(saveRankForDate(date).then(() => _dirty.rank.delete(date)).catch(() => {}));
          else if (key === 'multi') tasks.push(saveMultiForDate(date).then(() => _dirty.multi.delete(date)).catch(() => {}));
          else if (key === 'hotspot') tasks.push(saveHotspotForDate(date).then(() => _dirty.hotspot.delete(date)).catch(() => {}));
          else if (key === 'pattern') tasks.push(savePatternForDate(date).then(() => _dirty.pattern.delete(date)).catch(() => {}));
          else if (key === 'tagTitles') tasks.push(saveTagTitlesForDate(date).then(() => _dirty.tagTitles.delete(date)).catch(() => {}));
        });
      });
      if (tasks.length > 0) {
        await Promise.all(tasks);
        if (typeof _dbgLog === 'function') _dbgLog('[RB] 已推送 ' + tasks.length + ' 个脏日期到 Supabase');
      }
    } finally {
      _isPushing = false;
    }
  }

  function scheduleRemainingPush() {
    if (_pushDebounceTimer) clearTimeout(_pushDebounceTimer);
    _pushDebounceTimer = setTimeout(() => {
      pushAllRemainingDirty().catch(e => _warn('scheduleRemainingPush error: ' + (e.message || e)));
    }, 1200);
  }

  // 立即推送（用户显式保存、切换日期等场景）
  function pushRemainingNow(date) {
    if (date) markAllRemainingDirty(date);
    if (_pushDebounceTimer) clearTimeout(_pushDebounceTimer);
    pushAllRemainingDirty().catch(e => _warn('pushRemainingNow error: ' + (e.message || e)));
  }

  // ==========================================================================
  // 日期同步
  // ==========================================================================
  function _currentDate() {
    if (typeof currentDate !== 'undefined' && currentDate) return currentDate;
    if (typeof auctionStore !== 'undefined' && auctionStore && auctionStore.currentDate) return auctionStore.currentDate;
    return null;
  }

  async function _onDateChanged(date) {
    if (!date || date === _lastLoadDate) return;
    _lastLoadDate = date;
    // 切换日期前先把旧日期的脏数据推掉
    pushRemainingNow();
    // 拉取新日期数据
    await loadAllRemainingForDate(date);
    // 触发渲染（如果渲染函数已就绪）
    if (typeof renderList === 'function') renderList();
    if (typeof renderRank === 'function') renderRank();
    if (typeof renderMulti === 'function') renderMulti();
    if (typeof renderHotspot === 'function') renderHotspot();
    if (typeof renderPattern === 'function') renderPattern();
    if (typeof renderTagTitles === 'function') renderTagTitles();
  }

  function _watchDate() {
    // 全局 currentDate 是字符串，auctionStore.currentDate 是响应式
    let _last = _currentDate();
    if (_last) _onDateChanged(_last);

    // 轮询兜底（不依赖 Vue watch）
    setInterval(() => {
      const d = _currentDate();
      if (d && d !== _last) {
        _last = d;
        _onDateChanged(d);
      }
    }, 300);

    // 尝试监听 auctionStore
    if (typeof Vue !== 'undefined') {
      try {
        const { watch } = Vue;
        const tryWatch = () => {
          if (typeof auctionStore !== 'undefined' && auctionStore) {
            watch(() => auctionStore.currentDate, (val) => {
              if (val && val !== _last) {
                _last = val;
                _onDateChanged(val);
              }
            });
            return true;
          }
          return false;
        };
        if (!tryWatch()) {
          const timer = setInterval(() => {
            if (tryWatch()) clearInterval(timer);
          }, 200);
          setTimeout(() => clearInterval(timer), 10000);
        }
      } catch (e) {}
    }
  }

  // ==========================================================================
  // Realtime 订阅（多设备同步）
  // ==========================================================================
  function _subscribeRealtime() {
    try {
      const sb = getSupabase();
      const channel = sb.channel('remaining-boards-changes')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'stocks_data' }, (payload) => {
          const date = payload.new && payload.new.date;
          if (date && date !== _currentDate()) {
            loadStocksForDate(date);
          } else if (date) {
            loadStocksForDate(date).then(() => { if (typeof renderList === 'function') renderList(); });
          }
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'rank_data' }, (payload) => {
          const date = payload.new && payload.new.date;
          if (date === _currentDate()) loadRankForDate(date).then(() => { if (typeof renderRank === 'function') renderRank(); });
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'multi_data' }, (payload) => {
          const date = payload.new && payload.new.date;
          if (date === _currentDate()) loadMultiForDate(date).then(() => { if (typeof renderMulti === 'function') renderMulti(); });
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'hotspot_data' }, (payload) => {
          const date = payload.new && payload.new.date;
          if (date === _currentDate()) loadHotspotForDate(date).then(() => { if (typeof renderHotspot === 'function') renderHotspot(); });
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'pattern_data' }, (payload) => {
          const date = payload.new && payload.new.date;
          if (date === _currentDate()) loadPatternForDate(date).then(() => { if (typeof renderPattern === 'function') renderPattern(); });
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'tag_titles_data' }, (payload) => {
          const date = payload.new && payload.new.date;
          if (date === _currentDate()) loadTagTitlesForDate(date).then(() => { if (typeof renderTagTitles === 'function') renderTagTitles(); });
        })
        .subscribe();
    } catch (e) {
      _warn('Realtime 订阅失败: ' + (e.message || e));
    }
  }

  // ==========================================================================
  // 暴露给 index.html 的接口
  // ==========================================================================
  window.remainingBoards = {
    markDirty: markRemainingDirty,
    markAllDirty: markAllRemainingDirty,
    schedulePush: scheduleRemainingPush,
    pushNow: pushRemainingNow,
    loadForDate: loadAllRemainingForDate,
    loadStocks: loadStocksForDate,
    saveStocks: saveStocksForDate,
    caches: _caches
  };

  // ==========================================================================
  // 初始化
  // ==========================================================================
  function _init() {
    // 先同步把 localStorage 旧数据读到内存缓存，保证首屏不空白
    preloadLegacyToCaches();

    // 异步迁移 + 加载当前日期
    (async () => {
      const d = _currentDate();
      if (d) {
        // 拉取云端数据覆盖缓存；若云端无数据则保留本地预加载的数据
        await loadAllRemainingForDate(d);
      }
      try {
        await migrateLegacyBoardsToSupabase();
      } catch (e) {
        _warn('迁移失败: ' + (e.message || e));
      }
      // 迁移后再拉一次，确保多设备同步的最新数据被合并
      if (d) await loadAllRemainingForDate(d);
    })().then(() => {
      _watchDate();
      _subscribeRealtime();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    _init();
  }
})();
