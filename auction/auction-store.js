/**
 * auction-store.js
 * 早盘竞价看板统一状态层（彻底重构版）
 * - 只保留真正的 UI 状态，无手动记忆化、无版本号、无 DOM 同步副作用
 * - 对全局函数的调用全部走安全包装，提供清晰的可选降级
 * - 与全局 currentDate / currentGroup 双向同步由外部日期切换逻辑与本文件 watch 共同维护
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const Vue = window.Vue || (typeof Vue !== 'undefined' ? Vue : null);
  if (!Vue) {
    console.warn('[AUCTION-STORE] Vue 未就绪，跳过 store 初始化');
    return;
  }

  // ---------- 工具函数 ----------
  function safeCall(fn, ...args) {
    try {
      if (typeof fn === 'function') return fn(...args);
    } catch (e) {
      console.warn('[AUCTION-STORE] 全局函数调用失败:', e);
    }
    return undefined;
  }

  function syncGlobalCurrentGroup() {
    try {
      if (typeof currentGroup !== 'undefined' && currentGroup !== store.currentGroup) {
        currentGroup = store.currentGroup;
      }
    } catch (e) {}
  }

  function syncGlobalCurrentDate() {
    try {
      if (typeof currentDate !== 'undefined' && currentDate !== store.currentDate) {
        currentDate = store.currentDate;
      }
    } catch (e) {}
  }

  function createSortState() {
    return {
      auction: { byData: false, byRatio: false, byParallel: false, byJingYest: false },
      hot: { byData: false, byRatio: false, byParallel: false, byJingYest: false }
    };
  }

  function createSortStateP2() {
    return {
      auction: { byRatio: false, byParallel: false, byJingYest: false },
      hot: { byRatio: false, byParallel: false, byJingYest: false }
    };
  }

  // ---------- 状态树 ----------
  const store = Vue.reactive({
    // 基础导航
    currentDate: (typeof currentDate !== 'undefined' ? currentDate : '') || '',
    currentGroup: 'auction', // 'auction' | 'hot'
    currentPage: 0,          // 0=主列表, 1=题材分组, 2=题材历史, 3=统计看板

    // 数据源（保持与 index.html 中 _auctionMemCache / _hotAuctionData 的引用兼容）
    auctionData: {},
    hotAuctionData: {},

    // UI 状态
    expandedStocks: new Set(),
    p2ExpandedTopics: new Set(),
    highlightStock: '',
    highlightKeyword: '',

    // 排序状态（按 tab 隔离）
    sortState: createSortState(),
    sortStateP2: createSortStateP2(),

    // 全部展开
    expandAll: false,
    expandAllP2: false,

    // 强度排序开关
    strengthSortEnabled: false,

    // 标签派生信号版本（兼容 index.html 中 renderAuction 的失效信号）
    stocksDataVersion: 0,

    // 按数据源隔离的版本号：auction / hot 独立 bump，避免无关 tab 重算
    dataVersions: { auction: 0, hot: 0 },

    // actions 占位（下方绑定）
    actions: null
  });

  function tabKey() { return store.currentGroup === 'hot' ? 'hot' : 'auction'; }

  const actions = {
    // --- 导航 ---
    switchGroup(group) {
      if (group !== 'auction' && group !== 'hot') return;
      store.currentGroup = group;
      store.currentPage = 0;
      store.highlightKeyword = '';
      syncGlobalCurrentGroup();
    },

    switchPage(page) {
      const p = parseInt(page, 10);
      if (isNaN(p) || p < 0 || p > 3) return;
      store.currentPage = p;
    },

    // --- 排序 ---
    setSortState(page, key, value) {
      const t = tabKey();
      if (page === 1 && store.sortState[t]) {
        store.sortState[t][key] = !!value;
      } else if (page === 2 && store.sortStateP2[t]) {
        store.sortStateP2[t][key] = !!value;
      }
    },

    // --- 展开/收起 ---
    toggleTrendPanel(stockName) {
      if (!stockName) return;
      const set = store.expandedStocks;
      if (set.has(stockName)) set.delete(stockName); else set.add(stockName);
    },

    toggleP2Topic(topic) {
      if (!topic) return;
      const key = tabKey() + '|' + topic;
      const set = store.p2ExpandedTopics;
      if (set.has(key)) set.delete(key); else set.add(key);
    },

    setExpandAll(value, page) {
      if (page === 2) store.expandAllP2 = !!value;
      else store.expandAll = !!value;
    },

    // --- 高亮 ---
    setHighlight(stockName) {
      store.highlightStock = stockName || '';
    },
    clearHighlight() {
      store.highlightStock = '';
    },

    setHighlightKeyword(keyword) {
      store.highlightKeyword = (keyword || '').trim().toLowerCase();
    },

    clearHighlightKeyword() {
      store.highlightKeyword = '';
    },

    // --- 交互代理（统一走安全调用） ---
    toggleRowSelect(index) {
      safeCall(window.toggleAuctionRowSelect, index);
    },

    showNotePopup(el, note) {
      safeCall(window.showAuctionNotePopup, el, note);
    },

    showNoteInput(index, el) {
      safeCall(window.showAuctionNoteInput, index, el);
    },

    showBuyPrompt(stockName) {
      safeCall(window.showAuctionBuyPrompt, stockName);
    },

    openEdit(dataSource) {
      if (dataSource === 'hot') safeCall(window.openHotEdit);
      else safeCall(window.openAuctionEdit);
    },

    jumpToPage2(stockName) {
      safeCall(window.jumpToAuctionPage2, stockName);
    },

    jumpToPage1(stockName) {
      safeCall(window.jumpToAuctionPage1, stockName);
    },

    toggleStrengthSort() {
      safeCall(window.toggleStrengthSort);
    },

    toggleSortHelp(panelId) {
      safeCall(window.toggleAuctionSortHelp, panelId);
    },

    toggleBoard() {
      safeCall(window.toggleAuctionBoard);
    },

    toggleTopicGroupTrendPanels(topic) {
      safeCall(window.toggleTopicGroupTrendPanels, topic);
    },

    expandAllTrendPanels(dataSource) {
      safeCall(window.expandAllAuctionTrendPanels, dataSource);
    },

    restoreExpandedTrendPanels(dataSource) {
      safeCall(window.restoreExpandedAuctionTrendPanels, dataSource);
    },

    expandAllTrendPanelsP2(dataSource) {
      safeCall(window.expandAllAuctionTrendPanelsP2, dataSource);
    },

    restoreExpandedTopicGroupsP2(dataSource) {
      safeCall(window.restoreExpandedTopicGroupsP2, dataSource);
    },

    openCoreTopicModal() {
      safeCall(window.openCoreTopicModal);
    },

    openAuctionNoteEditFromPage2(stockName) {
      safeCall(window.openAuctionNoteEditFromPage2, stockName);
    },

    copyAllTopicStocks(topic, dataSource) {
      safeCall(window.copyAllTopicStocks, topic, dataSource);
    },

    copyTopicStocks(topic, limit, dataSource) {
      safeCall(window.copyTopicStocks, topic, limit, dataSource);
    },

    // --- 日期 ---
    setDate(date) {
      store.currentDate = date || '';
      store.expandedStocks.clear();
      store.p2ExpandedTopics.clear();
      store.highlightStock = '';
      store.highlightKeyword = '';
      store.sortState = createSortState();
      store.sortStateP2 = createSortStateP2();
      store.expandAll = false;
      store.expandAllP2 = false;
      syncGlobalCurrentDate();
    },

    // --- 刷新 ---
    refresh() {
      safeCall(window.renderAuction, store.currentGroup);
    },

    // --- 强度排序开关镜像 ---
    setStrengthSortEnabled(value) {
      store.strengthSortEnabled = !!value;
    },

    // --- 按数据源失效信号 ---
    bumpDataVersion(source) {
      if (store.dataVersions && source in store.dataVersions) {
        store.dataVersions[source] = (store.dataVersions[source] || 0) + 1;
      }
    }
  };

  store.actions = actions;
  window.auctionStore = store;

  // store -> global 同步
  try {
    Vue.watch(() => store.currentGroup, syncGlobalCurrentGroup);
    Vue.watch(() => store.currentDate, syncGlobalCurrentDate);
  } catch (e) {}
})();
