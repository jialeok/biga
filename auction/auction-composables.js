/**
 * auction-composables.js
 * 早盘竞价看板可复用逻辑层（Vue 3 Composables）
 *
 * 设计原则：
 * 1. 每个 composable 只封装一类逻辑，不直接操作 DOM、不写副作用。
 * 2. 业务口径与性能策略（指纹记忆化、可见性懒算、信号缓存）保持与原实现一致。
 * 3. 所有函数均可在 setup() 或非响应式工具函数中调用；闭包状态由 composable 自身持有。
 * 4. 全局依赖（auctionStore / Vue / getGroupData 等）按 window 注入，便于与遗留代码共存。
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
    // Composable: useViewMemo
    // ------------------------------------------------------------
    // 封装视图数据记忆化层：_viewMemo / _buildViewFp / _memoizedView。
    // 通过轻量指纹避免同一帧内多次重算，并在非当前 tab/页时懒算。
    // ============================================================
    function useViewMemo() {
        const _viewMemo = { p1: {}, p2: {}, p3: {}, stats: {} };
        const _VIEW_EMPTY = {
            p1: {
                date: '', dataSource: 'auction', rawCount: 0, items: [],
                obsIndices: [], regularIndices: [], hiddenObsIndices: [],
                stats: {
                    todayStrength: null, yesterdayStrength: null, strongCount: 0,
                    totalCount: 0, highRatioCount: 0, jingYestCount: 0
                },
                duibanTushiLink: ''
            },
            p2: { empty: true, placeholder: '暂无数据' },
            p3: { empty: true, placeholder: '暂无数据' },
            stats: { empty: true }
        };
        const _PERF_BOARD_NAME = {
            p1: 'AuctionBoard(page1)', p2: 'Page2Board',
            p3: 'Page3Board', stats: 'StatsBoard'
        };

        /** 行级轻量指纹：只拼影响显示的字段 */
        function fpRow(r) {
            if (!r) return '';
            return (r.stock || '') + '' + (r.volume || '') + '' +
                (r.yestVolume !== undefined && r.yestVolume !== '' ? r.yestVolume : (r.yest_volume || '')) + '' +
                (r.note || '') + '' + (r.topics || '') + '' + (r.changePct || '') +
                (r.selected ? 'S' : '') + (r.in_watchlist === false ? 'W' : '') + (r.obsAutoAdded ? 'O' : '');
        }

        /** 列表指纹 */
        function fpList(list) {
            if (!list || !list.length) return '#';
            let s = '#' + list.length;
            for (let i = 0; i < list.length; i++) { s += '|' + fpRow(list[i]); }
            return s;
        }

        /** 标签权威源行指纹：五元组决定所有上标/底色 */
        function fpTags(list) {
            if (!list || !list.length) return '#';
            let s = '#' + list.length;
            for (let i = 0; i < list.length; i++) {
                const r = list[i]; if (!r) continue;
                s += '|' + (r.name || '') + (r.bought ? 'B' : '') + (r.sold ? 'S' : '') + (r.hold ? 'H' : '') + (r.inheritedHold ? 'I' : '');
            }
            return s;
        }

        /** confirmedSoldSet 的全历史 sold 兜底指纹 */
        function fpSoldAll(sd) {
            let s = '';
            for (const d in sd) {
                const arr = sd[d]; if (!arr) continue;
                for (let i = 0; i < arr.length; i++) {
                    const r = arr[i];
                    if (r && r.sold === true && r.name) s += r.name.trim() + ',';
                }
            }
            return s;
        }

        /** 首页竞价量列的图示链接指纹 */
        function fpDuibanLink() {
            try {
                const duibanList = getTodayDuiban();
                for (let i = 0; i < duibanList.length; i++) {
                    const tushi = (duibanList[i] && duibanList[i].tushi) || '';
                    if (tushi && (tushi.startsWith('http://') || tushi.startsWith('https://'))) return tushi;
                }
            } catch (e) {}
            return '';
        }

        /**
         * 构建指定看板的输入指纹。
         * 返回 { str, rankRef }：str 为字符串指纹；rankRef 为 rank 数据引用（引用比对，不进字符串）。
         */
        function buildViewFp(slot, dataSource) {
            const g = getGroupData(dataSource);
            const prevDate = getPreviousTradingDay(currentDate);
            const prevPrevDate = prevDate ? getPreviousTradingDay(prevDate) : null;
            const sd = auctionStore.stocksData || {};
            const tab = dataSource === 'hot' ? 'hot' : 'auction';
            const topicVer = (window._topicCacheVersion || 0);
            let str = currentDate + '|' + tab + '|' + slot + '|v' + topicVer;
            let rankRef = null;

            if (slot === 'p1') {
                const ss = auctionStore.sortState[tab] || {};
                str += '|L' + fpList(g[currentDate]) + 'P' + fpList(g[prevDate]) + 'Q' + fpList(g[prevPrevDate]);
                str += '|T' + fpTags(sd[currentDate]) + fpTags(sd[prevDate]) + '|S' + fpSoldAll(sd);
                str += '|O' + (localStorage.getItem('obsAutoAdded_' + currentDate) || '') + (localStorage.getItem('obsBought_' + currentDate) || '');
                str += '|R' + (ss.byData ? 1 : 0) + (ss.byRatio ? 1 : 0) + (ss.byParallel ? 1 : 0) + (ss.byJingYest ? 1 : 0);
                str += '|H' + (auctionStore.highlightStock || '') + '|D' + fpDuibanLink();
            } else if (slot === 'p2') {
                const ss2 = auctionStore.sortStateP2[tab] || {};
                str += '|L' + fpList(g[currentDate]) + 'P' + fpList(g[prevDate]);
                str += '|T' + fpTags(sd[currentDate]) + fpTags(sd[prevDate]);
                str += '|R' + (ss2.byRatio ? 1 : 0) + (ss2.byParallel ? 1 : 0) + (ss2.byJingYest ? 1 : 0) + (auctionStore.strengthSortEnabled ? 1 : 0);
                str += '|H' + (auctionStore.highlightStock || '');
                str += '|C' + (localStorage.getItem('coreTopics') || '');
                rankRef = getRankData();
            } else if (slot === 'p3') {
                const days = getLastNTradingDays(6);
                str += '|D' + days.join(',');
                for (let i = 0; i < days.length; i++) str += '|' + fpList(g[days[i]]);
                str += '|R' + (auctionStore.strengthSortEnabled ? 1 : 0);
                str += '|C' + (localStorage.getItem('coreTopics') || '');
                rankRef = getRankData();
            } else { // stats
                const yest = getYesterdayDate(currentDate);
                str += '|L' + fpList(g[currentDate]) + 'Y' + fpList(g[yest]);
                str += '|C' + (localStorage.getItem('coreTopics') || '');
            }
            return { str, rankRef };
        }

        /**
         * 记忆化视图入口。
         * @param {string} slot - 'p1' | 'p2' | 'p3' | 'stats'
         * @param {string} dataSource - 'auction' | 'hot'
         * @param {number|null} pageIdx - 页码；null 表示常驻看板（如 stats）
         * @param {Function} computeFn - 真实计算函数
         */
        function memoizedView(slot, dataSource, pageIdx, computeFn) {
            const storeDate = auctionStore.currentDate;
            const storeGroup = auctionStore.currentGroup;
            const storePage = auctionStore.currentPage;
            const storeVer = auctionStore.stocksDataVersion;
            const tab = dataSource === 'hot' ? 'hot' : 'auction';
            const bucket = _viewMemo[slot];
            let entry = bucket[tab];

            // 日期撕裂兜底：不返回可能过期的缓存，强制重算
            if (typeof currentDate !== 'undefined' && storeDate !== currentDate) {
                const stack = (new Error().stack || '').split('\n').slice(2, 5).join(' <- ');
                _dbgLog('[VUE-MEMO-WARN] 日期撕裂：auctionStore.currentDate=' + storeDate + ' ≠ 全局currentDate=' + currentDate + '（' + slot + '/' + tab + '）。已清空本槽位 memo 并强制重算。来源: ' + stack);
                delete bucket[tab];
                entry = undefined;
            }

            const visible = (storeGroup === tab) && (pageIdx === null || storePage === pageIdx);
            if (!visible) {
                if (window._DBG_VERBOSE) {
                    _dbgLog('[VUE-MEMO-DEBUG] ' + slot + '/' + tab + ' 非当前tab(storeGroup=' + storeGroup + ')，跳过重算，返回' + (entry ? '缓存结果' : '空壳'));
                }
                return (entry && entry.result) ? entry.result : _VIEW_EMPTY[slot];
            }

            const fp = buildViewFp(slot, dataSource);
            if (entry && entry.result && entry.fp === fp.str && entry.rankRef === fp.rankRef) {
                if (slot === 'p1') {
                    _dbgLog('[VUE-MEMO-RETURN] ' + slot + '/' + tab + '/' + currentDate + ' 指纹命中返回缓存 items=' + (entry.result.items ? entry.result.items.length : '?'));
                }
                return entry.result;
            }

            const __t0 = performance.now();
            const result = computeFn(dataSource);
            const __dt = performance.now() - __t0;
            window._perfLog && window._perfLog(_PERF_BOARD_NAME[slot] || slot, dataSource, __dt);

            if (slot === 'p1') {
                _dbgLog('[VUE-MEMO-DEBUG] ' + slot + '/' + tab + ' 指纹未命中，重算完成：items=' + (result.items ? result.items.length : '?') +
                    '，耗时' + __dt.toFixed(1) + 'ms' + (entry ? '（上次结果条数=' + (entry.result.items ? entry.result.items.length : '?') + '）' : '（首次计算）'));
            }
            bucket[tab] = { fp: fp.str, rankRef: fp.rankRef, result };
            if (slot === 'p1') {
                _dbgLog('[VUE-MEMO-RETURN] ' + slot + '/' + tab + '/' + currentDate + ' 重算后返回 items=' + (result.items ? result.items.length : '?'));
            }
            return result;
        }

        function clearViewMemo() {
            _viewMemo.p1 = {}; _viewMemo.p2 = {}; _viewMemo.p3 = {}; _viewMemo.stats = {};
        }

        // 暴露调试/外部工具函数
        window._clearViewMemo = clearViewMemo;
        window._viewFpList = fpList;

        return {
            fpRow, fpList, fpTags, fpSoldAll, fpDuibanLink,
            buildViewFp, memoizedView, clearViewMemo,
            _viewMemo, _VIEW_EMPTY
        };
    }

    // ============================================================
    // Composable: useSignalCache
    // ------------------------------------------------------------
    // 封装竞/昨/平行/环比/差值等信号集合的全局指纹缓存。
    // ============================================================
    function useSignalCache() {
        const signalCache = window._signalCache || {};
        window._signalCache = signalCache;

        function fpList(list) {
            if (!list || !list.length) return '#';
            let s = '#' + list.length;
            for (let i = 0; i < list.length; i++) {
                const r = list[i]; if (!r) continue;
                s += '|' + (r.stock || '') + '' + (r.volume || '') + '' +
                    (r.yestVolume !== undefined && r.yestVolume !== '' ? r.yestVolume : (r.yest_volume || '')) + '' +
                    (r.note || '') + '' + (r.topics || '') + '' + (r.changePct || '') +
                    (r.selected ? 'S' : '') + (r.in_watchlist === false ? 'W' : '') + (r.obsAutoAdded ? 'O' : '');
            }
            return s;
        }

        function signalFpFor(dateStr, dataSource) {
            const g = getGroupData(dataSource);
            const t1 = getPreviousTradingDay(dateStr);
            const prim = dataSource === 'hot' ? _hotFullRowCache : _auctionMemCache;
            const fall = dataSource === 'hot' ? _auctionMemCache : _hotFullRowCache;
            return fpList(g[dateStr]) + '' + fpList(prim[t1]) + '' + fpList(fall[t1]);
        }

        function get(key) { return signalCache[key]; }
        function set(key, value) { signalCache[key] = value; return value; }

        window._signalFpFor = signalFpFor;

        return { signalCache, fpList, signalFpFor, get, set };
    }

    // ============================================================
    // Composable: useAuctionData
    // ------------------------------------------------------------
    // 封装当前/前序交易日列表、标签状态缓存、高放量集合、平行/竞昨信号等数据获取。
    // 所有函数均为纯计算，不操作 DOM。
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

        /** 若当天存在缺少题材的股票，则按需构建 topic cache */
        function ensureTopicCache(auctionList) {
            const needs = auctionList.some(function (it) {
                if (!it || !it.stock) return false;
                const note = getDisplayNote(it);
                return !note || extractTopics(note).length === 0;
            });
            if (needs) buildTopicCache();
        }

        /** 预建标签派生缓存 */
        function getTagStateCache(date) {
            return _buildTagStateCache(date);
        }

        /** 预建历史行 Map，供排序/箭头 O(1) 查询 */
        function getHistRowMap(list) {
            const map = new Map();
            if (!list || !list.length) return map;
            for (let i = 0; i < list.length; i++) {
                const it = list[i];
                if (it && it.stock) map.set(it.stock.trim(), it);
            }
            return map;
        }

        /** 近 5 个交易日（含今天）每只股票有数据的天数 */
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

        /** confirmedSoldSet 按 (date, 股票名单, stocksDataVersion) 缓存 */
        function getConfirmedSoldSet(auctionList, date, version) {
            const namesKey = auctionList.map(function (it) { return it && it.stock ? it.stock.trim() : ''; }).filter(Boolean).sort().join(',');
            const key = date + '|v' + (version || 0) + '|' + namesKey;
            if (!window._confirmedSoldCache) window._confirmedSoldCache = {};
            if (window._confirmedSoldCache[key]) return window._confirmedSoldCache[key];

            const res = new Set();
            const sd = getStocksData();
            const dates = Object.keys(sd).filter(d => d <= date).sort();
            const names = new Set(auctionList.map(it => it.stock ? it.stock.trim() : '').filter(Boolean));
            if (names.size === 0) {
                window._confirmedSoldCache[key] = res;
                return res;
            }
            const latest = {};
            dates.forEach(d => (sd[d] || []).forEach(s => {
                if (!s || !s.name) return;
                const n = s.name.trim();
                if (names.has(n)) latest[n] = s;
            }));
            Object.keys(latest).forEach(n => { if (latest[n].sold === true) res.add(n); });
            window._confirmedSoldCache[key] = res;
            return res;
        }

        /** 高放量集合 */
        function getHighRatio(date, dataSource) {
            return getHighRatioStocksForDate(date, dataSource);
        }

        /** 平行信号集合 */
        function getParallel(date, dataSource) {
            return getParallelStocksForDate(date, dataSource);
        }

        /** 竞昨高亮集合 */
        function getJingYest(date, dataSource) {
            return getJingYestHighlightSetForDate(date, dataSource);
        }

        /** 环比差值信息 Map */
        function getRatioDiff(date, dataSource) {
            return getRatioDiffInfoForDate(date, dataSource);
        }

        /**
         * 一次性获取当前日期的信号集合。
         * 默认返回高放量 + 竞昨；parallel / ratioDiff 按需开启，以匹配原实现的懒算策略。
         */
        function getSignalSets(date, dataSource, options) {
            const opts = options || {};
            return {
                highRatio: getHighRatio(date, dataSource),
                parallel: opts.parallel ? getParallel(date, dataSource) : null,
                jingYest: getJingYest(date, dataSource),
                ratioDiff: opts.ratioDiff ? getRatioDiff(date, dataSource) : null
            };
        }

        /** 首页竞价量列的图示链接 */
        function getDuibanTushiLink() {
            const duibanList = getTodayDuiban();
            for (let i = 0; i < duibanList.length; i++) {
                const tushi = (duibanList[i] && duibanList[i].tushi) || '';
                if (tushi && (tushi.startsWith('http://') || tushi.startsWith('https://'))) return tushi;
            }
            return '';
        }

        /** 观察组相关集合（前一日竞昨信号、autoAdded、obsBought） */
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
    // 封装 page1/page2 的排序逻辑。
    // 注意：所有 expensive 信号集合应由调用方通过 getSignalSets 一次性取好传入，
    // 避免同一计算内重复调用。
    // ============================================================
    function useAuctionSort() {
        function getNumericVolumeSafe(v) {
            return getNumericVolume(v);
        }
        function getDigitCountSafe(v) {
            return getDigitCount(v);
        }

        /**
         * Page1 渲染顺序排序。
         * @param {number[]} renderOrder - 原始索引数组 [0,1,2,...]
         * @param {Object[]} auctionList - 当日列表
         * @param {Object} ctx - 包含 sortState / historyCountMap / prevDayMap / signalSets
         */
        function sortPage1RenderOrder(renderOrder, auctionList, ctx) {
            const {
                sortState,
                historyCountMap,
                prevDayMap,
                signalSets
            } = ctx;
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

        /**
         * Page2 题材组内排序。
         * @param {Object[]} stocks - 组内股票
         * @param {Object} ctx - 包含 auctionByName / prevAuctionByName / sortState / signalSets / highRatioInfo
         */
        function sortPage2GroupStocks(stocks, ctx) {
            const {
                auctionByName,
                prevAuctionByName,
                sortState,
                signalSets,
                highRatioInfo
            } = ctx;
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
    // 封装股票趋势面板与题材分组的展开/收起副作用。
    // 这些副作用需要在 Vue post-flush 后执行，以复用/恢复 DOM 状态。
    // ============================================================
    function useAuctionExpand() {
        function safeGlobal(fn, ...args) {
            try { if (typeof fn === 'function') return fn(...args); } catch (e) { _dbgLog('[AUCTION-EXPAND] 全局函数调用失败:', e); }
        }

        /** Page1 看板渲染后：按 ExpandAllToggle 状态展开或恢复 */
        function afterBoardRender(props, view) {
            const _p = props.dataSource === 'hot' ? 'hot' : 'auction';
            const _set = safeGlobal(window._getExpandedStocksSet, _p);
            _dbgLogVerbose('[RESTORE-VUE] _afterBoardRender 触发 dataSource=' + _p + ' currentDate=' + currentDate + ' storeVer=' + (auctionStore && auctionStore.stocksDataVersion || 0) + ' expandedSet=' + (_set ? [..._set].join('、') : 'null') + ' size=' + (_set ? _set.size : 0));
            if (document.getElementById(_p + 'ExpandAllToggle')?.checked) {
                safeGlobal(window.expandAllAuctionTrendPanels, _p);
            } else {
                safeGlobal(window.restoreExpandedAuctionTrendPanels, _p);
            }
        }

        /** Page2 看板渲染后：更新头部计数器并按 ExpandAllToggle2 状态展开/恢复 */
        function afterPage2Render(props, view) {
            if (view.empty) return;
            const _p = props.dataSource === 'hot' ? 'hot' : 'auction';

            // 第二页头部：竞/昨数 / 竞放量数 / 箭头
            const jingYestCountEl2 = document.getElementById(_p + 'JingYestCount2');
            if (jingYestCountEl2) jingYestCountEl2.textContent = view.stats.jingYestCount || '-';
            const highRatioCountEl2 = document.getElementById(_p + 'HighRatioCount2');
            if (highRatioCountEl2) highRatioCountEl2.textContent = view.stats.highRatioCount;
            const highRatioArrowEl2 = document.getElementById(_p + 'HighRatioArrow2');
            if (highRatioArrowEl2) {
                const prevDateForRatio2 = getPreviousTradingDay(currentDate);
                if (prevDateForRatio2) {
                    const yHigh2 = getHighRatioStocksForDate(prevDateForRatio2, props.dataSource);
                    if (view.stats.highRatioCount > yHigh2.count) { highRatioArrowEl2.textContent = ' ⬆'; highRatioArrowEl2.style.color = '#dc2626'; }
                    else if (view.stats.highRatioCount < yHigh2.count) { highRatioArrowEl2.textContent = ' ⬇'; highRatioArrowEl2.style.color = '#16a34a'; }
                    else { highRatioArrowEl2.textContent = ' -'; highRatioArrowEl2.style.color = '#92400e'; }
                } else { highRatioArrowEl2.textContent = ''; }
            }

            // 全部展开开关打开时批量展开，否则恢复用户手动展开的题材组
            if (document.getElementById(_p + 'ExpandAllToggle2')?.checked) {
                safeGlobal(window.expandAllAuctionTrendPanelsP2, _p);
            } else {
                safeGlobal(window.restoreExpandedTopicGroupsP2, props.dataSource);
            }
        }

        return { afterBoardRender, afterPage2Render };
    }

    // ============================================================
    // Composable: useAuctionGesture
    // ------------------------------------------------------------
    // 封装滑动容器的手势处理逻辑，供 PageContainer 等组件使用。
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

    // 暴露到 window，供 auction-components.js 使用
    window.useViewMemo = useViewMemo;
    window.useSignalCache = useSignalCache;
    window.useAuctionData = useAuctionData;
    window.useAuctionSort = useAuctionSort;
    window.useAuctionExpand = useAuctionExpand;
    window.useAuctionGesture = useAuctionGesture;

    _dbgLog && _dbgLog('[AUCTION-COMPOSABLES] 可复用逻辑层已就绪');
})();
