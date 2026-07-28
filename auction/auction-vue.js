/**
 * auction-vue.js
 * 早盘竞价看板单一 Vue App 入口（彻底重构版）
 * - 在 #auctionBoard 上挂载一个应用，完全接管内部渲染
 * - 保留与旧全局函数兼容的 DOM id，确保 innerHTML 回退路径（若被触发）可定位
 * - 所有交互优先通过 auctionStore.actions 驱动，store 响应式自动同步到组件
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const Vue = window.Vue || (typeof Vue !== 'undefined' ? Vue : null);
  if (!Vue) { console.warn('[AUCTION-VUE] Vue 未就绪'); return; }

  const store = window.auctionStore;
  if (!store) { console.warn('[AUCTION-VUE] auctionStore 未就绪'); return; }

  // 复用 auction-components.js 暴露的组件
  const AuctionBoard = window.AuctionBoardComponent;
  const Page2Board = window.Page2BoardComponent;
  const Page3Board = window.Page3BoardComponent;
  const StatsBoard = window.StatsBoardComponent;

  const tabLabels = { auction: '早盘竞价', hot: '热门股票' };

  // 安全调用全局函数
  function safeCall(fn, ...args) {
    try { if (typeof fn === 'function') return fn(...args); } catch (e) { console.warn('[AUCTION-VUE] 全局函数调用失败:', e); }
  }

  // Tab 栏
  const TabBar = {
    name: 'TabBar',
    setup() {
      const tabs = [
        { key: 'auction', label: tabLabels.auction },
        { key: 'hot', label: tabLabels.hot }
      ];
      function select(key) {
        if (store.actions) store.actions.switchGroup(key);
        // 兼容旧全局函数
        safeCall(window.switchGroup, key);
      }
      return { tabs, store, select };
    },
    template: `
      <div class="group-tab-bar" id="groupTabBar" @click.stop>
        <span v-for="tab in tabs" :key="tab.key"
              :id="tab.key === 'hot' ? 'tabHot' : 'tabAuction'"
              :class="['group-tab', store.currentGroup === tab.key ? 'active' : '']"
              @click="select(tab.key)">{{ tab.label }}</span>
      </div>
    `
  };

  // 页码指示器
  const PageIndicator = {
    name: 'PageIndicator',
    setup() {
      const pages = [0, 1, 2, 3];
      function go(page) { if (store.actions) store.actions.switchPage(page); }
      return { pages, store, go };
    },
    template: `
      <div class="auction-page-indicator" id="auctionPageIndicator">
        <span v-for="p in pages" :key="p"
              :class="['page-dot', store.currentPage === p ? 'active' : '']"
              :data-page="p"
              @click="go(p)"></span>
      </div>
    `
  };

  // 头部
  const AuctionHeader = {
    name: 'AuctionHeader',
    components: { TabBar, PageIndicator },
    setup() {
      const title = Vue.computed(() => tabLabels[store.currentGroup] || tabLabels.auction);
      function toggleBoard() { safeCall(window.toggleAuctionBoard); }
      return { store, title, toggleBoard };
    },
    template: `
      <div class="auction-header" id="auctionHeader" style="cursor:pointer" @click="toggleBoard">
        <div>
          <tab-bar></tab-bar>
          <div class="auction-title">
            <span id="auctionBoardTitle">{{ title }}</span>
            <span id="auctionTotalStrength" style="margin-left: 8px; font-weight: 600;">
              强度：<span id="auctionStrengthValue" style="color: #ffffff;">-</span>
              <span id="auctionStrengthArrow" style="color: #ffffff; font-size: 14px; font-weight: bold;">-</span>
            </span>
          </div>
          <div class="auction-subtitle"></div>
        </div>
        <div class="auction-header-right">
          <page-indicator></page-indicator>
          <div class="auction-toggle-btn" id="auctionToggleBtn">▼</div>
        </div>
      </div>
    `
  };

  // Page1 工具栏（含全部展开、数据、环比、平行）
  const Page1Toolbar = {
    name: 'Page1Toolbar',
    props: { prefix: { type: String, default: 'auction' } },
    setup(props) {
      function onChange(key, e) {
        if (store.actions) store.actions.setSortState(1, key, e.target.checked);
        if (key === 'expandAll') {
          store.actions.setExpandAll(e.target.checked, 1);
          safeCall(window['on' + (props.prefix === 'hot' ? 'Hot' : 'Auction') + 'ExpandAllToggleChange']);
        }
      }
      return { onChange };
    },
    template: `
      <div class="auction-toolbar" :id="prefix + 'Toolbar'">
        <div class="auction-toggle-item">
          <span class="auction-toggle-label">全部展开</span>
          <label class="auction-toggle-switch">
            <input type="checkbox" :id="prefix + 'ExpandAllToggle'" @change="onChange('expandAll', $event)">
            <span class="auction-toggle-slider"></span>
          </label>
        </div>
        <div class="auction-toggle-item">
          <span class="auction-toggle-label">数据</span>
          <label class="auction-toggle-switch">
            <input type="checkbox" :id="prefix + 'SortByDataToggle'" @change="onChange('byData', $event)">
            <span class="auction-toggle-slider"></span>
          </label>
        </div>
        <div class="auction-toggle-item">
          <span class="auction-toggle-label">环比</span>
          <label class="auction-toggle-switch">
            <input type="checkbox" :id="prefix + 'SortByRatioToggle'" @change="onChange('byRatio', $event)">
            <span class="auction-toggle-slider"></span>
          </label>
        </div>
        <div class="auction-toggle-item">
          <span class="auction-toggle-label">平行</span>
          <label class="auction-toggle-switch">
            <input type="checkbox" :id="prefix + 'SortByParallelToggle'" @change="onChange('byParallel', $event)">
            <span class="auction-toggle-slider"></span>
          </label>
        </div>
      </div>
    `
  };

  // Page2 工具栏
  const Page2Toolbar = {
    name: 'Page2Toolbar',
    props: { prefix: { type: String, default: 'auction' } },
    setup(props) {
      function onChange(key, e) {
        if (store.actions) store.actions.setSortState(2, key, e.target.checked);
        if (key === 'expandAll') store.actions.setExpandAll(e.target.checked, 2);
      }
      return { onChange };
    },
    template: `
      <div class="auction-toolbar" :id="prefix + 'Toolbar2'">
        <div class="auction-toggle-item">
          <span class="auction-toggle-label">全部展开</span>
          <label class="auction-toggle-switch">
            <input type="checkbox" :id="prefix + 'ExpandAllToggle2'" @change="onChange('expandAll', $event)">
            <span class="auction-toggle-slider"></span>
          </label>
        </div>
        <div class="auction-toggle-item">
          <span class="auction-toggle-label">环比</span>
          <label class="auction-toggle-switch">
            <input type="checkbox" :id="prefix + 'SortByRatioToggle2'" @change="onChange('byRatio', $event)">
            <span class="auction-toggle-slider"></span>
          </label>
        </div>
        <div class="auction-toggle-item">
          <span class="auction-toggle-label">平行</span>
          <label class="auction-toggle-switch">
            <input type="checkbox" :id="prefix + 'SortByParallelToggle2'" @change="onChange('byParallel', $event)">
            <span class="auction-toggle-slider"></span>
          </label>
        </div>
      </div>
    `
  };

  // 竞/昨单独一行
  const JingYestRow = {
    name: 'JingYestRow',
    props: { prefix: { type: String, default: 'auction' }, page: { type: Number, default: 1 } },
    setup(props) {
      const suffix = props.page === 2 ? '2' : '';
      const rowId = props.prefix + 'ToolbarRow2' + (props.page === 2 ? '_2' : '');
      function onChange(e) { if (store.actions) store.actions.setSortState(props.page, 'byJingYest', e.target.checked); }
      return { suffix, rowId, onChange };
    },
    template: `
      <div class="auction-toolbar-row2" :id="rowId">
        <div class="auction-toggle-item">
          <span class="auction-toggle-label">竞/昨</span>
          <label class="auction-toggle-switch">
            <input type="checkbox" :id="prefix + 'SortByJingYestToggle' + suffix" @change="onChange">
            <span class="auction-toggle-slider"></span>
          </label>
        </div>
      </div>
    `
  };

  // 统计条
  const HighRatioStat = {
    name: 'HighRatioStat',
    props: { prefix: { type: String, default: 'auction' }, page: { type: Number, default: 1 } },
    setup(props) {
      const suffix = props.page === 2 ? '2' : '';
      const panelId = props.prefix + 'SortHelpPanel' + suffix;
      function toggleHelp() { safeCall(window.toggleAuctionSortHelp, panelId); }
      return { suffix, panelId, toggleHelp };
    },
    template: `
      <div class="auction-highratio-stat" :id="prefix + 'HighRatioStat' + suffix">
        <span style="font-weight:700;color:#dc2626;">竞/昨数：<span :id="prefix + 'JingYestCount' + suffix">-</span></span>
        <span style="display:inline-block;width:28px;"></span>
        竞放量数：<span :id="prefix + 'HighRatioCount' + suffix" style="font-weight:700;">-</span>
        <span :id="prefix + 'HighRatioArrow' + suffix" style="font-weight:700;"></span>
        <span class="auction-sort-help-icon" @click.stop="toggleHelp">?</span>
        <div class="auction-sort-help-panel" :id="panelId" @click.stop></div>
      </div>
    `
  };

  // Page1 内容页
  const Page1 = {
    name: 'AuctionPage1',
    components: { Page1Toolbar, JingYestRow, HighRatioStat, AuctionBoard },
    props: { prefix: { type: String, default: 'auction' } },
    setup(props) {
      const active = Vue.computed(() => store.currentGroup === props.prefix && store.currentPage === 0);
      function openEdit() { safeCall(props.prefix === 'hot' ? window.openHotEdit : window.openAuctionEdit); }
      return { active, prefix: props.prefix, openEdit, AuctionBoard };
    },
    template: `
      <div class="auction-page auction-page-1" :class="{ active: active }" :id="prefix + 'Page1'">
        <page1-toolbar :prefix="prefix"></page1-toolbar>
        <jing-yest-row :prefix="prefix" :page="1"></jing-yest-row>
        <high-ratio-stat :prefix="prefix" :page="1"></high-ratio-stat>
        <div class="auction-content" :id="prefix + 'Content'" @dblclick.stop="openEdit">
          <auction-board v-if="AuctionBoard" :data-source="prefix"></auction-board>
        </div>
      </div>
    `
  };

  // Page2 内容页
  const Page2 = {
    name: 'AuctionPage2',
    components: { Page2Toolbar, JingYestRow, HighRatioStat, Page2Board },
    props: { prefix: { type: String, default: 'auction' } },
    setup(props) {
      const active = Vue.computed(() => store.currentGroup === props.prefix && store.currentPage === 1);
      function openCoreTopic() { safeCall(window.openCoreTopicModal); }
      return { active, prefix: props.prefix, openCoreTopic, Page2Board };
    },
    template: `
      <div class="auction-page auction-page-2" :class="{ active: active }" :id="prefix + 'Page2'">
        <page2-toolbar :prefix="prefix"></page2-toolbar>
        <jing-yest-row :prefix="prefix" :page="2"></jing-yest-row>
        <high-ratio-stat :prefix="prefix" :page="2"></high-ratio-stat>
        <div class="auction-content" :id="prefix + 'Content2'" @dblclick.stop="openCoreTopic">
          <page2-board v-if="Page2Board" :data-source="prefix"></page2-board>
        </div>
      </div>
    `
  };

  // Page3 内容页
  const Page3 = {
    name: 'AuctionPage3',
    components: { Page3Board },
    props: { prefix: { type: String, default: 'auction' } },
    setup(props) {
      const active = Vue.computed(() => store.currentGroup === props.prefix && store.currentPage === 2);
      return { active, prefix: props.prefix, Page3Board };
    },
    template: `
      <div class="auction-page auction-page-3" :class="{ active: active }" :id="prefix + 'Page3'">
        <div class="auction-content" :id="prefix + 'Content3'">
          <page3-board v-if="Page3Board" :data-source="prefix"></page3-board>
        </div>
      </div>
    `
  };

  // Page4 内容页
  const Page4 = {
    name: 'AuctionPage4',
    components: { StatsBoard },
    props: { prefix: { type: String, default: 'auction' } },
    setup(props) {
      const active = Vue.computed(() => store.currentGroup === props.prefix && store.currentPage === 3);
      return { active, prefix: props.prefix, StatsBoard };
    },
    template: `
      <div class="auction-page auction-page-4" :class="{ active: active }" :id="prefix + 'Page4'">
        <div class="auction-content" :id="prefix + 'Content4'">
          <stats-board v-if="StatsBoard" :data-source="prefix"></stats-board>
        </div>
        <div class="auction-clear-all-btn" :id="prefix + 'ClearAllBtn'">全部清除</div>
      </div>
    `
  };

  // 滑动容器
  const PageContainer = {
    name: 'PageContainer',
    components: { Page1, Page2, Page3, Page4 },
    setup() {
      let touchStartX = 0;
      let touchStartY = 0;
      function onTouchStart(e) {
        touchStartX = e.changedTouches[0].screenX;
        touchStartY = e.changedTouches[0].screenY;
      }
      function onTouchEnd(e) {
        const dx = e.changedTouches[0].screenX - touchStartX;
        const dy = e.changedTouches[0].screenY - touchStartY;
        if (Math.abs(dx) < 50 || Math.abs(dy) > Math.abs(dx)) return;
        if (!store.actions) return;
        if (dx < 0 && store.currentPage < 3) store.actions.switchPage(store.currentPage + 1);
        else if (dx > 0 && store.currentPage > 0) store.actions.switchPage(store.currentPage - 1);
      }
      return { store, onTouchStart, onTouchEnd };
    },
    template: `
      <div class="auction-swipe-container" id="auctionSwipeContainer"
           @touchstart="onTouchStart" @touchend="onTouchEnd">
        <div class="auction-swipe-wrapper" id="auctionSwipeWrapper"
             :style="{ transform: 'translateX(-' + (store.currentPage * 100) + '%)' }">
          <page1 prefix="auction"></page1>
          <page2 prefix="auction"></page2>
          <page3 prefix="auction"></page3>
          <page4 prefix="auction"></page4>
          <page1 prefix="hot"></page1>
          <page2 prefix="hot"></page2>
          <page3 prefix="hot"></page3>
          <page4 prefix="hot"></page4>
        </div>
      </div>
    `
  };

  const AuctionApp = {
    name: 'AuctionApp',
    components: { AuctionHeader, PageContainer },
    template: `
      <div class="auction-app-wrapper">
        <auction-header></auction-header>
        <page-container></page-container>
      </div>
    `
  };

  function mount() {
    const root = document.getElementById('auctionBoard');
    if (!root) { console.warn('[AUCTION-VUE] #auctionBoard 不存在'); return; }
    // 清空旧 innerHTML 结构，避免双轨渲染冲突
    root.innerHTML = '';
    const app = Vue.createApp(AuctionApp);
    app.mount(root);
    window._auctionSingleApp = app;
    return app;
  }

  window.AuctionAppComponent = AuctionApp;
  window.mountAuctionBoardApp = mount;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
