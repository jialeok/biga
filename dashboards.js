/**
 * dashboards.js
 * 独立看板模块：最近多板 + 早盘板块ETF表现
 * - 不依赖 allData 全量加载
 * - 各自直接读写 Supabase 独立表
 * - Vue 3 响应式渲染
 * - 早盘板块ETF自动从 bidding_data 板块ETF(48)收盘同步
 */
(function () {
  'use strict';

  const { createApp, ref, computed, watch, reactive, onMounted, nextTick } = Vue;

  const SUPABASE_URL = 'https://tonqfgeyxnnwicjopshn.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRvbnFmZ2V5eG5ud2ljam9wc2huIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2NjY3NzEsImV4cCI6MjA5NDI0Mjc3MX0.el-W10JIjr9iQXEKNxV7nLNdhZfOQp6waTY7ZSH27Jg';

  let _supabaseClient = null;
  function getSupabase() {
    if (!_supabaseClient) {
      _supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    }
    return _supabaseClient;
  }

  function formatNowIso() {
    return new Date().toISOString();
  }

  // 保持与旧版 localStorage 格式兼容，供统计/清除/导入导出复用
  function legacyKey(name) {
    return name;
  }

  function readLegacyObject(key) {
    try {
      return JSON.parse(localStorage.getItem(key) || '{}');
    } catch (e) {
      return {};
    }
  }

  function writeLegacyObject(key, obj) {
    localStorage.setItem(key, JSON.stringify(obj));
  }

  function legacyRowFromData(data) {
    if (!data) return null;
    return {
      shuliang: data.shuliang || '',
      dieZhangbi: data.die_zhangbi || '',
      jingtu: data.jingtu || '',
      tushi: data.tushi || ''
    };
  }

  function syncToLegacyStorage() {
    const date = boardStore.currentDate;
    if (!date) return;

    const recentRow = legacyRowFromData(boardStore.recentMulti);
    const duibanData = readLegacyObject('duibanData');
    if (recentRow && (recentRow.shuliang || recentRow.dieZhangbi || recentRow.jingtu || recentRow.tushi)) {
      duibanData[date] = [recentRow];
    } else {
      delete duibanData[date];
    }
    writeLegacyObject('duibanData', duibanData);

    const duibanComment = readLegacyObject('duibanComment');
    if (boardStore.recentMulti && boardStore.recentMulti.comment) {
      duibanComment[date] = boardStore.recentMulti.comment;
    } else {
      delete duibanComment[date];
    }
    writeLegacyObject('duibanComment', duibanComment);

    const etfRow = legacyRowFromData(boardStore.earlyEtf);
    const etfData = readLegacyObject('stockEtfData');
    if (etfRow && (etfRow.shuliang || etfRow.dieZhangbi || etfRow.jingtu || etfRow.tushi)) {
      etfData[date] = [etfRow];
    } else {
      delete etfData[date];
    }
    writeLegacyObject('stockEtfData', etfData);

    const etfComment = readLegacyObject('stockEtfComment');
    if (boardStore.earlyEtf && boardStore.earlyEtf.comment) {
      etfComment[date] = boardStore.earlyEtf.comment;
    } else {
      delete etfComment[date];
    }
    writeLegacyObject('stockEtfComment', etfComment);
  }

  function migrateLegacyToSupabase(date) {
    const duibanData = readLegacyObject('duibanData');
    const duibanComment = readLegacyObject('duibanComment');
    const etfData = readLegacyObject('stockEtfData');
    const etfComment = readLegacyObject('stockEtfComment');

    const duibanList = duibanData[date] || [];
    const firstDuiban = duibanList[0] || {};
    const parsedD = parseDieZhangbi(firstDuiban.dieZhangbi);

    const etfList = etfData[date] || [];
    const firstEtf = etfList[0] || {};
    const parsedE = parseDieZhangbi(firstEtf.dieZhangbi);

    return {
      recentMulti: firstDuiban.shuliang || firstDuiban.dieZhangbi || firstDuiban.jingtu || firstDuiban.tushi || duibanComment[date]
        ? {
            date,
            shuliang: firstDuiban.shuliang || '',
            die_count: parsedD.die,
            zhang_count: parsedD.zhang,
            die_zhangbi: firstDuiban.dieZhangbi || '',
            jingtu: firstDuiban.jingtu || '',
            tushi: firstDuiban.tushi || '',
            comment: duibanComment[date] || ''
          }
        : null,
      earlyEtf: firstEtf.shuliang || firstEtf.dieZhangbi || firstEtf.jingtu || firstEtf.tushi || etfComment[date]
        ? {
            date,
            shuliang: firstEtf.shuliang || '',
            die_count: parsedE.die,
            zhang_count: parsedE.zhang,
            die_zhangbi: firstEtf.dieZhangbi || '',
            jingtu: firstEtf.jingtu || '',
            tushi: firstEtf.tushi || '',
            comment: etfComment[date] || ''
          }
        : null
    };
  }

  function parseDieZhangbi(val) {
    if (!val || !String(val).includes(':')) return { die: null, zhang: null };
    const [d, z] = String(val).split(':');
    return { die: parseInt(d, 10) || 0, zhang: parseInt(z, 10) || 0 };
  }

  function buildDieZhangbi(die, zhang) {
    if (die === '' || die === null || die === undefined || zhang === '' || zhang === null || zhang === undefined) return '';
    return `${die}:${zhang}`;
  }

  // 通用 toast（优先用页面已有 showToast）
  function toast(msg, ok) {
    if (typeof showToast === 'function') {
      showToast(msg);
    } else {
      console.log('[Board]', msg);
    }
  }

  // 持久化错误提示（优先用页面已有 showWarningToast）
  function warnToast(msg, duration) {
    if (typeof showWarningToast === 'function') {
      showWarningToast(msg, duration || 6000);
    } else {
      console.warn('[Board]', msg);
    }
  }

  // ==========================================================================
  // 共享 Store
  // ==========================================================================
  const boardStore = reactive({
    currentDate: '',
    recentMulti: null, // { date, shuliang, die_count, zhang_count, die_zhangbi, jingtu, tushi, comment, updated_at }
    earlyEtf: null,
    loadingRecent: false,
    loadingEtf: false,
    savingRecent: false,
    savingEtf: false,
    realtimeReady: false,
    lastError: ''
  });

  // 与现有 auctionStore.currentDate 双向同步
  function syncDateFromAuctionStore() {
    if (typeof auctionStore !== 'undefined' && auctionStore && auctionStore.currentDate) {
      boardStore.currentDate = auctionStore.currentDate;
    } else if (typeof currentDate !== 'undefined' && currentDate) {
      boardStore.currentDate = currentDate;
    }
  }

  let _dateWatchStarted = false;
  function ensureDateWatch() {
    if (_dateWatchStarted) return;
    _dateWatchStarted = true;
    // 监听 auctionStore 日期变化（动态，避免 dashboards.js 加载时 auctionStore 尚未定义）
    const tryWatchAuctionStore = () => {
      if (typeof auctionStore !== 'undefined' && auctionStore) {
        watch(() => auctionStore.currentDate, (val) => {
          if (val && val !== boardStore.currentDate) {
            boardStore.currentDate = val;
          }
        });
        return true;
      }
      return false;
    };
    if (!tryWatchAuctionStore()) {
      const timer = setInterval(() => {
        if (tryWatchAuctionStore()) clearInterval(timer);
      }, 200);
      setTimeout(() => clearInterval(timer), 10000);
    }

    // 监听 boardStore.currentDate 变化时拉取数据
    watch(() => boardStore.currentDate, (date) => {
      if (!date) return;
      loadRecentMulti(date);
      loadEarlyEtf(date);
      trySyncEtfFromBiddingClose(date);
    });
  }

  // ==========================================================================
  // Supabase 原子操作
  // ==========================================================================

  async function loadRecentMulti(date) {
    if (!date) return;
    boardStore.loadingRecent = true;
    try {
      const sb = getSupabase();
      const { data, error } = await sb
        .from('recent_multi_data')
        .select('*')
        .eq('date', date)
        .maybeSingle();
      if (error) throw error;
      if (!data) {
        // 迁移：若云端无数据，尝试从旧版 localStorage 读取并上传
        const legacy = migrateLegacyToSupabase(date);
        if (legacy.recentMulti) {
          boardStore.recentMulti = legacy.recentMulti;
          syncToLegacyStorage();
          // 后台静默上传到 Supabase
          saveRecentMulti(legacy.recentMulti).catch(() => {});
        } else {
          boardStore.recentMulti = null;
        }
      } else {
        boardStore.recentMulti = data;
        syncToLegacyStorage();
      }
    } catch (e) {
      boardStore.lastError = '最近多板加载失败: ' + (e.message || e);
      console.warn('[Board] loadRecentMulti error:', e);
    } finally {
      boardStore.loadingRecent = false;
    }
  }

  async function loadEarlyEtf(date) {
    if (!date) return;
    boardStore.loadingEtf = true;
    try {
      const sb = getSupabase();
      const { data, error } = await sb
        .from('early_etf_data')
        .select('*')
        .eq('date', date)
        .maybeSingle();
      if (error) throw error;
      if (!data) {
        const legacy = migrateLegacyToSupabase(date);
        if (legacy.earlyEtf) {
          boardStore.earlyEtf = legacy.earlyEtf;
          syncToLegacyStorage();
          saveEarlyEtf(legacy.earlyEtf).catch(() => {});
        } else {
          boardStore.earlyEtf = null;
        }
      } else {
        boardStore.earlyEtf = data;
        syncToLegacyStorage();
      }
    } catch (e) {
      boardStore.lastError = 'ETF 加载失败: ' + (e.message || e);
      console.warn('[Board] loadEarlyEtf error:', e);
    } finally {
      boardStore.loadingEtf = false;
    }
  }

  async function saveRecentMulti(payload) {
    const date = boardStore.currentDate;
    if (!date) return { error: '无当前日期' };
    boardStore.savingRecent = true;
    try {
      const sb = getSupabase();
      const row = {
        date,
        shuliang: payload.shuliang || '',
        die_count: payload.die_count ?? null,
        zhang_count: payload.zhang_count ?? null,
        die_zhangbi: payload.die_zhangbi || '',
        jingtu: payload.jingtu || '',
        tushi: payload.tushi || '',
        comment: payload.comment || '',
        updated_at: formatNowIso()
      };
      const { data, error } = await sb
        .from('recent_multi_data')
        .upsert(row, { onConflict: 'date' })
        .select()
        .single();
      if (error) throw error;
      boardStore.recentMulti = data;
      syncToLegacyStorage();
      return { data, error: null };
    } catch (e) {
      boardStore.lastError = '最近多板保存失败: ' + (e.message || e);
      return { error: e };
    } finally {
      boardStore.savingRecent = false;
    }
  }

  async function saveEarlyEtf(payload) {
    const date = boardStore.currentDate;
    if (!date) return { error: '无当前日期' };
    boardStore.savingEtf = true;
    try {
      const sb = getSupabase();
      const row = {
        date,
        shuliang: payload.shuliang || '',
        die_count: payload.die_count ?? null,
        zhang_count: payload.zhang_count ?? null,
        die_zhangbi: payload.die_zhangbi || '',
        jingtu: payload.jingtu || '',
        tushi: payload.tushi || '',
        comment: payload.comment || '',
        sector_etf_close: payload.sector_etf_close ?? boardStore.earlyEtf?.sector_etf_close ?? null,
        sector_etf_synced_at: payload.sector_etf_synced_at ?? boardStore.earlyEtf?.sector_etf_synced_at ?? null,
        updated_at: formatNowIso()
      };
      const { data, error } = await sb
        .from('early_etf_data')
        .upsert(row, { onConflict: 'date' })
        .select()
        .single();
      if (error) throw error;
      boardStore.earlyEtf = data;
      syncToLegacyStorage();
      return { data, error: null };
    } catch (e) {
      boardStore.lastError = 'ETF 保存失败: ' + (e.message || e);
      return { error: e };
    } finally {
      boardStore.savingEtf = false;
    }
  }

  // 从 bidding_data 拉取板块ETF(48)的收盘值
  async function fetchSectorEtfCloseFromBidding(date) {
    if (!date) return null;
    try {
      const sb = getSupabase();
      const { data, error } = await sb
        .from('bidding_data')
        .select('name, close, time930')
        .eq('date', date);
      if (error) throw error;
      const row = (data || []).find(r => r && r.name && r.name.includes('板块ETF'));
      if (!row) return null;
      const val = (row.close && String(row.close).trim())
        ? String(row.close).trim()
        : (row.time930 && String(row.time930).trim())
          ? String(row.time930).trim()
          : null;
      return val;
    } catch (e) {
      console.warn('[Board] fetchSectorEtfCloseFromBidding error:', e);
      return null;
    }
  }

  // 尝试把 bidding_data 板块ETF收盘同步到 early_etf_data
  // 只在收盘后（北京时间 >= 15:00）或 close 有值时才执行
  async function trySyncEtfFromBiddingClose(date) {
    if (!date) return;
    const closeVal = await fetchSectorEtfCloseFromBidding(date);
    if (!closeVal) return;

    const zhang = parseInt(closeVal, 10);
    if (isNaN(zhang)) return;

    // 如果当前已有 early_etf_data，且涨数一致、且已有同步时间，则跳过
    const existing = boardStore.earlyEtf;
    if (existing && existing.sector_etf_close === closeVal && existing.sector_etf_synced_at) return;

    const total = existing && existing.shuliang ? parseInt(existing.shuliang, 10) || 48 : 48;
    const die = Math.max(0, total - zhang);

    await saveEarlyEtf({
      shuliang: String(total),
      die_count: die,
      zhang_count: zhang,
      die_zhangbi: buildDieZhangbi(die, zhang),
      jingtu: existing?.jingtu || '',
      tushi: existing?.tushi || '',
      comment: existing?.comment || '',
      sector_etf_close: closeVal,
      sector_etf_synced_at: formatNowIso()
    });
    toast('✅ 已根据竞价变化板块ETF收盘同步 ETF 数据', true);
  }

  // ==========================================================================
  // Realtime 订阅
  // ==========================================================================
  let recentChannel = null;
  let etfChannel = null;

  function startRealtime() {
    stopRealtime();
    try {
      const sb = getSupabase();
      recentChannel = sb
        .channel('recent_multi_data_changes')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'recent_multi_data' }, (payload) => {
          const row = payload.new || payload.old;
          if (row && row.date === boardStore.currentDate) {
            loadRecentMulti(boardStore.currentDate);
          }
        })
        .subscribe();
      etfChannel = sb
        .channel('early_etf_data_changes')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'early_etf_data' }, (payload) => {
          const row = payload.new || payload.old;
          if (row && row.date === boardStore.currentDate) {
            loadEarlyEtf(boardStore.currentDate);
          }
        })
        .subscribe();
      boardStore.realtimeReady = true;
    } catch (e) {
      console.warn('[Board] realtime subscribe failed:', e);
    }
  }

  function stopRealtime() {
    try {
      const sb = getSupabase();
      if (recentChannel) { sb.removeChannel(recentChannel); recentChannel = null; }
      if (etfChannel) { sb.removeChannel(etfChannel); etfChannel = null; }
    } catch (e) {}
  }

  // ==========================================================================
  // Vue 组件
  // ==========================================================================

  const boardStyles = `
    .board-modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.45); z-index: 1010; display: flex; align-items: center; justify-content: center; padding: 16px; }
    .board-modal { background: #fff; border-radius: 16px; width: 100%; max-width: 400px; max-height: 85vh; display: flex; flex-direction: column; box-shadow: 0 10px 40px rgba(0,0,0,0.15); }
    .board-modal-header { padding: 16px; border-bottom: 1px solid #f1f5f9; font-weight: 600; font-size: 15px; }
    .board-modal-body { padding: 16px; overflow-y: auto; }
    .board-modal-footer { padding: 12px 16px 16px; display: flex; gap: 10px; }
    .board-input { width: 100%; padding: 8px 10px; border: 1px solid #e2e8f0; border-radius: 8px; font-size: 13px; box-sizing: border-box; }
    .board-input:focus { outline: none; border-color: #3b82f6; }
    .board-form-row { display: flex; gap: 8px; margin-bottom: 10px; align-items: center; }
    .board-form-label { font-size: 12px; color: #64748b; width: 60px; flex-shrink: 0; }
    .board-btn { flex: 1; padding: 12px; border-radius: 10px; border: none; font-size: 14px; font-weight: 600; cursor: pointer; }
    .board-btn-primary { background: #3b82f6; color: #fff; }
    .board-btn-danger { background: #ef4444; color: #fff; }
    .board-btn:disabled { opacity: 0.6; cursor: not-allowed; }
    .board-hint { font-size: 11px; color: #94a3b8; margin-top: 4px; }
  `;

  function renderTushi(tushi) {
    if (!tushi) return '';
    if (tushi.startsWith('http://') || tushi.startsWith('https://')) {
      const text = tushi.includes('shimo.im') ? '📄 查看石墨' : '打开链接';
      return `<a href="${tushi}" target="_blank" onclick="event.stopPropagation()">${text}</a>`;
    }
    return tushi;
  }

  const BoardCard = {
    props: ['title', 'data', 'loading', 'defaultTotal', 'kind'],
    emits: ['edit', 'editComment'],
    setup(props, { emit }) {
      const hasData = computed(() => props.data && (props.data.shuliang || props.data.die_zhangbi || props.data.jingtu || props.data.tushi));
      return { hasData, renderTushi };
    },
    template: `
      <div :class="kind + '-header'" @dblclick.stop="$emit('edit')">
        <div>
          <div :class="kind + '-title'">{{ title }}</div>
          <div :class="kind + '-subtitle'"></div>
        </div>
      </div>
      <div :class="kind + '-content'" @dblclick.stop="$emit('edit')">
        <div :class="kind + '-scroll-container'">
          <div :class="kind + '-header-row'">
            <div :class="kind + '-header-item ' + kind + '-header-shuliang'">总数量</div>
            <div :class="kind + '-header-item ' + kind + '-header-dieZhangbi'">跌涨比</div>
            <div :class="kind + '-header-item ' + kind + '-header-jingtu'">竞符合数</div>
            <div :class="kind + '-header-item ' + kind + '-header-tushi'">图示</div>
          </div>
          <div v-if="!hasData" :class="kind + '-empty'">暂无数据，点击添加...</div>
          <div v-else :class="kind + '-row'">
            <div :class="kind + '-item ' + kind + '-item-shuliang'">{{ data.shuliang || '' }}</div>
            <div :class="kind + '-item ' + kind + '-item-dieZhangbi'">{{ data.die_zhangbi || '' }}</div>
            <div :class="kind + '-item ' + kind + '-item-jingtu'">{{ data.jingtu || '' }}</div>
            <div :class="kind + '-item ' + kind + '-item-tushi'" v-html="renderTushi(data.tushi)"></div>
          </div>
        </div>
      </div>
      <div :class="kind + '-comment-display'" @click.stop="$emit('editComment')">
        <span v-if="!data || !data.comment" :class="kind + '-comment-placeholder'">暂无评论，点击添加...</span>
        <span v-else>{{ data.comment }}</span>
      </div>
    `
  };

  const EditModal = {
    props: ['show', 'title', 'data', 'defaultTotal', 'saving'],
    emits: ['close', 'save'],
    setup(props, { emit }) {
      const form = reactive({
        shuliang: '',
        die: '',
        zhang: '',
        die_zhangbi: '',
        jingtu: '',
        tushi: '',
        comment: ''
      });

      watch(() => props.show, (visible) => {
        if (visible) {
          const d = props.data || {};
          const parsed = parseDieZhangbi(d.die_zhangbi);
          form.shuliang = d.shuliang || '';
          form.die = parsed.die !== null ? String(parsed.die) : '';
          form.zhang = parsed.zhang !== null ? String(parsed.zhang) : '';
          form.die_zhangbi = d.die_zhangbi || '';
          form.jingtu = d.jingtu || '';
          form.tushi = d.tushi || '';
          form.comment = d.comment || '';
          if (!form.shuliang && props.defaultTotal) {
            form.shuliang = String(props.defaultTotal);
          }
        }
      });

      function updateFromDie() {
        const total = parseInt(form.shuliang, 10) || props.defaultTotal;
        const die = parseInt(form.die, 10);
        if (!isNaN(die) && total) {
          const zhang = Math.max(0, total - die);
          form.zhang = String(zhang);
        }
      }

      function updateFromZhang() {
        const total = parseInt(form.shuliang, 10) || props.defaultTotal;
        const zhang = parseInt(form.zhang, 10);
        if (!isNaN(zhang) && total) {
          const die = Math.max(0, total - zhang);
          form.die = String(die);
        }
      }

      function updateFromTotal() {
        const total = parseInt(form.shuliang, 10);
        if (!total) return;
        const die = form.die !== '' ? parseInt(form.die, 10) : NaN;
        const zhang = form.zhang !== '' ? parseInt(form.zhang, 10) : NaN;
        if (!isNaN(die) && isNaN(zhang)) {
          form.zhang = String(Math.max(0, total - die));
        } else if (isNaN(die) && !isNaN(zhang)) {
          form.die = String(Math.max(0, total - zhang));
        }
      }

      function submit() {
        const total = parseInt(form.shuliang, 10) || props.defaultTotal;
        const die = parseInt(form.die, 10) || 0;
        const zhang = parseInt(form.zhang, 10) || 0;
        emit('save', {
          shuliang: String(total),
          die_count: die,
          zhang_count: zhang,
          die_zhangbi: buildDieZhangbi(die, zhang),
          jingtu: form.jingtu.trim(),
          tushi: form.tushi.trim(),
          comment: form.comment.trim()
        });
      }

      return { form, updateFromDie, updateFromZhang, updateFromTotal, submit };
    },
    template: `
      <div v-if="show" class="board-modal-backdrop" @click.self="$emit('close')">
        <div class="board-modal">
          <div class="board-modal-header">编辑 {{ title }}</div>
          <div class="board-modal-body">
            <div class="board-form-row">
              <span class="board-form-label">总数量</span>
              <input class="board-input" type="text" inputmode="numeric" v-model="form.shuliang" @input="updateFromTotal" placeholder="总数量">
            </div>
            <div class="board-form-row">
              <span class="board-form-label">跌 : 涨</span>
              <input class="board-input" type="text" inputmode="numeric" v-model="form.die" @input="updateFromDie" placeholder="跌" style="flex:1">
              <span style="color:#94a3b8">:</span>
              <input class="board-input" type="text" inputmode="numeric" v-model="form.zhang" @input="updateFromZhang" placeholder="涨" style="flex:1">
            </div>
            <div class="board-form-row">
              <span class="board-form-label">竞符合数</span>
              <input class="board-input" type="text" v-model="form.jingtu" placeholder="竞符合数">
            </div>
            <div class="board-form-row">
              <span class="board-form-label">图示</span>
              <input class="board-input" type="text" v-model="form.tushi" placeholder="石墨链接/图示">
            </div>
            <div class="board-form-row" style="flex-direction:column;align-items:flex-start;gap:4px">
              <span class="board-form-label" style="width:auto">评论</span>
              <textarea class="board-input" v-model="form.comment" rows="4" placeholder="输入评论..."></textarea>
            </div>
            <div class="board-hint">总数量默认 {{ defaultTotal }}，输入涨/跌或总数会自动计算另一方。</div>
          </div>
          <div class="board-modal-footer">
            <button class="board-btn board-btn-primary" :disabled="saving" @click="submit">{{ saving ? '保存中...' : '保存' }}</button>
            <button class="board-btn" style="background:#f1f5f9;color:#475569" @click="$emit('close')">取消</button>
          </div>
        </div>
      </div>
    `
  };

  // ==========================================================================
  // 挂载两个 Vue 应用（分别挂在现有 board 容器内）
  // ==========================================================================

  function createBoardApp(title, storeKey, defaultTotal, saveFn, kind) {
    return createApp({
      components: { BoardCard, EditModal },
      setup() {
        const showModal = ref(false);
        const data = computed(() => boardStore[storeKey]);
        const loading = computed(() => boardStore.loadingRecent || boardStore.loadingEtf);
        const saving = computed(() => boardStore.savingRecent || boardStore.savingEtf);

        async function handleSave(payload) {
          const { error } = await saveFn(payload);
          if (error) {
            warnToast('保存失败: ' + (error.message || error));
          } else {
            toast('✅ 已保存');
            showModal.value = false;
          }
        }

        return {
          title,
          data,
          loading,
          saving,
          showModal,
          defaultTotal,
          kind,
          handleSave
        };
      },
      template: `
        <BoardCard
          :title="title"
          :data="data"
          :loading="loading"
          :default-total="defaultTotal"
          :kind="kind"
          @edit="showModal = true"
          @editComment="showModal = true"
        />
        <EditModal
          :show="showModal"
          :title="title"
          :data="data"
          :default-total="defaultTotal"
          :saving="saving"
          @close="showModal = false"
          @save="handleSave"
        />
      `
    });
  }

  // 注入组件级 CSS（仅一次）
  function injectStylesOnce() {
    if (document.getElementById('board-dashboard-styles')) return;
    const style = document.createElement('style');
    style.id = 'board-dashboard-styles';
    style.textContent = boardStyles;
    document.head.appendChild(style);
  }

  function mountBoards() {
    injectStylesOnce();

    const duibanEl = document.querySelector('.duiban-board.trading-day-element');
    const etfEl = document.querySelector('.etf-board.trading-day-element');

    if (duibanEl) {
      duibanEl.innerHTML = '<div id="duiban-vue-root"></div>';
      createBoardApp('最近多板', 'recentMulti', 56, saveRecentMulti, 'duiban')
        .mount('#duiban-vue-root');
    }

    if (etfEl) {
      etfEl.innerHTML = '<div id="etf-vue-root"></div>';
      createBoardApp('早盘板块ETF表现', 'earlyEtf', 48, saveEarlyEtf, 'etf')
        .mount('#etf-vue-root');
    }

    ensureDateWatch();
    syncDateFromAuctionStore();
    startRealtime();
  }

  // DOM 就绪后挂载
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountBoards);
  } else {
    mountBoards();
  }

  // ==========================================================================
  // 对外 API（兼容旧代码调用）
  // ==========================================================================
  window.boardStore = boardStore;

  function dispatchBoardDblClick(selector) {
    nextTick(() => {
      const el = document.querySelector(selector + ' .board-content') || document.querySelector(selector);
      if (el) el.dispatchEvent(new Event('dblclick', { bubbles: true }));
    });
  }

  window.boardApi = {
    refresh: () => {
      syncDateFromAuctionStore();
      if (boardStore.currentDate) {
        loadRecentMulti(boardStore.currentDate);
        loadEarlyEtf(boardStore.currentDate);
      }
    },
    loadRecentMulti,
    loadEarlyEtf,
    saveRecentMulti,
    saveEarlyEtf,
    syncEtfFromBiddingClose: trySyncEtfFromBiddingClose,
    recalcDuibanFromAuction: async (total, fallCount, riseCount) => {
      // 由外部早盘竞价统计调用，直接原子写入 recent_multi_data
      if (!boardStore.currentDate) return;
      const existing = boardStore.recentMulti || {};
      await saveRecentMulti({
        shuliang: String(total),
        die_count: fallCount,
        zhang_count: riseCount,
        die_zhangbi: buildDieZhangbi(fallCount, riseCount),
        jingtu: existing.jingtu || '',
        tushi: existing.tushi || '',
        comment: existing.comment || ''
      });
    },
    syncSectorEtfZhangNum: async (zhangNum) => {
      // 由外部竞价变化保存/抓取调用，直接原子写入 early_etf_data
      if (!boardStore.currentDate) return;
      const zhang = parseInt(zhangNum, 10) || 0;
      const existing = boardStore.earlyEtf || {};
      const total = existing.shuliang ? parseInt(existing.shuliang, 10) || 48 : 48;
      const die = Math.max(0, total - zhang);
      await saveEarlyEtf({
        shuliang: String(total),
        die_count: die,
        zhang_count: zhang,
        die_zhangbi: buildDieZhangbi(die, zhang),
        jingtu: existing.jingtu || '',
        tushi: existing.tushi || '',
        comment: existing.comment || '',
        sector_etf_close: String(zhang),
        sector_etf_synced_at: formatNowIso()
      });
    },
    openRecentMultiModal: () => dispatchBoardDblClick('#duiban-vue-root'),
    openEtfModal: () => dispatchBoardDblClick('#etf-vue-root')
  };

  // 覆盖旧版全局函数，确保所有旧调用都进入新的 Supabase 链路
  function installOverrides() {
    window.getTodayDuiban = function() {
      const d = boardStore.recentMulti;
      if (!d) return [];
      return [legacyRowFromData(d)];
    };

    window.getTodayDuibanComment = function() {
      return boardStore.recentMulti?.comment || '';
    };

    window.getEtfData = function() {
      const date = boardStore.currentDate;
      if (!date) return {};
      const obj = {};
      const d = boardStore.earlyEtf;
      if (d && (d.shuliang || d.die_zhangbi || d.jingtu || d.tushi)) {
        obj[date] = [legacyRowFromData(d)];
      }
      return obj;
    };

    window.getTodayEtf = function() {
      const d = boardStore.earlyEtf;
      if (!d) return [];
      return [legacyRowFromData(d)];
    };

    window.getTodayEtfComment = function() {
      return boardStore.earlyEtf?.comment || '';
    };

    window.saveTodayDuiban = function() {
      // 旧函数签名是 saveTodayDuiban(duibanList)，已无需主动调用
      console.warn('[Board] saveTodayDuiban 已弃用，数据直接写 Supabase');
    };

    window.renderDuiban = function() {
      // Vue 自动渲染，仅刷新数据
      if (boardStore.currentDate) loadRecentMulti(boardStore.currentDate);
    };

    window.renderEtf = function() {
      if (boardStore.currentDate) loadEarlyEtf(boardStore.currentDate);
    };

    window.openDuibanEdit = function() {
      boardApi.openRecentMultiModal();
    };

    window.openEtfEdit = function() {
      boardApi.openEtfModal();
    };

    window.openDuibanCommentEdit = function() {
      boardApi.openRecentMultiModal();
    };

    window.openEtfCommentEdit = function() {
      boardApi.openEtfModal();
    };

    window.saveDuiban = async function() {
      // 旧 modal 不再使用；若被触发，把表单值同步到 store 并保存
      const row = document.getElementById('duiban-row-0');
      if (!row) return;
      const die = (row.querySelector('[name="die-0"]')?.value || '').trim();
      const zhang = (row.querySelector('[name="zhang-0"]')?.value || '').trim();
      const total = (row.querySelector('[name="shuliang-0"]')?.value || '').trim();
      const jingtu = (row.querySelector('[name="jingtu-0"]')?.value || '').trim();
      const tushi = (row.querySelector('[name="tushi-0"]')?.value || '').trim();
      const nTotal = parseInt(total, 10) || 56;
      const nDie = parseInt(die, 10) || 0;
      const nZhang = parseInt(zhang, 10) || 0;
      await saveRecentMulti({
        shuliang: String(nTotal),
        die_count: nDie,
        zhang_count: nZhang,
        die_zhangbi: buildDieZhangbi(nDie, nZhang),
        jingtu,
        tushi,
        comment: boardStore.recentMulti?.comment || ''
      });
      if (typeof closeDuibanModal === 'function') closeDuibanModal();
    };

    window.saveEtf = async function() {
      const container = document.getElementById('etfEditTableBody');
      if (!container) return;
      const row = container.querySelector('.etf-edit-row');
      if (!row) return;
      const shuliang = (row.querySelector('[name^="shuliang-"]')?.value || '').trim();
      const zhang = (row.querySelector('[name^="zhang-"]')?.value || '').trim();
      const die = (row.querySelector('[name^="die-"]')?.value || '').trim();
      const jingtu = (row.querySelector('[name^="jingtu-"]')?.value || '').trim();
      const tushi = (row.querySelector('[name^="tushi-"]')?.value || '').trim();
      const nTotal = parseInt(shuliang, 10) || 48;
      const nZhang = parseInt(zhang, 10) || (die ? nTotal - parseInt(die, 10) : 0);
      const nDie = parseInt(die, 10) || Math.max(0, nTotal - nZhang);
      await saveEarlyEtf({
        shuliang: String(nTotal),
        die_count: nDie,
        zhang_count: nZhang,
        die_zhangbi: buildDieZhangbi(nDie, nZhang),
        jingtu,
        tushi,
        comment: boardStore.earlyEtf?.comment || ''
      });
      if (typeof closeEtfModal === 'function') closeEtfModal();
    };

    window.saveDuibanComment = async function() {
      const input = document.getElementById('duibanCommentInput');
      const comment = input ? input.value.trim() : '';
      const existing = boardStore.recentMulti || {};
      await saveRecentMulti({
        shuliang: existing.shuliang || '',
        die_count: existing.die_count ?? null,
        zhang_count: existing.zhang_count ?? null,
        die_zhangbi: existing.die_zhangbi || '',
        jingtu: existing.jingtu || '',
        tushi: existing.tushi || '',
        comment
      });
      if (typeof closeDuibanCommentModal === 'function') closeDuibanCommentModal();
    };

    window.saveEtfComment = async function() {
      const input = document.getElementById('etfCommentInput');
      const comment = input ? input.value.trim() : '';
      const existing = boardStore.earlyEtf || {};
      await saveEarlyEtf({
        shuliang: existing.shuliang || '',
        die_count: existing.die_count ?? null,
        zhang_count: existing.zhang_count ?? null,
        die_zhangbi: existing.die_zhangbi || '',
        jingtu: existing.jingtu || '',
        tushi: existing.tushi || '',
        comment
      });
      if (typeof closeEtfCommentModal === 'function') closeEtfCommentModal();
    };

    window.recalcDuibanFromAuction = async function() {
      // 保留原有语义：从早盘竞价列表统计后写入
      if (typeof getTodayAuction !== 'function') return;
      const auctionList = getTodayAuction();
      const total = auctionList.length;
      if (total === 0) return;
      let riseCount = 0;
      auctionList.forEach(item => {
        const note = item.note || '';
        if (note.includes('涨停')) { riseCount++; return; }
        if (note.includes('跌停')) return;
        const percentMatch = note.match(/-?\d+\.?\d*%/);
        if (percentMatch) {
          const value = parseFloat(percentMatch[0]);
          if (value > 0) riseCount++;
        }
      });
      await boardApi.recalcDuibanFromAuction(total, total - riseCount, riseCount);
    };

    window.syncSectorEtfZhangNum = async function(zhangNum) {
      await boardApi.syncSectorEtfZhangNum(zhangNum);
    };

    window.clearDuiban = async function() {
      if (!boardStore.currentDate) return;
      if (!confirm('确定要清除所有最近多板数据吗？')) return;
      try {
        const sb = getSupabase();
        await sb.from('recent_multi_data').delete().eq('date', boardStore.currentDate);
        boardStore.recentMulti = null;
        syncToLegacyStorage();
        toast('✅ 最近多板数据已清除');
      } catch (e) {
        warnToast('清除失败: ' + (e.message || e));
      }
    };

    window.clearEtf = async function() {
      if (!boardStore.currentDate) return;
      if (!confirm('确定要清除所有ETF数据吗？')) return;
      try {
        const sb = getSupabase();
        await sb.from('early_etf_data').delete().eq('date', boardStore.currentDate);
        boardStore.earlyEtf = null;
        syncToLegacyStorage();
        toast('✅ ETF数据已清除');
      } catch (e) {
        warnToast('清除失败: ' + (e.message || e));
      }
    };
  }

  installOverrides();
})();
