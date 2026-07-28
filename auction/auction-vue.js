/**
 * auction-vue.js
 * 早盘竞价看板 Vue 3 挂载层（与现有 DOM 结构兼容版）
 * - 不接管整个 #auctionBoard，而是在原有 content 容器内挂载 Vue 组件
 * - 暴露 mountAuctionBoardSandbox / mountPage2BoardSandbox / mountPage3BoardSandbox / mountStatsBoardSandbox
 * - 原有 renderAuction / renderAuctionPage2 / ... 检测到这些函数后会走 Vue 路径
 * - 原有 header / toolbar / page 切换逻辑（CSS class、toggle、switchGroup）继续工作
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const Vue = window.Vue || (typeof Vue !== 'undefined' ? Vue : null);
  if (!Vue) { console.warn('[AUCTION-VUE] Vue 未就绪'); return; }

  const store = window.auctionStore;
  if (!store) { console.warn('[AUCTION-VUE] auctionStore 未就绪'); return; }

  const AuctionBoard = window.AuctionBoardComponent;
  const Page2Board = window.Page2BoardComponent;
  const Page3Board = window.Page3BoardComponent;
  const StatsBoard = window.StatsBoardComponent;
  if (!AuctionBoard || !Page2Board || !Page3Board || !StatsBoard) {
    console.warn('[AUCTION-VUE] 组件未就绪');
    return;
  }

  const mountedApps = new Map();

  function safeCall(fn, ...args) {
    try { if (typeof fn === 'function') return fn(...args); } catch (e) { console.warn('[AUCTION-VUE] 全局函数调用失败:', e); }
  }

  function ensureContainer(containerId) {
    const el = typeof containerId === 'string' ? document.getElementById(containerId) : containerId;
    return el || null;
  }

  function getComponentMarkerSelector(componentName) {
    switch (componentName) {
      case 'AuctionBoard': return '.auction-board-vue';
      case 'Page2Board': return '.page2-board,.auction-topic-placeholder';
      case 'Page3Board': return '.page3-board,.auction-topic-placeholder';
      case 'StatsBoard': return '.stats-board,.star-stats-empty';
      default: return null;
    }
  }

  function mountComponent(component, props, containerId) {
    const el = ensureContainer(containerId);
    if (!el) { console.warn('[AUCTION-VUE] 容器不存在:', containerId); return null; }

    // 同一容器 + 同一组件只挂载一次；Vue 响应式会自动处理后续数据更新，
    // 避免原 renderAuction 每次调用都销毁/重建组件导致卡顿。
    const key = containerId + ':' + component.name;
    const existing = mountedApps.get(key);
    if (existing) {
      const marker = getComponentMarkerSelector(component.name);
      // 如果外部已把 DOM 清空/卸载（例如 StatsBoard 切 tab 时主动 unmount），
      // 不能继续复用旧 app，否则会出现空白容器。
      if (!marker || el.querySelector(marker)) {
        syncStore(props.dataSource);
        return existing;
      }
      try { existing.unmount(); } catch (e) {}
      mountedApps.delete(key);
    }

    el.innerHTML = '';
    const dataSourceRef = Vue.computed(() => props.dataSource);
    const app = Vue.createApp({
      name: 'AuctionSandboxApp',
      components: { [component.name]: component },
      setup() { return { dataSource: dataSourceRef }; },
      template: `<${component.name} :data-source="dataSource"></${component.name}>`
    });
    app.config.errorHandler = (err, vm, info) => { console.warn('[AUCTION-VUE] 渲染错误:', err, info); };
    app.mount(el);
    mountedApps.set(key, app);
    return app;
  }

  function tabKey(dataSource) { return dataSource === 'hot' ? 'hot' : 'auction'; }

  function syncStore(dataSource) {
    if (!store || !store.actions) return;
    // 不再在这里切换 store.currentGroup：
    // 1) index.html 的 switchGroup / renderAuction* 自己会维护当前分组；
    // 2) 后台 tab 的渲染不应把可见分组抢走，否则会造成所有 computed 重算、界面卡顿/闪烁。
    // if (store.currentGroup !== g) store.actions.switchGroup(g);
    try { if (typeof currentDate !== 'undefined') store.currentDate = currentDate; } catch (e) {}
  }

  // ============================================================
  // 对外暴露的 sandbox 挂载函数（与原 renderAuction 兼容）
  // ============================================================
  function mountAuctionBoardSandbox(dataSource, containerId) {
    syncStore(dataSource);
    return mountComponent(AuctionBoard, { dataSource }, containerId);
  }

  function mountPage2BoardSandbox(dataSource, containerId) {
    syncStore(dataSource);
    return mountComponent(Page2Board, { dataSource }, containerId);
  }

  function mountPage3BoardSandbox(dataSource, containerId) {
    syncStore(dataSource);
    return mountComponent(Page3Board, { dataSource }, containerId);
  }

  function mountStatsBoardSandbox(dataSource, containerId) {
    syncStore(dataSource);
    return mountComponent(StatsBoard, { dataSource }, containerId);
  }

  window.mountAuctionBoardSandbox = mountAuctionBoardSandbox;
  window.mountPage2BoardSandbox = mountPage2BoardSandbox;
  window.mountPage3BoardSandbox = mountPage3BoardSandbox;
  window.mountStatsBoardSandbox = mountStatsBoardSandbox;

  // ============================================================
  // 自动挂载：页面加载完成后，若 content 容器存在且为空，则自动挂载组件
  // 注意：Page4 (auctionContent4 / hotContent4) 是“复制的题材股票”原生区域，
  //       不由 Vue 接管；StatsBoard 挂载到独立的 #starStatsContent。
  // ============================================================
  function autoMountAll() {
    const slots = [
      { ds: 'auction', page: 1, cid: 'auctionContent' },
      { ds: 'auction', page: 2, cid: 'auctionContent2' },
      { ds: 'auction', page: 3, cid: 'auctionContent3' },
      { ds: 'hot', page: 1, cid: 'hotContent' },
      { ds: 'hot', page: 2, cid: 'hotContent2' },
      { ds: 'hot', page: 3, cid: 'hotContent3' }
    ];
    for (const s of slots) {
      const el = document.getElementById(s.cid);
      if (!el || el.querySelector('.auction-board-vue, .page2-board, .page3-board')) continue;
      try {
        if (s.page === 1) mountAuctionBoardSandbox(s.ds, s.cid);
        else if (s.page === 2) mountPage2BoardSandbox(s.ds, s.cid);
        else if (s.page === 3) mountPage3BoardSandbox(s.ds, s.cid);
      } catch (e) { console.warn('[AUCTION-VUE] 自动挂载失败:', s.cid, e); }
    }

    // 独立的星标签统计看板（与 tab 共用一份 DOM）
    const starStatsEl = document.getElementById('starStatsContent');
    if (starStatsEl && !starStatsEl.querySelector('.stats-board, .star-stats-empty')) {
      try {
        const g = store.currentGroup === 'hot' ? 'hot' : 'auction';
        mountStatsBoardSandbox(g, 'starStatsContent');
      } catch (e) { console.warn('[AUCTION-VUE] 自动挂载 StatsBoard 失败:', e); }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoMountAll);
  } else {
    autoMountAll();
  }

  // ============================================================
  // 覆盖遗留 render 函数：Vue 挂载后只同步状态，避免 innerHTML 覆盖
  // ============================================================
  if (typeof window.renderAuction === 'function') {
    const _origRenderAuction = window.renderAuction;
    window.renderAuction = function (dataSource) {
      const ds = (dataSource === 'hot' ? 'hot' : 'auction');
      syncStore(ds);
      // 如果 Vue sandbox 已暴露，让原函数走 Vue 路径；否则回退原逻辑
      if (typeof window.mountAuctionBoardSandbox === 'function') {
        return _origRenderAuction(dataSource);
      }
      return _origRenderAuction(dataSource);
    };
  }

  // ============================================================
  // store 与全局状态同步
  // ============================================================
  Vue.watch(() => store.currentDate, (v) => {
    try { if (typeof currentDate !== 'undefined' && currentDate !== v) currentDate = v; } catch (e) {}
  });
  Vue.watch(() => store.currentGroup, (v) => {
    try { if (typeof currentGroup !== 'undefined' && currentGroup !== v) currentGroup = v; } catch (e) {}
  });

  // 全局 currentDate / currentGroup 变化时同步回 store
  function syncGlobalToStore() {
    try {
      if (typeof currentDate !== 'undefined' && store.currentDate !== currentDate) store.currentDate = currentDate;
    } catch (e) {}
    try {
      if (typeof currentGroup !== 'undefined' && store.currentGroup !== currentGroup) store.currentGroup = currentGroup;
    } catch (e) {}
  }
  syncGlobalToStore();
  setInterval(syncGlobalToStore, 500);

  console.log('[AUCTION-VUE] Vue 挂载层初始化完成');
})();
