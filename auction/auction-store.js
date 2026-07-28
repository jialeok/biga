/**
 * auction-store.js
 * 早盘竞价看板统一状态层（彻底重构版）
 * - 所有 UI 状态集中在 auctionStore
 * - 数据层仍复用现有 _auctionMemCache / _hotAuctionData / getStocksData()
 * - 暴露 actions，供组件/遗留代码调用
 * - 与全局 currentGroup / currentDate 双向同步，确保 Vue 路径与遗留函数不撕裂
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const Vue = window.Vue || (typeof Vue !== 'undefined' ? Vue : null);
  if (!Vue) {
    console.warn('[AUCTION-STORE] Vue 未就绪，跳过 store 初始化');
    return;
  }

  const store = Vue.reactive({
    // 基础导航状态
    currentDate: window.currentDate || '',
    currentGroup: 'auction',          // 'auction' | 'hot'
    currentPage: 0,                   // 0=主列表, 1=题材分组, 2=第三页, 3=统计看板

    // 双数据源（核心架构）：标签/竞价/热门 镜像
    stocksData: {},                   // 标签唯一权威源镜像
    auctionData: {},                  // 竞价全量快照
    hotAuctionData: {},               // 热门股票快照

    // UI 状态
    expandedStocks: new Set(),
    p2ExpandedTopics: new Set(),
    highlightStock: '',

    // 排序状态（按 tab 隔离）
    sortState: {
      auction: { byData: false, byRatio: false, byParallel: false, byJingYest: false },
      hot: { byData: false, byRatio: false, byParallel: false, byJingYest: false }
    },
    sortStateP2: {
      auction: { byRatio: false, byParallel: false, byJingYest: false },
      hot: { byRatio: false, byParallel: false, byJingYest: false }
    },
    expandAll: false,
    expandAllP2: false,

    // 强度排序开关（镜像全局 isStrengthSortEnabled）
    strengthSortEnabled: false,

    // 加载状态
    auctionLoaded: false,
    hotLoaded: false,

    // stocksData 变更信号（兼容现有 compute*ViewData 的响应式触发）
    stocksDataVersion: 0,

    // actions（方法在下方绑定，避免 IIFE 内部循环引用）
    actions: null
  });

  // 获取当前 tab 的 key
  function tabKey() { return store.currentGroup === 'hot' ? 'hot' : 'auction'; }

  // 读取 DOM toggle 状态同步到 store（重构过渡期兼容）
  function syncToggleToStore(id, stateObj, key) {
    const el = document.getElementById(id);
    if (el) stateObj[key] = !!el.checked;
  }

  // 同步全局 currentGroup（index.html 中 let 声明）
  function syncGlobalCurrentGroup() {
    try { if (typeof currentGroup !== 'undefined' && currentGroup !== store.currentGroup) currentGroup = store.currentGroup; } catch (e) {}
  }

  // 同步全局 currentDate
  function syncGlobalCurrentDate() {
    try { if (typeof currentDate !== 'undefined' && currentDate !== store.currentDate) currentDate = store.currentDate; } catch (e) {}
  }

  // 安全触发全局 renderAuction（用于兼容旧函数或手动刷新）
  function triggerRender(caller) {
    try {
      if (typeof renderAuction === 'function') renderAuction(store.currentGroup);
    } catch (e) {
      console.warn('[AUCTION-STORE] triggerRender 失败:', e);
    }
  }

  const actions = {
    // 切换 tab
    switchGroup(group) {
      if (group !== 'auction' && group !== 'hot') return;
      store.currentGroup = group;
      store.currentPage = 0;
      syncGlobalCurrentGroup();
    },

    // 切换 page
    switchPage(page) {
      const p = parseInt(page, 10);
      if (isNaN(p) || p < 0 || p > 3) return;
      store.currentPage = p;
    },

    // 同步排序开关（从 DOM 读）
    syncSortStateFromDOM(page) {
      const t = tabKey();
      if (page === 1) {
        const s = store.sortState[t];
        syncToggleToStore(t + 'SortByDataToggle', s, 'byData');
        syncToggleToStore(t + 'SortByRatioToggle', s, 'byRatio');
        syncToggleToStore(t + 'SortByParallelToggle', s, 'byParallel');
        syncToggleToStore(t + 'SortByJingYestToggle', s, 'byJingYest');
      } else if (page === 2) {
        const s = store.sortStateP2[t];
        syncToggleToStore(t + 'SortByRatioToggle2', s, 'byRatio');
        syncToggleToStore(t + 'SortByParallelToggle2', s, 'byParallel');
        syncToggleToStore(t + 'SortByJingYestToggle2', s, 'byJingYest');
      }
    },

    // 设置排序开关（组件事件直接写 store）
    setSortState(page, key, value) {
      const t = tabKey();
      if (page === 1) {
        if (store.sortState[t]) store.sortState[t][key] = !!value;
      } else if (page === 2) {
        if (store.sortStateP2[t]) store.sortStateP2[t][key] = !!value;
      }
    },

    // 展开/收起趋势面板
    toggleTrendPanel(stockName) {
      if (!stockName) return;
      const set = store.expandedStocks;
      if (set.has(stockName)) set.delete(stockName); else set.add(stockName);
    },

    // page2 展开/收起题材
    toggleP2Topic(topic) {
      if (!topic) return;
      const set = store.p2ExpandedTopics;
      if (set.has(topic)) set.delete(topic); else set.add(topic);
    },

    // 全部展开/收起
    setExpandAll(value, page) {
      if (page === 2) store.expandAllP2 = !!value;
      else store.expandAll = !!value;
    },

    // 跨页高亮
    setHighlight(stockName) {
      store.highlightStock = stockName || '';
    },
    clearHighlight() {
      store.highlightStock = '';
    },

    // 选中/取消选中某行
    toggleRowSelect(index) {
      if (typeof toggleAuctionRowSelect === 'function') toggleAuctionRowSelect(index);
    },

    // 显示注释弹窗/输入
    showNotePopup(el, note) {
      if (typeof showAuctionNotePopup === 'function') showAuctionNotePopup(el, note);
    },
    showNoteInput(index, el) {
      if (typeof showAuctionNoteInput === 'function') showAuctionNoteInput(index, el);
    },

    // 打开编辑弹窗
    openEdit(dataSource) {
      if (dataSource === 'hot') { if (typeof openHotEdit === 'function') openHotEdit(); }
      else { if (typeof openAuctionEdit === 'function') openAuctionEdit(); }
    },

    // 跳转到 page2 并高亮
    jumpToPage2(stockName) {
      if (typeof jumpToAuctionPage2 === 'function') jumpToAuctionPage2(stockName);
    },

    // 买入提示
    showBuyPrompt(stockName) {
      if (typeof showAuctionBuyPrompt === 'function') showAuctionBuyPrompt(stockName);
    },

    // 更新日期（切换交易日时）
    setDate(date) {
      store.currentDate = date || '';
      store.expandedStocks.clear();
      store.p2ExpandedTopics.clear();
      store.highlightStock = '';
      // 排序开关重置为默认关闭
      ['auction', 'hot'].forEach(t => {
        store.sortState[t] = { byData: false, byRatio: false, byParallel: false, byJingYest: false };
        store.sortStateP2[t] = { byRatio: false, byParallel: false, byJingYest: false };
      });
      store.expandAll = false;
      store.expandAllP2 = false;
      syncGlobalCurrentDate();
    },

    // 同步 stocksData 镜像
    syncStocksData() {
      if (typeof getStocksData === 'function') {
        try { store.stocksData = getStocksData(); } catch (e) {}
      }
    },

    // 设置数据源引用（在 index.html 初始化缓存后调用）
    setDataSource(key, ref) {
      if (key === 'auction') store.auctionData = ref;
      else if (key === 'hot') store.hotAuctionData = ref;
    },

    // 触发 stocksDataVersion 自增（标签变化等场景）
    bumpStocksDataVersion() {
      store.stocksDataVersion = (store.stocksDataVersion || 0) + 1;
    },

    // 手动刷新当前 tab
    refresh() {
      triggerRender('store.actions.refresh');
    }
  };

  store.actions = actions;

  // 绑定到 window
  window.auctionStore = store;

  // 当 store 被外部直接修改时，同步回全局变量
  try {
    Vue.watch(() => store.currentGroup, syncGlobalCurrentGroup);
    Vue.watch(() => store.currentDate, syncGlobalCurrentDate);
  } catch (e) {}

  // 初始化 stocksData 镜像
  actions.syncStocksData();
})();
