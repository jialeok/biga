/**
 * auction-vue.js
 * 早盘竞价看板单一 Vue App 入口（彻底重构版）
 * - 在 #auctionBoard 上挂载一个应用，完全接管内部渲染
 * - 使用 KeepAlive 缓存 1-4 页，滑动/Tab 切换时后台页面状态保留、响应瞬时
 * - 覆盖 window.renderAuction，消除 innerHTML 双轨渲染隐患
 * - 所有交互通过 auctionStore.actions / useAuctionEvents，不再直接依赖全局函数
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
  const HighRatioStat = window.HighRatioStatComponent;

  if (!AuctionBoard || !Page2Board || !Page3Board || !StatsBoard || !HighRatioStat) {
    console.warn('[AUCTION-VUE] 组件未就绪');
    return;
  }

  const { createHandlers } = window.useAuctionEvents();
  const { useSwipe } = window.useAuctionGesture();
  const tabLabels = { auction: '早盘竞价', hot: '热门股票' };

  // ============================================================
  // 数据驱动：头部强度统计
  // ============================================================
  const HeaderStats = {
    name: 'HeaderStats',
    setup() {
      const stats = Vue.computed(() => {
        if (!store.currentDate) return { text: '-', arrow: '-' };
        const ds = store.currentGroup === 'hot' ? 'hot' : 'auction';
        const list = window.getTodayGroupList ? window.getTodayGroupList(ds) : [];
        const prevList = (window.getPreviousTradingDay && window.getPreviousTradingDay(store.currentDate))
          ? (window.getGroupData(ds)[window.getPreviousTradingDay(store.currentDate)] || [])
          : [];
        const prevPrevDate = window.getPreviousTradingDay ? window.getPreviousTradingDay(window.getPreviousTradingDay(store.currentDate)) : null;
        const prevPrevList = prevPrevDate ? (window.getGroupData(ds)[prevPrevDate] || []) : [];
        if (list.length === 0) return { text: '-', arrow: '-' };

        const prevMap = new Map();
        prevList.forEach(it => { if (it && it.stock) prevMap.set(it.stock.trim(), it); });
        const prevPrevMap = new Map();
        prevPrevList.forEach(it => { if (it && it.stock) prevPrevMap.set(it.stock.trim(), it); });

        let strongCount = 0;
        list.forEach(item => {
          let hasDown = false;
          if (prevList.length > 0 && item.stock) {
            const pi = prevMap.get(item.stock.trim());
            if (pi && pi.yestVolume) {
              const pv = parseFloat(pi.volume) || 0;
              const py = parseFloat(pi.yestVolume) || 0;
              if (py > 0) {
                const prr = (pv / py) * 100;
                const crr = (parseFloat(item.volume) || 0) / (parseFloat(item.yestVolume) || 1) * 100;
                if (crr < prr) hasDown = true;
              }
            }
          }
          if (!hasDown) strongCount++;
        });
        const todayStrength = Math.round((strongCount / list.length) * 100);

        let yStrongCount = 0;
        const yTotal = prevList.length;
        if (yTotal > 0) {
          prevList.forEach(item => {
            let hasDown = false;
            if (prevPrevList.length > 0 && item.stock) {
              const pp = prevPrevMap.get(item.stock.trim());
              if (pp && pp.yestVolume) {
                const ppv = parseFloat(pp.volume) || 0;
                const ppy = parseFloat(pp.yestVolume) || 0;
                if (ppy > 0) {
                  const pprr = (ppv / ppy) * 100;
                  const prr = (parseFloat(item.volume) || 0) / (parseFloat(item.yestVolume) || 1) * 100;
                  if (prr < pprr) hasDown = true;
                }
              }
            }
            if (!hasDown) yStrongCount++;
          });
        }
        const yesterdayStrength = yTotal > 0 ? Math.round((yStrongCount / yTotal) * 100) : null;

        return {
          text: todayStrength + '% ',
          arrow: yesterdayStrength !== null ? (todayStrength > yesterdayStrength ? '⬆' : (todayStrength < yesterdayStrength ? '⬇' : '-')) : '-'
        };
      });
      return { stats };
    },
    template: `
      <span id="auctionTotalStrength" style="margin-left: 8px; font-weight: 600;">
        强度：<span id="auctionStrengthValue" style="color: #ffffff;">{{ stats.text }}</span>
        <span id="auctionStrengthArrow" style="color: #ffffff; font-size: 14px; font-weight: bold;">{{ stats.arrow }}</span>
      </span>
    `
  };

  // ============================================================
  // Tab 栏
  // ============================================================
  const TabBar = {
    name: 'TabBar',
    setup() {
      const handlers = createHandlers(store.currentGroup === 'hot' ? 'hot' : 'auction');
      const tabs = [
        { key: 'auction', label: tabLabels.auction },
        { key: 'hot', label: tabLabels.hot }
      ];
      function select(key, e) {
        if (e) e.stopPropagation();
        handlers.switchGroup(key);
        try { if (typeof switchGroup === 'function') switchGroup(key); } catch (e) {}
      }
      return { tabs, store, select };
    },
    template: `
      <div class="group-tab-bar" id="groupTabBar" @click.stop>
        <span v-for="tab in tabs" :key="tab.key"
              :id="tab.key === 'hot' ? 'tabHot' : 'tabAuction'"
              :class="['group-tab', store.currentGroup === tab.key ? 'active' : '']"
              @click="select(tab.key, $event)">{{ tab.label }}</span>
      </div>
    `
  };

  // ============================================================
  // 页码指示器
  // ============================================================
  const PageIndicator = {
    name: 'PageIndicator',
    setup() {
      const handlers = createHandlers(store.currentGroup === 'hot' ? 'hot' : 'auction');
      const pages = [0, 1, 2, 3];
      function go(page, e) {
        if (e) e.stopPropagation();
        handlers.switchPage(page);
      }
      return { pages, store, go };
    },
    template: `
      <div class="auction-page-indicator" id="auctionPageIndicator">
        <span v-for="p in pages" :key="p"
              :class="['page-dot', store.currentPage === p ? 'active' : '']"
              :data-page="p"
              @click="go(p, $event)"></span>
      </div>
    `
  };

  // ============================================================
  // 头部
  // ============================================================
  const AuctionHeader = {
    name: 'AuctionHeader',
    components: { TabBar, PageIndicator, HeaderStats },
    setup() {
      const handlers = createHandlers(store.currentGroup === 'hot' ? 'hot' : 'auction');
      const title = Vue.computed(() => tabLabels[store.currentGroup] || tabLabels.auction);
      function toggleBoard(e) {
        if (e) e.stopPropagation();
        handlers.toggleBoard();
      }
      return { store, title, toggleBoard };
    },
    template: `
      <div class="auction-header" id="auctionHeader" style="cursor:pointer" @click="toggleBoard">
        <div>
          <tab-bar></tab-bar>
          <div class="auction-title">
            <span id="auctionBoardTitle">{{ title }}</span>
            <header-stats></header-stats>
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

  // ============================================================
  // 工具栏组件
  // ============================================================
  const Page1Toolbar = {
    name: 'Page1Toolbar',
    props: { prefix: { type: String, default: 'auction' } },
    setup(props) {
      const handlers = createHandlers(props.prefix);
      const tab = Vue.computed(() => props.prefix === 'hot' ? 'hot' : 'auction');
      function onExpandAll(e) { handlers.onExpandAllChange(1, e.target.checked); }
      function onData(e) { handlers.onSortChange(1, 'byData', e.target.checked); }
      function onRatio(e) { handlers.onSortChange(1, 'byRatio', e.target.checked); }
      function onParallel(e) { handlers.onSortChange(1, 'byParallel', e.target.checked); }
      return { store, tab, prefix: props.prefix, onExpandAll, onData, onRatio, onParallel };
    },
    template: `
      <div class="auction-toolbar" :id="prefix + 'Toolbar'">
        <div class="auction-toggle-item">
          <span class="auction-toggle-label">全部展开</span>
          <label class="auction-toggle-switch">
            <input type="checkbox" :id="prefix + 'ExpandAllToggle'" :checked="store.expandAll" @change="onExpandAll">
            <span class="auction-toggle-slider"></span>
          </label>
        </div>
        <div class="auction-toggle-item">
          <span class="auction-toggle-label">数据</span>
          <label class="auction-toggle-switch">
            <input type="checkbox" :id="prefix + 'SortByDataToggle'" :checked="store.sortState[tab].byData" @change="onData">
            <span class="auction-toggle-slider"></span>
          </label>
        </div>
        <div class="auction-toggle-item">
          <span class="auction-toggle-label">环比</span>
          <label class="auction-toggle-switch">
            <input type="checkbox" :id="prefix + 'SortByRatioToggle'" :checked="store.sortState[tab].byRatio" @change="onRatio">
            <span class="auction-toggle-slider"></span>
          </label>
        </div>
        <div class="auction-toggle-item">
          <span class="auction-toggle-label">平行</span>
          <label class="auction-toggle-switch">
            <input type="checkbox" :id="prefix + 'SortByParallelToggle'" :checked="store.sortState[tab].byParallel" @change="onParallel">
            <span class="auction-toggle-slider"></span>
          </label>
        </div>
      </div>
    `
  };

  const Page2Toolbar = {
    name: 'Page2Toolbar',
    props: { prefix: { type: String, default: 'auction' } },
    setup(props) {
      const handlers = createHandlers(props.prefix);
      const tab = Vue.computed(() => props.prefix === 'hot' ? 'hot' : 'auction');
      function onExpandAll(e) { handlers.onExpandAllChange(2, e.target.checked); }
      function onRatio(e) { handlers.onSortChange(2, 'byRatio', e.target.checked); }
      function onParallel(e) { handlers.onSortChange(2, 'byParallel', e.target.checked); }
      return { store, tab, prefix: props.prefix, onExpandAll, onRatio, onParallel };
    },
    template: `
      <div class="auction-toolbar" :id="prefix + 'Toolbar2'">
        <div class="auction-toggle-item">
          <span class="auction-toggle-label">全部展开</span>
          <label class="auction-toggle-switch">
            <input type="checkbox" :id="prefix + 'ExpandAllToggle2'" :checked="store.expandAllP2" @change="onExpandAll">
            <span class="auction-toggle-slider"></span>
          </label>
        </div>
        <div class="auction-toggle-item">
          <span class="auction-toggle-label">环比</span>
          <label class="auction-toggle-switch">
            <input type="checkbox" :id="prefix + 'SortByRatioToggle2'" :checked="store.sortStateP2[tab].byRatio" @change="onRatio">
            <span class="auction-toggle-slider"></span>
          </label>
        </div>
        <div class="auction-toggle-item">
          <span class="auction-toggle-label">平行</span>
          <label class="auction-toggle-switch">
            <input type="checkbox" :id="prefix + 'SortByParallelToggle2'" :checked="store.sortStateP2[tab].byParallel" @change="onParallel">
            <span class="auction-toggle-slider"></span>
          </label>
        </div>
      </div>
    `
  };

  const JingYestRow = {
    name: 'JingYestRow',
    props: { prefix: { type: String, default: 'auction' }, page: { type: Number, default: 1 } },
    setup(props) {
      const handlers = createHandlers(props.prefix);
      const suffix = props.page === 2 ? '2' : '';
      const rowId = props.prefix + 'ToolbarRow2' + (props.page === 2 ? '_2' : '');
      const tab = Vue.computed(() => props.prefix === 'hot' ? 'hot' : 'auction');
      const stateKey = Vue.computed(() => props.page === 2 ? 'sortStateP2' : 'sortState');
      function onChange(e) { handlers.onSortChange(props.page, 'byJingYest', e.target.checked); }
      return { store, tab, stateKey, suffix, rowId, prefix: props.prefix, onChange };
    },
    template: `
      <div class="auction-toolbar-row2" :id="rowId">
        <div class="auction-toggle-item">
          <span class="auction-toggle-label">竞/昨</span>
          <label class="auction-toggle-switch">
            <input type="checkbox" :id="prefix + 'SortByJingYestToggle' + suffix" :checked="store[stateKey][tab].byJingYest" @change="onChange">
            <span class="auction-toggle-slider"></span>
          </label>
        </div>
      </div>
    `
  };

  // ============================================================
  // 页面组件（KeepAlive 缓存）
  // ============================================================
  const PageList = {
    name: 'PageList',
    components: { Page1Toolbar, JingYestRow, HighRatioStat, AuctionBoard },
    props: { prefix: { type: String, default: 'auction' } },
    setup(props) {
      const handlers = createHandlers(props.prefix);
      return { prefix: props.prefix, handlers };
    },
    template: `
      <div class="auction-page auction-page-1 active" :id="prefix + 'Page1'">
        <page1-toolbar :prefix="prefix"></page1-toolbar>
        <jing-yest-row :prefix="prefix" :page="1"></jing-yest-row>
        <high-ratio-stat :prefix="prefix" :page="1"></high-ratio-stat>
        <div class="auction-content" :id="prefix + 'Content'" @dblclick.stop="handlers.openEdit()">
          <auction-board :data-source="prefix"></auction-board>
        </div>
      </div>
    `
  };

  const PageTopic = {
    name: 'PageTopic',
    components: { Page2Toolbar, JingYestRow, HighRatioStat, Page2Board },
    props: { prefix: { type: String, default: 'auction' } },
    setup(props) {
      const handlers = createHandlers(props.prefix);
      return { prefix: props.prefix, handlers };
    },
    template: `
      <div class="auction-page auction-page-2 active" :id="prefix + 'Page2'">
        <page2-toolbar :prefix="prefix"></page2-toolbar>
        <jing-yest-row :prefix="prefix" :page="2"></jing-yest-row>
        <high-ratio-stat :prefix="prefix" :page="2"></high-ratio-stat>
        <div class="auction-content" :id="prefix + 'Content2'" @dblclick.stop="handlers.openCoreTopicModal()">
          <page2-board :data-source="prefix"></page2-board>
        </div>
      </div>
    `
  };

  const PageHistory = {
    name: 'PageHistory',
    components: { Page3Board },
    props: { prefix: { type: String, default: 'auction' } },
    setup(props) {
      return { prefix: props.prefix };
    },
    template: `
      <div class="auction-page auction-page-3 active" :id="prefix + 'Page3'">
        <div class="auction-content" :id="prefix + 'Content3'">
          <page3-board :data-source="prefix"></page3-board>
        </div>
      </div>
    `
  };

  const PageStats = {
    name: 'PageStats',
    components: { StatsBoard },
    props: { prefix: { type: String, default: 'auction' } },
    setup(props) {
      return { prefix: props.prefix };
    },
    template: `
      <div class="auction-page auction-page-4 active" :id="prefix + 'Page4'">
        <div class="auction-content" :id="prefix + 'Content4'">
          <stats-board :data-source="prefix"></stats-board>
        </div>
        <div class="auction-clear-all-btn" :id="prefix + 'ClearAllBtn'">全部清除</div>
      </div>
    `
  };

  // ============================================================
  // 滑动容器
  // ============================================================
  const PageContainer = {
    name: 'PageContainer',
    components: { PageList, PageTopic, PageHistory, PageStats },
    setup() {
      const { onTouchStart, onTouchEnd } = useSwipe(store);
      const activeComponent = Vue.computed(() => {
        const map = [PageList, PageTopic, PageHistory, PageStats];
        return map[store.currentPage] || PageList;
      });
      const activeKey = Vue.computed(() => store.currentGroup + '-page-' + store.currentPage);
      return { store, onTouchStart, onTouchEnd, activeComponent, activeKey };
    },
    template: `
      <div class="auction-swipe-container" id="auctionSwipeContainer"
           @touchstart="onTouchStart" @touchend="onTouchEnd">
        <div class="auction-swipe-wrapper" id="auctionSwipeWrapper"
             :style="{ transform: 'translateX(-' + (store.currentPage * 100) + '%)' }">
          <keep-alive>
            <component :is="activeComponent" :prefix="store.currentGroup" :key="activeKey"></component>
          </keep-alive>
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
    root.innerHTML = '';
    const app = Vue.createApp(AuctionApp);
    app.mount(root);
    window._auctionSingleApp = app;

    // 覆盖遗留 renderAuction，消除双轨渲染隐患
    window.renderAuction = function (dataSource) {
      if (dataSource === 'hot' || dataSource === 'auction') {
        if (store.currentGroup !== dataSource) store.actions.switchGroup(dataSource);
      }
    };
    window.renderAuctionPage2 = function (dataSource) {
      if ((dataSource === 'hot' || dataSource === 'auction') && store.currentGroup === dataSource) {
        store.actions.switchPage(1);
      }
    };
    window.renderAuctionPage3 = function (dataSource) {
      if ((dataSource === 'hot' || dataSource === 'auction') && store.currentGroup === dataSource) {
        store.actions.switchPage(2);
      }
    };
    window.renderAuctionStatsBoard = function (dataSource) {
      if ((dataSource === 'hot' || dataSource === 'auction') && store.currentGroup === dataSource) {
        store.actions.switchPage(3);
      }
    };
    window.renderAuctionPage4 = window.renderAuctionStatsBoard;

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
