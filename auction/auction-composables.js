/**
 * auction-composables.js
 * 早盘竞价看板可复用逻辑层（Vue 3 Composables）
 *
 * 设计原则：
 * 1. 完全信任 Vue 3 computed，移除手动记忆化层 useViewMemo。
 * 2. 每个 composable 职责单一：数据读取、排序、展开状态、手势、事件代理。
 * 3. 不直接操作 DOM，不写渲染副作用。
 * 4. 全局依赖按 window 注入，便于与遗留代码共存。
 */
(function () {
    'use strict';
    if (typeof window === 'undefined' || typeof document === 'undefined') return;

    const Vue = window.Vue || (typeof Vue !== 'undefined' ? Vue : null);
    const auctionStore = window.auctionStore;
    if (!Vue || !auctionStore) {
        console.warn('[AUCTION-COMPOSABLES] Vue 或 auctionStore 未就绪，跳过初始化');
        return;
    }

    // ============================================================
    // Composable: useAuctionData
    // ------------------------------------------------------------
    // 封装当前/前序交易日列表、标签状态缓存、信号集合等纯数据获取。
    // ============================================================
    function useAuctionData() {
        function getTodayList(dataSource) {
            return getTodayGroupList(dataSource);
        }

        function getPrevDate(date) {
            return getPreviousTradingDay(date);
        }

        function getPrevList(dataSource, date) {
            const prevDate = getPreviousTradingDay(date);
            return prevDate ? (getGroupData(dataSource)[prevDate] || []) : [];
        }

        function getPrevPrevList(dataSource, date) {
            const prevDate = getPreviousTradingDay(date);
            const prevPrevDate = prevDate ? getPreviousTradingDay(prevDate) : null;
            return prevPrevDate ? (getGroupData(dataSource)[prevPrevDate] || []) : [];
        }

        function ensureTopicCache(auctionList) {
            const needs = auctionList.some(function (it) {
                if (!it || !it.stock) return false;
                const note = getDisplayNote(it);
                return !note || extractTopics(note).length === 0;
            });
            if (needs) buildTopicCache();
        }

        function getTagStateCache(date) {
            return _buildTagStateCache(date);
        }

        function getHistRowMap(list) {
            const map = new Map();
            if (!list || !list.length) return map;
            for (let i = 0; i < list.length; i++) {
                const it = list[i];
                if (it && it.stock) map.set(it.stock.trim(), it);
            }
            return map;
        }

        function getHistoryCountMap(dataSource, date) {
            const auctionData = getGroupData(dataSource);
            const map = new Map();
            let d = date;
            for (let i = 0; i < 5 && d; i++) {
                const list = auctionData[d] || [];
                list.forEach(function (it) {
                    if (!it || !it.stock) return;
                    const name = it.stock.trim();
                    if (!map.has(name)) map.set(name, 0);
                    const v = getNumericVolume(it.volume);
                    const yv = getNumericVolume(it.yestVolume);
                    if (v !== null || yv !== null) map.set(name, map.get(name) + 1);
                });
                d = getPreviousTradingDay(d);
            }
            return map;
        }

        function getConfirmedSoldSet(auctionList, date) {
            const res = new Set();
            const sd = getStocksData();
            const dates = Object.keys(sd).filter(d => d <= date).sort();
            const names = new Set(auctionList.map(it => it.stock ? it.stock.trim() : '').filter(Boolean));
            if (names.size === 0) return res;
            const latest = {};
            dates.forEach(d => (sd[d] || []).forEach(s => {
                if (!s || !s.name) return;
                const n = s.name.trim();
                if (names.has(n)) latest[n] = s;
            }));
            Object.keys(latest).forEach(n => { if (latest[n].sold === true) res.add(n); });
            return res;
        }

        function getHighRatio(date, dataSource) {
            return getHighRatioStocksForDate(date, dataSource);
        }

        function getParallel(date, dataSource) {
            return getParallelStocksForDate(date, dataSource);
        }

        function getJingYest(date, dataSource) {
            return getJingYestHighlightSetForDate(date, dataSource);
        }

        function getRatioDiff(date, dataSource) {
            return getRatioDiffInfoForDate(date, dataSource);
        }

        function getSignalSets(date, dataSource, options) {
            const opts = options || {};
            return {
                highRatio: getHighRatio(date, dataSource),
                parallel: opts.parallel ? getParallel(date, dataSource) : null,
                jingYest: getJingYest(date, dataSource),
                ratioDiff: opts.ratioDiff ? getRatioDiff(date, dataSource) : null
            };
        }

        function getDuibanTushiLink() {
            const duibanList = getTodayDuiban();
            for (let i = 0; i < duibanList.length; i++) {
                const tushi = (duibanList[i] && duibanList[i].tushi) || '';
                if (tushi && (tushi.startsWith('http://') || tushi.startsWith('https://'))) return tushi;
            }
            return '';
        }

        function getObsContext(date, dataSource) {
            const prevDate = getPreviousTradingDay(date);
            return {
                obsStocks: getJingYestHighlightSetForDate(prevDate, dataSource),
                autoAddedSet: new Set(JSON.parse(localStorage.getItem('obsAutoAdded_' + date) || '[]')),
                obsBoughtSet: new Set(JSON.parse(localStorage.getItem('obsBought_' + date) || '[]'))
            };
        }

        return {
            getTodayList, getPrevDate, getPrevList, getPrevPrevList,
            ensureTopicCache, getTagStateCache, getHistRowMap, getHistoryCountMap,
            getConfirmedSoldSet,
            getHighRatio, getParallel, getJingYest, getRatioDiff, getSignalSets,
            getDuibanTushiLink, getObsContext
        };
    }

    // ============================================================
    // Composable: useAuctionSort
    // ------------------------------------------------------------
    // 封装 page1/page2 的排序逻辑，纯函数无副作用。
    // ============================================================
    function useAuctionSort() {
        function getNumericVolumeSafe(v) {
            return getNumericVolume(v);
        }
        function getDigitCountSafe(v) {
            return getDigitCount(v);
        }

        function sortPage1RenderOrder(renderOrder, auctionList, ctx) {
            const { sortState, historyCountMap, prevDayMap, signalSets } = ctx;
            const { highRatio, parallel, jingYest, ratioDiff } = signalSets || {};
            const jingYestHighlightSet = jingYest;

            if (sortState.byData) {
                return renderOrder.map((idx) => ({
                    idx,
                    c: auctionList[idx] && auctionList[idx].stock
                        ? (historyCountMap.get(auctionList[idx].stock.trim()) || 0)
                        : 0
                })).sort((a, b) => b.c - a.c).map(x => x.idx);
            }

            if (sortState.byRatio) {
                return renderOrder.map((idx, pos) => {
                    const it = auctionList[idx];
                    const nm = it && it.stock ? it.stock.trim() : '';
                    const tv = it ? getNumericVolumeSafe(it.volume) : null;
                    const yv = it ? getNumericVolumeSafe(it.yestVolume) : null;
                    let r = null;
                    if (tv !== null && tv !== 0) {
                        const pi = prevDayMap.get(nm);
                        const pv = pi ? getNumericVolumeSafe(pi.volume) : null;
                        if (pv !== null && pv !== 0) r = tv / pv;
                    }
                    const dg = (tv !== null && yv !== null) ? Math.abs(getDigitCountSafe(tv) - getDigitCountSafe(yv)) : null;
                    const hr = nm && highRatio && highRatio.stockNames.has(nm);
                    const tier = hr ? 0 : (r !== null ? 1 : 2);
                    return { idx, pos, r, dg, tier };
                }).sort((a, b) => {
                    if (a.tier !== b.tier) return a.tier - b.tier;
                    if (a.tier === 0 || a.tier === 1) {
                        if (a.dg === null && b.dg === null) return a.pos - b.pos;
                        if (a.dg === null) return 1;
                        if (b.dg === null) return -1;
                        if (a.dg !== b.dg) return a.dg - b.dg;
                        return b.r - a.r;
                    }
                    return a.pos - b.pos;
                }).map(x => x.idx);
            }

            if (sortState.byParallel) {
                const ps = parallel;
                const info = ratioDiff;
                if (sortState.byJingYest) {
                    return renderOrder.map((idx, pos) => {
                        const nm = auctionList[idx] && auctionList[idx].stock ? auctionList[idx].stock.trim() : '';
                        const ip = ps && ps.has(nm);
                        const ih = nm && jingYestHighlightSet && jingYestHighlightSet.has(nm);
                        const tier = ih ? 0 : (ip ? 1 : 2);
                        const fi = (tier === 0 || tier === 1) ? (info ? info.get(nm) : null) : null;
                        return { idx, pos, diff: fi ? fi.diff : null, dg: fi ? fi.digitGap : null, tier };
                    }).sort((a, b) => {
                        if (a.tier !== b.tier) return a.tier - b.tier;
                        if (a.tier === 0 || a.tier === 1) {
                            if (a.dg === null && b.dg === null) return a.pos - b.pos;
                            if (a.dg === null) return 1;
                            if (b.dg === null) return -1;
                            if (a.dg !== b.dg) return a.dg - b.dg;
                            return b.diff - a.diff;
                        }
                        return a.pos - b.pos;
                    }).map(x => x.idx);
                }
                return renderOrder.map((idx, pos) => {
                    const nm = auctionList[idx] && auctionList[idx].stock ? auctionList[idx].stock.trim() : '';
                    const q = nm && ps && ps.has(nm);
                    const fi = q ? (info ? info.get(nm) : null) : null;
                    return { idx, pos, q, diff: fi ? fi.diff : null, dg: fi ? fi.digitGap : null };
                }).sort((a, b) => {
                    if (a.q !== b.q) return a.q ? -1 : 1;
                    if (a.q) {
                        if (a.dg === null && b.dg === null) return a.pos - b.pos;
                        if (a.dg === null) return 1;
                        if (b.dg === null) return -1;
                        if (a.dg !== b.dg) return a.dg - b.dg;
                        return b.diff - a.diff;
                    }
                    return a.pos - b.pos;
                }).map(x => x.idx);
            }

            return renderOrder;
        }

        function sortPage2GroupStocks(stocks, ctx) {
            const { auctionByName, prevAuctionByName, sortState, signalSets, highRatioInfo } = ctx;
            const { parallel, jingYest, ratioDiff } = signalSets || {};
            const jingYestHighlightSet = jingYest;
            const parallelStockNames = parallel;

            if (sortState.byRatio) {
                return stocks.map((s, pos) => {
                    const nm = s.stock ? s.stock.trim() : '';
                    if (!nm) return { s, pos, ratio: null, digitGap: null, tier: 2 };
                    const ti = auctionByName.get(nm);
                    const tv = ti ? getNumericVolumeSafe(ti.volume) : null;
                    const yv = ti ? getNumericVolumeSafe(ti.yestVolume) : null;
                    let r = null;
                    if (tv !== null && tv !== 0) {
                        const pi = prevAuctionByName.get(nm);
                        const pv = pi ? getNumericVolumeSafe(pi.volume) : null;
                        if (pv !== null && pv !== 0) r = tv / pv;
                    }
                    const dg = (tv !== null && yv !== null) ? Math.abs(getDigitCountSafe(tv) - getDigitCountSafe(yv)) : null;
                    const hr = nm && highRatioInfo && highRatioInfo.stockNames.has(nm);
                    const tier = hr ? 0 : (r !== null ? 1 : 2);
                    return { s, pos, ratio: r, digitGap: dg, tier };
                }).sort((a, b) => {
                    if (a.tier !== b.tier) return a.tier - b.tier;
                    if (a.tier === 0 || a.tier === 1) {
                        if (a.digitGap === null && b.digitGap === null) return a.pos - b.pos;
                        if (a.digitGap === null) return 1;
                        if (b.digitGap === null) return -1;
                        if (a.digitGap !== b.digitGap) return a.digitGap - b.digitGap;
                        return b.ratio - a.ratio;
                    }
                    return a.pos - b.pos;
                }).map(x => x.s);
            }

            if (sortState.byParallel && parallelStockNames) {
                const info = ratioDiff;
                if (sortState.byJingYest) {
                    return stocks.map((s, pos) => {
                        const nm = s.stock ? s.stock.trim() : '';
                        const ip = parallelStockNames.has(nm);
                        const ih = nm && jingYestHighlightSet && jingYestHighlightSet.has(nm);
                        const tier = ih ? 0 : (ip ? 1 : 2);
                        const fi = (tier === 0 || tier === 1) ? (info ? info.get(nm) : null) : null;
                        return { s, pos, diff: fi ? fi.diff : null, digitGap: fi ? fi.digitGap : null, tier };
                    }).sort((a, b) => {
                        if (a.tier !== b.tier) return a.tier - b.tier;
                        if (a.tier === 0 || a.tier === 1) {
                            if (a.digitGap === null && b.digitGap === null) return a.pos - b.pos;
                            if (a.digitGap === null) return 1;
                            if (b.digitGap === null) return -1;
                            if (a.digitGap !== b.digitGap) return a.digitGap - b.digitGap;
                            return b.diff - a.diff;
                        }
                        return a.pos - b.pos;
                    }).map(x => x.s);
                }
                return stocks.map((s, pos) => {
                    const nm = s.stock ? s.stock.trim() : '';
                    const q = nm && parallelStockNames.has(nm);
                    const fi = q ? (info ? info.get(nm) : null) : null;
                    return { s, pos, q, diff: fi ? fi.diff : null, digitGap: fi ? fi.digitGap : null };
                }).sort((a, b) => {
                    if (a.q !== b.q) return a.q ? -1 : 1;
                    if (a.q) {
                        if (a.digitGap === null && b.digitGap === null) return a.pos - b.pos;
                        if (a.digitGap === null) return 1;
                        if (b.digitGap === null) return -1;
                        if (a.digitGap !== b.digitGap) return a.digitGap - b.digitGap;
                        return b.diff - a.diff;
                    }
                    return a.pos - b.pos;
                }).map(x => x.s);
            }

            return stocks;
        }

        return { sortPage1RenderOrder, sortPage2GroupStocks };
    }

    // ============================================================
    // Composable: useAuctionExpand
    // ------------------------------------------------------------
    // 封装股票趋势面板与题材分组的展开/收起状态计算（无副作用）。
    // 真实 DOM 展开/恢复由 useAuctionEvents / 遗留全局函数在组件事件后执行。
    // ============================================================
    function useAuctionExpand() {
        function isStockExpanded(stockName, dataSource) {
            if (!stockName) return false;
            const tab = dataSource === 'hot' ? 'hot' : 'auction';
            return auctionStore.currentGroup === tab && auctionStore.expandedStocks.has(stockName);
        }

        function isP2TopicExpanded(topic, dataSource) {
            if (!topic) return false;
            const key = (dataSource === 'hot' ? 'hot' : 'auction') + '|' + topic;
            return auctionStore.p2ExpandedTopics.has(key);
        }

        function isExpandAll(page, dataSource) {
            const tab = dataSource === 'hot' ? 'hot' : 'auction';
            if (page === 2) return auctionStore.expandAllP2;
            return auctionStore.expandAll;
        }

        return { isStockExpanded, isP2TopicExpanded, isExpandAll };
    }

    // ============================================================
    // Composable: useAuctionGesture
    // ------------------------------------------------------------
    // 封装滑动容器的手势处理逻辑。
    // ============================================================
    function useAuctionGesture() {
        function useSwipe(store) {
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
                if (!store || !store.actions) return;
                if (dx < 0 && store.currentPage < 3) store.actions.switchPage(store.currentPage + 1);
                else if (dx > 0 && store.currentPage > 0) store.actions.switchPage(store.currentPage - 1);
            }

            return { onTouchStart, onTouchEnd };
        }

        return { useSwipe };
    }

    // ============================================================
    // Composable: useAuctionEvents
    // ------------------------------------------------------------
    // 统一包装全局交互函数，提供安全调用与清晰降级。
    // 组件中不再直接调用 window.xxx，而是通过此 composable 返回的 handlers。
    // ============================================================
    function useAuctionEvents() {
        function safeCall(fn, ...args) {
            try {
                if (typeof fn === 'function') return fn(...args);
            } catch (e) {
                console.warn('[AUCTION-EVENTS] 全局函数调用失败:', e);
            }
            return undefined;
        }

        function createHandlers(dataSource) {
            const ds = dataSource === 'hot' ? 'hot' : 'auction';
            const actions = auctionStore.actions;

            return {
                // 头部
                toggleBoard: () => actions.toggleBoard(),
                switchGroup: (group) => actions.switchGroup(group),
                switchPage: (page) => actions.switchPage(page),

                // Page1 工具栏
                onExpandAllChange: (page, checked) => {
                    actions.setExpandAll(checked, page);
                    if (page === 2) {
                        if (checked) actions.expandAllTrendPanelsP2(ds);
                        else actions.restoreExpandedTopicGroupsP2(ds);
                    } else {
                        if (checked) actions.expandAllTrendPanels(ds);
                        else actions.restoreExpandedTrendPanels(ds);
                    }
                },
                onSortChange: (page, key, checked) => actions.setSortState(page, key, checked),
                toggleSortHelp: (panelId) => actions.toggleSortHelp(panelId),

                // Page1 行交互
                onNumberClick: (index, e) => {
                    if (e) e.stopPropagation();
                    actions.toggleTrendPanel(index);
                },
                onRatioClick: (index, e) => {
                    if (e) e.stopPropagation();
                    actions.toggleRowSelect(index);
                },
                onYestClick: (el, note, lpState, e) => {
                    if (lpState && (lpState.isLongPress || lpState.isMoved)) return;
                    const now = Date.now();
                    if (lpState && (now - lpState.lastTapTime < 300)) return;
                    if (lpState) lpState.lastTapTime = now;
                    if (note && el) {
                        if (e) { e.preventDefault(); e.stopPropagation(); }
                        actions.showNotePopup(el, note);
                    }
                },
                onYestContext: (e) => {
                    if (e) { e.preventDefault(); e.stopPropagation(); }
                    actions.openEdit(ds);
                },
                onYestLongPress: (index, el) => actions.showNoteInput(index, el),
                onNameClick: (stockName, lpState, e) => {
                    if (lpState && (lpState.isLongPress || lpState.isMoved)) return;
                    if (stockName && stockName !== '-') {
                        if (e) e.stopPropagation();
                        actions.jumpToPage2(stockName);
                    }
                },
                onNameDblClick: (note, yestEl, e) => {
                    if (e) e.stopPropagation();
                    if (note && yestEl) actions.showNotePopup(yestEl, note);
                },
                onNameContext: (e) => { if (e) e.preventDefault(); },
                onNameLongPress: (stockName) => actions.showBuyPrompt(stockName),

                // Page2
                onStrengthSortClick: () => actions.toggleStrengthSort(),
                onPage2StockClick: (stockName, e) => {
                    if (e) e.stopPropagation();
                    if (stockName && stockName !== '-') actions.jumpToPage1(stockName);
                },
                onPage2RowClick: (row, e) => {
                    if (e) e.stopPropagation();
                    if (row.topicAllowsExpand && row.stock && row.stock !== '-' && row.rowKey) {
                        safeCall(window.toggleAuctionTrendPanelP2, row.rowKey, row.stock);
                    }
                },
                onGroupExpandClick: (topic, e) => {
                    if (e) e.stopPropagation();
                    actions.toggleTopicGroupTrendPanels(topic);
                },
                onTopicLongPress: (el) => {
                    const sn = el && el.getAttribute ? el.getAttribute('data-stock') : null;
                    if (sn) actions.openAuctionNoteEditFromPage2(sn);
                },
                openCoreTopicModal: () => actions.openCoreTopicModal(),
                openEdit: () => actions.openEdit(ds),

                // Page3
                copyAll: (topic) => actions.copyAllTopicStocks(topic, ds),
                copy5: (topic) => actions.copyTopicStocks(topic, 5, ds),
                copy2: (topic) => actions.copyTopicStocks(topic, 2, ds)
            };
        }

        return { createHandlers, safeCall };
    }

    // 暴露到 window
    window.useAuctionData = useAuctionData;
    window.useAuctionSort = useAuctionSort;
    window.useAuctionExpand = useAuctionExpand;
    window.useAuctionGesture = useAuctionGesture;
    window.useAuctionEvents = useAuctionEvents;

    if (typeof _dbgLog === 'function') _dbgLog('[AUCTION-COMPOSABLES] 可复用逻辑层已就绪');
})();
