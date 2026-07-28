        (function () {
            if (typeof Vue === 'undefined' || !window.auctionStore) {
                console.warn('[AUCTION-VUE] Vue 或 auctionStore 未就绪，Phase 2 脚手架跳过');
                return;
            }

            // ============================================================
            // [PERF-CORE 2026-07-24] 视图数据记忆化层 —— 卡顿根治
            // ------------------------------------------------------------
            // 问题（调试日志实测定论）：一次交互 → renderAuction → stocksDataVersion++
            //   → 4 块看板 × 2 个 tab 的 computed 全部失效重算，单次重算
            //   16~1500ms，同帧合计实测高达 2~11 秒，主线程被长时间打满，
            //   表现为切页/切日期/切 tab 全面卡顿。
            // 方案（不改变任何业务口径，纯加速）：
            //   1) 指纹记忆化：computed 评估时先对"真正影响显示的输入"做轻量
            //      指纹（当前/前序交易日的行级内容 + 标签源 + 排序/高亮等）。
            //      指纹未变 → 直接返回上次结果（同一对象引用），Vue 跳过
            //      diff 与 DOM 更新；指纹变化 → 才调用原 compute*ViewData
            //      全量重算一次并缓存。
            //   2) 可见性懒算：非当前 tab、非当前页的看板不计算（返回缓存值
            //      或空壳），切 tab/翻页时由 store 响应式唤醒后再算。
            // 效果：Realtime 高频推送、冗余的 stocksDataVersion bump、重复
            //   renderAuction 调用全部退化为 <1ms 的指纹比对；真实数据变化
            //   每次最多只算 1 块可见看板。
            // ============================================================
            const _viewMemo = { p1: {}, p2: {}, p3: {}, stats: {} };
            const _VIEW_EMPTY = {
                p1: { date: '', dataSource: 'auction', rawCount: 0, items: [], obsIndices: [], regularIndices: [], hiddenObsIndices: [], stats: { todayStrength: null, yesterdayStrength: null, strongCount: 0, totalCount: 0, highRatioCount: 0, jingYestCount: 0 }, duibanTushiLink: '' },
                p2: { empty: true, placeholder: '暂无数据' },
                p3: { empty: true, placeholder: '暂无数据' },
                stats: { empty: true }
            };
            const _PERF_BOARD_NAME = { p1: 'AuctionBoard(page1)', p2: 'Page2Board', p3: 'Page3Board', stats: 'StatsBoard' };

            // —— 行级轻量指纹：只拼影响显示的字段，~40 行成本 <0.5ms ——
            function _fpRow(r) {
                if (!r) return '';
                return (r.stock || '') + '' + (r.volume || '') + '' +
                    (r.yestVolume !== undefined && r.yestVolume !== '' ? r.yestVolume : (r.yest_volume || '')) + '' +
                    (r.note || '') + '' + (r.topics || '') + '' + (r.changePct || '') +
                    (r.selected ? 'S' : '') + (r.in_watchlist === false ? 'W' : '') + (r.obsAutoAdded ? 'O' : '');
            }
            function _fpList(list) {
                if (!list || !list.length) return '#';
                let s = '#' + list.length;
                for (let i = 0; i < list.length; i++) { s += '|' + _fpRow(list[i]); }
                return s;
            }
            // 标签权威源（stocksData）行指纹：标签五元组决定所有上标/底色显示
            function _fpTags(list) {
                if (!list || !list.length) return '#';
                let s = '#' + list.length;
                for (let i = 0; i < list.length; i++) {
                    const r = list[i]; if (!r) continue;
                    s += '|' + (r.name || '') + (r.bought ? 'B' : '') + (r.sold ? 'S' : '') + (r.hold ? 'H' : '') + (r.inheritedHold ? 'I' : '');
                }
                return s;
            }
            // confirmedSoldSet 的全历史 sold 兜底指纹（只拼已卖出股票名）
            function _fpSoldAll(sd) {
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
            // 首页竞价量列的图示链接（跨看板关联，取当天第一条 http tushi）
            function _fpDuibanLink() {
                try {
                    const duibanList = getTodayDuiban();
                    for (let i = 0; i < duibanList.length; i++) {
                        const tushi = (duibanList[i] && duibanList[i].tushi) || '';
                        if (tushi && (tushi.startsWith('http://') || tushi.startsWith('https://'))) return tushi;
                    }
                } catch (e) {}
                return '';
            }

            // 构建指定看板的输入指纹。返回 { str, rankRef }：
            // str 为字符串指纹；rankRef 为 rank 数据引用（引用比对，不进字符串）。
            // 本函数在 computed 上下文中执行，读取响应式数据即建立细粒度依赖：
            // 只有被读到的行/字段变化才会唤醒对应看板，无关日期写入不再连坐。
            function _buildViewFp(slot, dataSource) {
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
                    str += '|L' + _fpList(g[currentDate]) + 'P' + _fpList(g[prevDate]) + 'Q' + _fpList(g[prevPrevDate]);
                    str += '|T' + _fpTags(sd[currentDate]) + _fpTags(sd[prevDate]) + '|S' + _fpSoldAll(sd);
                    str += '|O' + (localStorage.getItem('obsAutoAdded_' + currentDate) || '') + (localStorage.getItem('obsBought_' + currentDate) || '');
                    str += '|R' + (ss.byData ? 1 : 0) + (ss.byRatio ? 1 : 0) + (ss.byParallel ? 1 : 0) + (ss.byJingYest ? 1 : 0);
                    str += '|H' + (auctionStore.highlightStock || '') + '|D' + _fpDuibanLink();
                } else if (slot === 'p2') {
                    const ss2 = auctionStore.sortStateP2[tab] || {};
                    str += '|L' + _fpList(g[currentDate]) + 'P' + _fpList(g[prevDate]);
                    str += '|T' + _fpTags(sd[currentDate]) + _fpTags(sd[prevDate]);
                    str += '|R' + (ss2.byRatio ? 1 : 0) + (ss2.byParallel ? 1 : 0) + (ss2.byJingYest ? 1 : 0) + (auctionStore.strengthSortEnabled ? 1 : 0);
                    str += '|H' + (auctionStore.highlightStock || '');
                    str += '|C' + (localStorage.getItem('coreTopics') || '');
                    rankRef = getRankData();
                } else if (slot === 'p3') {
                    const days = getLastNTradingDays(6);
                    str += '|D' + days.join(',');
                    for (let i = 0; i < days.length; i++) str += '|' + _fpList(g[days[i]]);
                    str += '|R' + (auctionStore.strengthSortEnabled ? 1 : 0);
                    str += '|C' + (localStorage.getItem('coreTopics') || '');
                    rankRef = getRankData();
                } else { // stats
                    const yest = getYesterdayDate(currentDate);
                    str += '|L' + _fpList(g[currentDate]) + 'Y' + _fpList(g[yest]);
                    str += '|C' + (localStorage.getItem('coreTopics') || '');
                }
                return { str, rankRef };
            }

            // 记忆化视图入口：四个看板 computed 统一走这里。
            // 唤醒源（store 的日期/tab/页码/标签版本）最先读取——不可见时也追踪它们，
            // 保证切页/切 tab/标签变更能唤醒；数据行依赖只在可见路径里建立。
            // pageIdx === null 表示"跟随 tab 的常驻看板"（星标签统计看板是独立常驻 DOM，
            // 不在四页滑动容器内），只在 tab 匹配时才计算。
            function _memoizedView(slot, dataSource, pageIdx, computeFn) {
                const storeDate = auctionStore.currentDate;
                const storeGroup = auctionStore.currentGroup;
                const storePage = auctionStore.currentPage;
                const storeVer = auctionStore.stocksDataVersion; // 标签变更统一唤醒信号
                const tab = dataSource === 'hot' ? 'hot' : 'auction';
                const bucket = _viewMemo[slot];
                let entry = bucket[tab];
                // [DEBUG-VUE-FIX 2026-07-25] 防御性校验：响应式 auctionStore.currentDate
                // 与全局变量 currentDate（_buildViewFp/computeAuctionViewData 实际取数用的
                // 那个）理应由 setCurrentDate() 统一同步、永远一致。2026-07-25 发现的真实
                // bug 就是 changeDate/handleDateSelect/goToday/goBackToCurrent 更新了
                // store.currentDate 却漏调 renderAuction()，导致取数环节在旧日期指纹的
                // 缓存上"卡住"，界面显示上一个日期的股票（切日期后串数据，刷新才恢复）。
                // 已在那四个入口补上 renderAuction() 调用；这里留一道兜底告警，防止未来
                // 再出现新的调用点犯同样的错误却没人发现。
                if (typeof currentDate !== 'undefined' && storeDate !== currentDate) {
                    // [DEBUG-VUE-FIX 2026-07-26] 日期撕裂兜底：不返回可能过期的缓存，
                    // 而是清空当前 slot/tab 的 memo 并强制重算，确保界面显示 currentDate 的数据。
                    const stack = (new Error().stack || '').split('\n').slice(2, 5).join(' <- ');
                    _dbgLog('[VUE-MEMO-WARN] ⚠️ 日期撕裂：auctionStore.currentDate=' + storeDate + ' ≠ 全局currentDate=' + currentDate + '（' + slot + '/' + tab + '）。已清空本槽位 memo 并强制重算。来源: ' + stack);
                    delete bucket[tab];
                    entry = undefined;
                }
                const visible = (storeGroup === tab) && (pageIdx === null || storePage === pageIdx);
                if (!visible) {
                    // [DEBUG-VUE-FIX 2026-07-25] 非当前 tab：即使数据已变化也不会重算，
                    // 一直返回上次缓存的结果，直到用户切到这个 tab 才会重新计算一次。
                    // 这是刻意的性能优化（背景 tab 没必要算），但如果你怀疑"切换到某个
                    // tab 时数据是旧的/跟后台对不上"，这条日志能确认当时拿到的是不是缓存。
                    if (window._DBG_VERBOSE) {
                        _dbgLog('[VUE-MEMO-DEBUG] ' + slot + '/' + tab + ' 非当前tab(storeGroup=' + storeGroup + ')，跳过重算，返回' + (entry ? '缓存结果' : '空壳'));
                    }
                    return (entry && entry.result) ? entry.result : _VIEW_EMPTY[slot];
                }
                const fp = _buildViewFp(slot, dataSource);
                if (entry && entry.result && entry.fp === fp.str && entry.rankRef === fp.rankRef) {
                    if (slot === 'p1') {
                        _dbgLog('[VUE-MEMO-RETURN] ' + slot + '/' + tab + '/' + currentDate + ' 指纹命中返回缓存 items=' + (entry.result.items ? entry.result.items.length : '?'));
                    }
                    return entry.result; // 指纹命中：同引用返回，Vue 下游 computed/模板全部跳过
                }
                const __t0 = performance.now();
                const result = computeFn(dataSource);
                const __dt = performance.now() - __t0;
                window._perfLog && window._perfLog(_PERF_BOARD_NAME[slot] || slot, dataSource, __dt);
                // [DEBUG-VUE-FIX 2026-07-25] 指纹未命中触发了真实重算：打印重算前后
                // 结果条数，方便对照"重算后条数是否等于后台/接口那边的正式列表条数"。
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
            // 数据被外部强制刷新后（如切换交易日全部重拉），memo 会随指纹自然失效，
            // 无需手动清桶；保留该函数供调试。
            window._clearViewMemo = function () { _viewMemo.p1 = {}; _viewMemo.p2 = {}; _viewMemo.p3 = {}; _viewMemo.stats = {}; };

            // ---- 信号集合（竞/昨/平行/环比/差值）全局指纹缓存 ----
            // 这些函数原本在同一次看板计算里被重复调用 3~4 次（当前日 + 前一日的
            // 观察组判定 + 排序分支），每次又逐股票线性查找 T-1 历史行（O(n²)）。
            // 改为：输入指纹（当日列表 + T-1 全量行内容）未变时直接返回上次结果。
            // 指纹函数在调用方（全局函数）执行时现算，~40 行成本 <0.5ms。
            window._signalCache = window._signalCache || {};
            window._viewFpList = _fpList;
            window._signalFpFor = function (dateStr, dataSource) {
                const g = getGroupData(dataSource);
                const t1 = getPreviousTradingDay(dateStr);
                const prim = dataSource === 'hot' ? _hotFullRowCache : _auctionMemCache;
                const fall = dataSource === 'hot' ? _auctionMemCache : _hotFullRowCache;
                return _fpList(g[dateStr]) + '' + _fpList(prim[t1]) + '' + _fpList(fall[t1]);
            };

            // 读 sort toggle（与 renderAuction 现网口径一致：DOM checked）
            function _toggleChecked(id) {
                const el = document.getElementById(id);
                return !!(el && el.checked);
            }

            // 计算单只股票的展示用上标 HTML（与 _renderAuctionItem 18634-18657 同口径）
            function buildDisplayStockHtml(item, ctx) {
                let html = item.stock || '-';
                const name = item.stock ? item.stock.trim() : '';
                // 方案 B：标签从 stocksData 实时派生，不读 item.bought/sold
                const _tagState = deriveAuctionTagState(name, ctx.date || currentDate, ctx.tagCache);
                const isConfirmedSold = _tagState.sold || ctx.confirmedSoldSet.has(name);
                const isSold = _tagState.sold;
                const isSelected = !isConfirmedSold && (_tagState.selected || item.selected === true);
                const isBought = !isConfirmedSold && _tagState.bought;
                const _isObs = ctx.obsStocks && ctx.obsStocks.has(name);
                const _isAutoAdded = ctx.autoAddedSet.has(name);
                const _matchesToday = ctx.jingYestToggleChecked && ctx.jingYestHighlightSet && ctx.jingYestHighlightSet.has(name);
                if (ctx.jingYestToggleChecked && _isObs && _isAutoAdded && _matchesToday) {
                    html += '<sup style="color:#3b82f6;font-size:10px;font-weight:700;">观</sup>';
                } else if (!ctx.jingYestToggleChecked && _isObs && !_isAutoAdded) {
                    html += '*';
                }
                if (item.monitorWarning) {
                    html += '<span style="color:#dc2626;font-size:13px;margin-left:2px;" title="严重异常波动">⚠️</span>';
                }
                const _isObsBought = !isConfirmedSold && ctx.obsBoughtSet.has(name);
                if (!isSold && !isConfirmedSold) {
                    if (isSelected) {
                        html += '<sup style="color:#2563eb;font-size:10px;font-weight:700;margin-left:2px;">持</sup>';
                    } else if (_isObsBought || isBought) {
                        html += '<sup style="color:#dc2626;font-size:10px;font-weight:700;margin-left:2px;">买</sup>';
                    }
                }
                return html;
            }

            // 计算单行 itemClass / ratioClass 等（与 _renderAuctionItem 18545-18620 同口径）
            function enrichAuctionItem(item, index, ctx) {
                const volume = parseFloat(item.volume) || 0;
                const yestVolume = parseFloat(item.yestVolume) || 0;
                let ratioValue = 0;
                let ratio = '-';
                if (yestVolume > 0) { ratioValue = (volume / yestVolume) * 100; ratio = Math.round(ratioValue) + '%'; }

                let ratioArrow = '';
                if (ctx.prevAuctionList.length > 0 && item.stock) {
                    // [PERF-CORE] 按数组引用缓存的 name→row 映射，替代每行 O(n) find
                    const prevItem = _histRowMapFor(ctx.prevAuctionList).get(item.stock.trim());
                    if (prevItem && prevItem.yestVolume) {
                        const pv = parseFloat(prevItem.volume) || 0;
                        const py = parseFloat(prevItem.yestVolume) || 0;
                        if (py > 0) {
                            const prr = Math.round((pv / py) * 100);
                            const crr = Math.round(ratioValue);
                            if (crr > prr) ratioArrow = '<span style="color:#ef4444;">⬆</span>';
                            else if (crr < prr) ratioArrow = '<span style="color:#10b981;">⬇</span>';
                        }
                    }
                }

                const isHighlight = ratioValue >= 10;
                const isHighlightLight = ratioValue >= 4.5 && ratioValue < 10;
                const name = item.stock ? item.stock.trim() : '';
                // 方案 B：标签从 stocksData 实时派生（deriveAuctionTagState），不读 item.bought/sold。
                // selected 保留在 item 上但仅代表"手动点选"（toggleAuctionRowSelect 写入）。
                // 标签派生的 selected 由 deriveAuctionTagState 返回，与手动点选取 OR。
                const _tagState = deriveAuctionTagState(name, ctx.date || currentDate, ctx.tagCache);
                const isConfirmedSold = _tagState.sold || ctx.confirmedSoldSet.has(name);
                const isSelected = !isConfirmedSold && (_tagState.selected || item.selected === true);
                const isBought = !isConfirmedSold && _tagState.bought;
                const isSold = _tagState.sold;
                const isFixed = _tagState.sold || _tagState.bought || _tagState.selected;
                const isObsInheritedBought = isBought && item.obsAutoAdded === true;
                const isGray = !isSelected && !isBought && !isSold && ratioValue < 4.5;

                let itemClass = 'auction-item';
                if (isSold) itemClass = 'auction-item sold';
                else if (isConfirmedSold) itemClass = 'auction-item';
                else if (isBought && !isObsInheritedBought) itemClass = 'auction-item bought';
                else if (isSelected && isFixed) itemClass = 'auction-item selected';
                else if (isSelected && !isFixed) itemClass = 'auction-item manual-selected';

                const isJingYestMatch = ctx.jingYestToggleChecked && ctx.jingYestHighlightSet && ctx.jingYestHighlightSet.has(name);
                const isParallelMatch = ctx.sortByParallelEnabled && !ctx.jingYestToggleChecked && ctx.parallelStocksToday.has(name);
                const isHighRatioMatch = ctx.sortByRatioEnabled && ctx.highRatioToday.stockNames.has(name);
                if (isJingYestMatch) itemClass += ' jing-yest-match';
                else if (isParallelMatch) itemClass += ' parallel-match';
                else if (isHighRatioMatch) itemClass += ' high-ratio';
                // 跨页跳转高亮：从第二页点股票名跳回第一页时高亮对应行（响应式，由 store 驱动，
                // 避免 Vue 重渲染冲掉手动加的 DOM class）
                if (name && auctionStore && auctionStore.highlightStock === name) itemClass += ' highlight-search';

                let ratioClass = 'auction-ratio auction-ratio-clickable';
                if (isHighlight) ratioClass = 'auction-ratio highlight auction-ratio-clickable';
                else if (isHighlightLight) ratioClass = 'auction-ratio highlight-light auction-ratio-clickable';

                const displayNote = getDisplayNoteWithHistory(item);
                const volumeDisplay = item.volume ? Math.round(parseFloat(item.volume)) : '-';
                const yestVolumeDisplay = item.yestVolume ? Math.round(parseFloat(item.yestVolume)) : '-';

                let yestColorClass = '';
                if (displayNote) {
                    if (displayNote.includes('涨停')) yestColorClass = ' auction-yest-red';
                    else if (displayNote.includes('跌停')) yestColorClass = ' auction-yest-green';
                    else {
                        const numMatches = displayNote.match(/-?\d+\.?\d*/g);
                        if (numMatches && numMatches.length > 0) {
                            const lastNum = parseFloat(numMatches[numMatches.length - 1]);
                            if (lastNum > 0) yestColorClass = ' auction-yest-red';
                            else if (lastNum < 0) yestColorClass = ' auction-yest-green';
                        }
                    }
                }

                const numberClass = isGray ? 'auction-number gray-text auction-trend-trigger' : 'auction-number auction-trend-trigger';
                const stockClass = isGray ? 'auction-stock-name gray-text' : 'auction-stock-name';

                let volumeHtml = volumeDisplay;
                if (ctx.duibanTushiLink && volumeDisplay !== '-') {
                    volumeHtml = '<a href="' + ctx.duibanTushiLink + '" target="_blank" style="color:inherit;text-decoration:none;">' + volumeDisplay + '</a>';
                }
                const isExpanded = auctionStore.expandedStocks.has(name) && (auctionStore.currentGroup === (ctx.dataSource === 'hot' ? 'hot' : 'auction'));

                return {
                    index, stock: item.stock || '',
                    itemClass, ratioClass, numberClass, stockClass, yestColorClass,
                    volumeDisplay, volumeHtml, yestVolumeDisplay, ratio, ratioArrow, ratioValue,
                    note: displayNote || '',
                    displayStockHtml: buildDisplayStockHtml(item, ctx),
                    isExpanded,
                    isBought, isSelected, isSold, isConfirmedSold
                };
            }

            // 把 renderAuction 的纯计算前半段抽成纯数据函数（不碰 DOM、不写副作用）
            function computeAuctionViewData(dataSource) {
                dataSource = dataSource || 'auction';
                _touchReactiveCtx();
                const _p = dataSource === 'hot' ? 'hot' : 'auction';
                const auctionList = getTodayGroupList(dataSource);
                const auctionData = getGroupData(dataSource);
                const prevDate = getPreviousTradingDay(currentDate);
                const prevAuctionList = prevDate ? (auctionData[prevDate] || []) : [];
                const prevPrevDate = prevDate ? getPreviousTradingDay(prevDate) : null;
                const prevPrevAuctionList = prevPrevDate ? (auctionData[prevPrevDate] || []) : [];

                // [PERF-CORE] topic cache 按需构建：若当天所有股票都已有题材，则跳过 66 日扫描
                const __needsTopicCache = auctionList.some(function(it) {
                    if (!it || !it.stock) return false;
                    const note = getDisplayNote(it);
                    return !note || extractTopics(note).length === 0;
                });
                if (__needsTopicCache) buildTopicCache();

                // [PERF-CORE] 预建标签派生缓存：enrich 每行 2 次 deriveAuctionTagState
                // 原本各自对 stocksData[当日/前日] 做 O(n) 线性 find，整表 O(行数²)，
                // 预建 Map 后每行 O(1)（与 Page2 已验证的做法一致）。
                const __tagStateCache = _buildTagStateCache(currentDate);

                // [PERF-CORE] 预建历史行 Map，供排序分支直接 O(1) 查询，避免反复 getStockHistoryValue
                const __prevDayMap = _histRowMapFor(prevAuctionList);
                const __prevPrevDayMap = _histRowMapFor(prevPrevAuctionList);
                // 近 5 个交易日（含今天）每只股票有数据的天数，供"数据排序"使用
                function __buildHistoryCountMap() {
                    const map = new Map();
                    let d = currentDate;
                    for (let i = 0; i < 5 && d; i++) {
                        const list = auctionData[d] || [];
                        list.forEach(function(it) {
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
                const __historyCountMap = __buildHistoryCountMap();

                // [PERF-CORE] confirmedSoldSet 按 (date, 股票名单, stocksDataVersion) 缓存，
                // 避免每次 computeAuctionViewData 都扫描全部历史 stocksData。
                const __auctionNamesKey = auctionList.map(function(it) { return it && it.stock ? it.stock.trim() : ''; }).filter(Boolean).sort().join(',');
                const __confirmedSoldKey = currentDate + '|v' + (auctionStore.stocksDataVersion || 0) + '|' + __auctionNamesKey;
                if (!window._confirmedSoldCache) window._confirmedSoldCache = {};
                let confirmedSoldSet;
                if (window._confirmedSoldCache[__confirmedSoldKey]) {
                    confirmedSoldSet = window._confirmedSoldCache[__confirmedSoldKey];
                } else {
                    confirmedSoldSet = (function () {
                        const res = new Set();
                        const sd = getStocksData();
                        const dates = Object.keys(sd).filter(d => d <= currentDate).sort();
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
                    })();
                    window._confirmedSoldCache[__confirmedSoldKey] = confirmedSoldSet;
                }

                // sort toggles（读 store：renderAuction 入口已把 DOM 开关同步到 store；
                // store 响应式，开关变化时本 computed 自动重算）
                const _ss = auctionStore.sortState[_p];
                const sortByDataEnabled = _ss.byData;
                const sortByRatioEnabled = _ss.byRatio;
                const sortByParallelEnabled = _ss.byParallel;
                const sortByJingYestEnabled = _ss.byJingYest;
                const jingYestToggleChecked = sortByJingYestEnabled;

                const highRatioToday = getHighRatioStocksForDate(currentDate, dataSource);
                const parallelStocksToday = getParallelStocksForDate(currentDate, dataSource);
                const jingYestHighlightSet = getJingYestHighlightSetForDate(currentDate, dataSource);

                // duiban tushi 链接（跨看板，与 renderAuction 18096-18106 同口径）
                const duibanList = getTodayDuiban();
                let duibanTushiLink = '';
                if (duibanList.length > 0) {
                    for (let i = 0; i < duibanList.length; i++) {
                        const tushi = duibanList[i].tushi || '';
                        if (tushi && (tushi.startsWith('http://') || tushi.startsWith('https://'))) { duibanTushiLink = tushi; break; }
                    }
                }

                // [BUG-FIX 2026-07-27] 卖出标签的股票也要显示，不再在渲染层过滤已卖出的观察组继承行。
                let renderOrder = auctionList.map((it, idx) => idx);

                if (sortByDataEnabled) {
                    // [PERF-CORE] 直接用预建 __historyCountMap，避免每行再调用 getAuctionStockHistory
                    renderOrder = renderOrder.map((idx, pos) => ({
                        idx,
                        c: auctionList[idx] && auctionList[idx].stock
                            ? (__historyCountMap.get(auctionList[idx].stock.trim()) || 0)
                            : 0
                    })).sort((a, b) => b.c - a.c).map(x => x.idx);
                } else if (sortByRatioEnabled) {
                    const hrs = getHighRatioStocksForDate(currentDate, dataSource);
                    renderOrder = renderOrder.map((idx, pos) => {
                        const it = auctionList[idx];
                        const nm = it && it.stock ? it.stock.trim() : '';
                        const tv = it ? getNumericVolume(it.volume) : null;
                        const yv = it ? getNumericVolume(it.yestVolume) : null;
                        let r = null;
                        if (tv !== null && tv !== 0) {
                            const pi = __prevDayMap.get(nm);
                            const pv = pi ? getNumericVolume(pi.volume) : null;
                            if (pv !== null && pv !== 0) r = tv / pv;
                        }
                        const dg = (tv !== null && yv !== null) ? Math.abs(getDigitCount(tv) - getDigitCount(yv)) : null;
                        const hr = nm && hrs.stockNames.has(nm);
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
                } else if (sortByParallelEnabled) {
                    if (sortByJingYestEnabled) {
                        const ps = getParallelStocksForDate(currentDate, dataSource);
                        const info = getRatioDiffInfoForDate(currentDate, dataSource);
                        renderOrder = renderOrder.map((idx, pos) => {
                            const nm = auctionList[idx] && auctionList[idx].stock ? auctionList[idx].stock.trim() : '';
                            const ip = ps.has(nm);
                            const ih = nm && jingYestHighlightSet.has(nm);
                            const tier = ih ? 0 : (ip ? 1 : 2);
                            const fi = (tier === 0 || tier === 1) ? info.get(nm) : null;
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
                    } else {
                        const ps = getParallelStocksForDate(currentDate, dataSource);
                        const info = getRatioDiffInfoForDate(currentDate, dataSource);
                        renderOrder = renderOrder.map((idx, pos) => {
                            const nm = auctionList[idx] && auctionList[idx].stock ? auctionList[idx].stock.trim() : '';
                            const q = nm && ps.has(nm);
                            const fi = q ? info.get(nm) : null;
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
                }

                // 观察组 / confirmedSold（与 renderAuction 18447-18477 同口径）
                const obsStocks = getJingYestHighlightSetForDate(getPreviousTradingDay(currentDate), dataSource);
                const autoAddedSet = new Set(JSON.parse(localStorage.getItem('obsAutoAdded_' + currentDate) || '[]'));
                const obsBoughtSet = new Set(JSON.parse(localStorage.getItem('obsBought_' + currentDate) || '[]'));
                // confirmedSoldSet 已在本函数开头按 (date, list, stocksDataVersion) 缓存
                const obsBoughtVisibleSet = new Set([...obsBoughtSet].filter(n => !confirmedSoldSet.has(n)));
                const isObsMember = function (nm) { return (obsStocks && obsStocks.has(nm)) || obsBoughtVisibleSet.has(nm); };
                const obsIndicesRaw = renderOrder.filter(i => auctionList[i] && auctionList[i].stock && isObsMember(auctionList[i].stock.trim()));

                let obsIndices, regularIndices, hiddenObsIndices;
                if (jingYestToggleChecked) {
                    hiddenObsIndices = [];
                    const merged = [];
                    obsIndicesRaw.forEach(i => {
                        const nm = auctionList[i].stock.trim();
                        const isAutoAdded = autoAddedSet.has(nm);
                        const matchesToday = jingYestHighlightSet && jingYestHighlightSet.has(nm);
                        const isBoughtInherited = obsBoughtVisibleSet.has(nm);
                        if (isAutoAdded && !matchesToday && !isBoughtInherited) hiddenObsIndices.push(i);
                        else merged.push(i);
                    });
                    obsIndices = [];
                    regularIndices = renderOrder.filter(i => hiddenObsIndices.indexOf(i) < 0);
                } else {
                    obsIndices = obsIndicesRaw;
                    regularIndices = renderOrder.filter(i => obsIndices.indexOf(i) < 0);
                    hiddenObsIndices = [];
                }

                const ctx = {
                    dataSource, date: currentDate, prevAuctionList, confirmedSoldSet, obsStocks, autoAddedSet, obsBoughtSet,
                    jingYestToggleChecked, jingYestHighlightSet, sortByParallelEnabled, sortByRatioEnabled,
                    parallelStocksToday, highRatioToday, duibanTushiLink, tagCache: __tagStateCache
                };
                const fullOrder = obsIndices.concat(regularIndices);
                const items = fullOrder.map((i, pos) => enrichAuctionItem(auctionList[i], i, ctx));

                // 聚合统计（与 renderAuction 18170-18304 同口径）
                const __prevMapForStats = _histRowMapFor(prevAuctionList);
                const __prevPrevMapForStats = _histRowMapFor(prevPrevAuctionList);
                let strongCount = 0;
                auctionList.forEach(item => {
                    let hasDown = false;
                    if (prevAuctionList.length > 0 && item.stock) {
                        const pi = __prevMapForStats.get(item.stock.trim());
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
                const totalCount = auctionList.length;
                const todayStrength = totalCount > 0 ? Math.round((strongCount / totalCount) * 100) : null;
                let yStrongCount = 0, yTotal = prevAuctionList.length;
                if (yTotal > 0) {
                    prevAuctionList.forEach(item => {
                        let hasDown = false;
                        if (prevPrevAuctionList.length > 0 && item.stock) {
                            const pp = __prevPrevMapForStats.get(item.stock.trim());
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
                    date: currentDate, dataSource,
                    rawCount: auctionList.length,
                    items, obsIndices, regularIndices, hiddenObsIndices,
                    stats: {
                        todayStrength, yesterdayStrength, strongCount, totalCount,
                        highRatioCount: highRatioToday.count,
                        jingYestCount: jingYestHighlightSet ? jingYestHighlightSet.size : 0
                    },
                    duibanTushiLink
                };
            }

            // 长按手势指令（复刻 _bindAuctionRowEvents 的 500ms 计时 + 多指/移动/右键保护）
            // 指令值是长按触发时的回调 cb(el)。状态挂在 el._lp，供 @click 处理器读取
            // （isLongPress/isMoved 命中时单击不触发，避免长按完误弹注释）。
            const LongPressDirective = {
                beforeMount(el, binding) {
                    const cb = typeof binding.value === 'function' ? binding.value : function () { };
                    const state = { timer: null, isLongPress: false, isMoved: false, lastTapTime: 0 };
                    el._lp = state;
                    const start = function (e) {
                        if (e.touches && e.touches.length > 1) { clearTimeout(state.timer); return; } // 多指不触发
                        if (e.button === 2) { return; } // 右键不启动计时器
                        state.isLongPress = false; state.isMoved = false;
                        state.timer = setTimeout(function () {
                            state.isLongPress = true;
                            try { cb(el); } catch (err) { console.warn('[longpress] cb error', err); }
                        }, 500);
                    };
                    const move = function () { state.isMoved = true; clearTimeout(state.timer); };
                    const end = function () { clearTimeout(state.timer); };
                    const cancel = function () { clearTimeout(state.timer); };
                    el.addEventListener('mousedown', start);
                    el.addEventListener('mouseup', end);
                    el.addEventListener('mouseleave', cancel);
                    el.addEventListener('touchstart', start, { passive: true });
                    el.addEventListener('touchmove', move, { passive: true });
                    el.addEventListener('touchend', end);
                    el.addEventListener('touchcancel', cancel);
                    state._cleanup = function () {
                        clearTimeout(state.timer);
                        el.removeEventListener('mousedown', start);
                        el.removeEventListener('mouseup', end);
                        el.removeEventListener('mouseleave', cancel);
                        el.removeEventListener('touchstart', start);
                        el.removeEventListener('touchmove', move);
                        el.removeEventListener('touchend', end);
                        el.removeEventListener('touchcancel', cancel);
                    };
                },
                unmounted(el) { if (el._lp && el._lp._cleanup) el._lp._cleanup(); el._lp = null; }
            };

            // StockCard：单行卡片（auction / hot 共用）——含完整点击/长按/右键交互
            // 对齐 _bindAuctionRowEvents：占比单击选中、序号单击展开趋势图、昨日成交量
            // 单击弹注释/长按写注释/右键编辑、股票名单击跳第二页/双击弹注释/长按买入提示。
            // 标签类写入仍只走现有全局 handler（toggleAuctionRowSelect 只动 selected，
            // 不碰 bought/sold/fixed，符合单向数据流；showAuctionNoteInput 写 note 不碰标签位）。
            const StockCard = {
                name: 'StockCard',
                directives: { longpress: LongPressDirective },
                props: {
                    item: { type: Object, required: true },
                    displayNum: { type: Number, default: 0 },
                    dataSource: { type: String, default: 'auction' }
                },
                computed: {
                    panelId() { return (this.dataSource === 'hot' ? 'hot' : 'auction') + 'TrendPanel-' + this.item.index; }
                },
                methods: {
                    onNumberClick(e) { e.stopPropagation(); toggleAuctionTrendPanel(this.item.index); },
                    onRatioClick(e) { e.stopPropagation(); toggleAuctionRowSelect(this.item.index); },
                    onYestClick(e) {
                        const lp = e.currentTarget._lp;
                        if (lp && (lp.isLongPress || lp.isMoved)) return;            // 长按/移动后不触发单击
                        const now = Date.now();
                        if (lp && (now - lp.lastTapTime < 300)) return;                 // 300ms 内防重复
                        if (lp) lp.lastTapTime = now;
                        const note = this.item.note;
                        if (note) { e.preventDefault(); e.stopPropagation(); showAuctionNotePopup(e.currentTarget, note); }
                    },
                    onYestContext(e) {
                        e.preventDefault();
                        if (e.currentTarget._lp) clearTimeout(e.currentTarget._lp.timer);
                        if (this.dataSource === 'hot') openHotEdit(); else openAuctionEdit();
                    },
                    onYestLongPress(el) { showAuctionNoteInput(this.item.index, el); },
                    onNameClick(e) {
                        const lp = e.currentTarget._lp;
                        if (lp && (lp.isLongPress || lp.isMoved)) return;
                        const nm = this.item.stock;
                        if (nm && nm !== '-') { e.stopPropagation(); jumpToAuctionPage2(nm); }
                    },
                    onNameDblClick(e) {
                        e.stopPropagation();
                        const note = this.item.note;
                        if (note && this.$refs.yestEl) showAuctionNotePopup(this.$refs.yestEl, note);
                    },
                    onNameContext(e) { e.preventDefault(); }, // 阻止浏览器默认右键菜单
                    onNameLongPress() {
                        const nm = this.item.stock;
                        if (nm && nm !== '-') showAuctionBuyPrompt(nm);
                    }
                },
                template: `
                    <div :class="item.itemClass" :data-index="item.index" :data-stock="item.stock">
                        <div :class="item.numberClass" :data-index="item.index" style="cursor:pointer;" @click="onNumberClick">{{ displayNum }}</div>
                        <div ref="nameEl" :class="item.stockClass + ' auction-note-trigger'" style="cursor:pointer;" :data-note="item.note || ''" v-html="item.displayStockHtml"
                             v-longpress="onNameLongPress" @click="onNameClick" @dblclick="onNameDblClick" @contextmenu="onNameContext"></div>
                        <div class="auction-volume" v-html="item.volumeHtml"></div>
                        <div ref="yestEl" :class="'auction-yest auction-yest-note' + item.yestColorClass" :data-index="item.index" :data-note="item.note || ''"
                             v-longpress="onYestLongPress" @click="onYestClick" @contextmenu="onYestContext">{{ item.yestVolumeDisplay }}</div>
                        <div :class="item.ratioClass" :data-index="item.index" style="cursor:pointer;" @click="onRatioClick" v-html="item.ratio + item.ratioArrow"></div>
                    </div>
                    <div class="auction-trend-panel" :id="panelId" :data-index="item.index" style="display:none;"></div>
                `
            };

            // AuctionBoard：主列表（含表头 + 统计 + 观察组/常规组分区）
            const AuctionBoard = {
                name: 'AuctionBoard',
                components: { StockCard },
                directives: { longpress: LongPressDirective },
                props: { dataSource: { type: String, default: 'auction' } },
                setup(props) {
                    // [PERF-CORE] 走记忆化层：指纹未变返回同引用（Vue 跳过重渲染），
                    // 非当前 tab/非第 1 页时不计算（返回缓存/空壳）。
                    const view = Vue.computed(() => _memoizedView('p1', props.dataSource, 0, computeAuctionViewData));
                    const obsItems = Vue.computed(() => view.value.items.slice(0, view.value.obsIndices.length));
                    const regItems = Vue.computed(() => view.value.items.slice(view.value.obsIndices.length));
                    const hasObs = Vue.computed(() => view.value.obsIndices.length > 0);
                    const hasReg = Vue.computed(() => view.value.regularIndices.length > 0);
                    // Vue 路径提前 return，跳过了 innerHTML 路径尾部的标题栏强度/计数器 DOM 写入。
                    // 这里用 watch 响应式补回：view 重算（Realtime/排序/日期变化）时自动刷新 DOM。
                    // 分组守卫：auctionStrengthValue/Arrow 是两个 tab 共用同一套 DOM，仅当前 tab 写。
                    Vue.watch(view, (v) => {
                        if (props.dataSource !== currentGroup) return;
                        const _p = props.dataSource === 'hot' ? 'hot' : 'auction';
                        const strengthValueEl = document.getElementById('auctionStrengthValue');
                        const strengthArrowEl = document.getElementById('auctionStrengthArrow');
                        if (strengthValueEl) {
                            strengthValueEl.textContent = v.stats.todayStrength == null ? '-' : (v.stats.todayStrength + '% ');
                        }
                        if (strengthArrowEl) {
                            const ts = v.stats.todayStrength, ys = v.stats.yesterdayStrength;
                            if (ts !== null && ys !== null) {
                                strengthArrowEl.textContent = ts > ys ? '⬆' : (ts < ys ? '⬇' : '-');
                            } else { strengthArrowEl.textContent = '-'; }
                        }
                        // 第一页头部：竞/昨数 / 竞放量数 / 箭头（与 innerHTML 路径 18317-18344 同口径）
                        const jingYestCountEl = document.getElementById(_p + 'JingYestCount');
                        if (jingYestCountEl) jingYestCountEl.textContent = v.stats.jingYestCount || '-';
                        const highRatioCountEl = document.getElementById(_p + 'HighRatioCount');
                        if (highRatioCountEl) highRatioCountEl.textContent = v.stats.highRatioCount;
                        const highRatioArrowEl = document.getElementById(_p + 'HighRatioArrow');
                        if (highRatioArrowEl) {
                            const prevDateForRatio = getPreviousTradingDay(currentDate);
                            if (prevDateForRatio) {
                                const yHigh = getHighRatioStocksForDate(prevDateForRatio, props.dataSource);
                                const today = v.stats.highRatioCount;
                                if (today > yHigh.count) { highRatioArrowEl.textContent = ' ⬆'; highRatioArrowEl.style.color = '#dc2626'; }
                                else if (today < yHigh.count) { highRatioArrowEl.textContent = ' ⬇'; highRatioArrowEl.style.color = '#16a34a'; }
                                else { highRatioArrowEl.textContent = ' -'; highRatioArrowEl.style.color = '#92400e'; }
                            } else { highRatioArrowEl.textContent = ''; }
                        }
                    }, { immediate: true });
                    // 展开/恢复：Vue 路径跳过了 innerHTML 路径尾部的 expandAll/restore 调用。
                    // Vue 重渲染会重建面板 DOM（display:none + 空 innerHTML），需在渲染完成后
                    // （flush:post）恢复。byData 联动 expandAll 也由此覆盖：byData 开关事件
                    // 设 ExpandAllToggle.checked=true 后触发 renderAuction→Vue 重算→此处展开。
                    function _afterBoardRender() {
                        const _p = props.dataSource === 'hot' ? 'hot' : 'auction';
                        const _set = _getExpandedStocksSet(_p);
                        _dbgLogVerbose('[RESTORE-VUE] _afterBoardRender 触发 dataSource=' + _p + ' currentDate=' + currentDate + ' storeVer=' + (auctionStore && auctionStore.stocksDataVersion || 0) + ' expandedSet=' + (_set ? [..._set].join('、') : 'null') + ' size=' + (_set ? _set.size : 0));
                        if (document.getElementById(_p + 'ExpandAllToggle')?.checked) {
                            expandAllAuctionTrendPanels(_p);
                        } else {
                            restoreExpandedAuctionTrendPanels(_p);
                        }
                    }
                    Vue.onMounted(_afterBoardRender);
                    Vue.watch(view, _afterBoardRender, { flush: 'post' });
                    return { view, obsItems, regItems, hasObs, hasReg };
                },
                template: `
                    <div class="auction-board-vue">
                        <div class="auction-header-row">
                            <div class="auction-header-item auction-header-number">序号</div>
                            <div class="auction-header-item auction-header-stock">股票名称</div>
                            <div class="auction-header-item auction-header-volume">竞价量(万)</div>
                            <div class="auction-header-item auction-header-yest">昨日成交量(万)</div>
                            <div class="auction-header-item auction-header-ratio">占比</div>
                        </div>
                        <template v-if="view.rawCount === 0"><div class="auction-placeholder">暂无数据</div></template>
                        <template v-else>
                            <template v-for="(it, i) in obsItems" :key="'o'+it.stock">
                                <stock-card :item="it" :display-num="i+1" :data-source="dataSource"></stock-card>
                            </template>
                            <div v-if="hasObs && hasReg" style="margin:10px 12px;border-top:1.5px dashed #cbd5e1;"></div>
                            <template v-for="(it, i) in regItems" :key="'r'+it.stock">
                                <stock-card :item="it" :display-num="obsItems.length + i + 1" :data-source="dataSource"></stock-card>
                            </template>
                        </template>
                    </div>
                `
            };

            // 在指定容器挂载一个独立 Vue app（验证用，不替换现有 renderAuction 路径）
            function mountAuctionBoardSandbox(dataSource, mountElId) {
                const el = document.getElementById(mountElId);
                if (!el) { console.warn('[AUCTION-VUE] 挂载点不存在: ' + mountElId); return null; }
                const app = Vue.createApp({
                    components: { AuctionBoard },
                    directives: { longpress: LongPressDirective },
                    template: '<auction-board :data-source="ds"></auction-board>',
                    data() { return { ds: dataSource || 'auction' }; }
                });
                const inst = app.mount(el);
                return inst;
            }

            // 暴露到 window 供验证 / 后续阶段接入
            window.computeAuctionViewData = computeAuctionViewData;
            window.AuctionBoardComponent = AuctionBoard;
            window.StockCardComponent = StockCard;
            window.mountAuctionBoardSandbox = mountAuctionBoardSandbox;

            // ============================================================
            // Phase 6: 第二页（题材分组）组件化 + 跨页跳转高亮
            // ------------------------------------------------------------
            // computeAuctionPage2ViewData(dataSource)：把 renderAuctionPage2 的纯计算前半段
            //   抽成返回纯数据对象的函数（题材分组、组内排序、强度、星星、上榜次数、高光
            //   类名、topicCount 配色），不碰 DOM，委托给既有 helper。
            // Page2Board 组件：用 v-for 渲染分组/个股，复刻原 .auction-topic-* class 结构
            //   以复用现有 CSS。交互：股票名/占比单击跳第一页 + 高亮、题材列长按编辑、
            //   行单击展开趋势图、展开行单击整组展开/收起。面板 id 与现网一致
            //   （{p}TrendPanelP2-{rowKey}），toggleAuctionTrendPanelP2 可直接操作。
            // mountPage2BoardSandbox(dataSource, mountElId)：在指定容器挂载 Vue 实例。
            // 全量切换：renderAuctionPage2 默认路由到此（不再依赖特性开关）。
            // ============================================================
            function _toggleChecked2(id) {
                const el = document.getElementById(id);
                return !!(el && el.checked);
            }

            function computeAuctionPage2ViewData(dataSource) {
                dataSource = dataSource || 'auction';
                _touchReactiveCtx();
                const isStrengthSortEnabled = auctionStore.strengthSortEnabled; // 响应式镜像
                const __p2T0 = performance.now();
                const _p = dataSource === 'hot' ? 'hot' : 'auction';
                const auctionList = getTodayGroupList(dataSource);
                if (auctionList.length === 0) return { empty: true, placeholder: '暂无数据' };
                const __p2BeforeGroups = performance.now();
                const groups = getTopicGroups(auctionList);
                const __p2AfterGroups = performance.now();
                if (groups.length === 0) return { empty: true, placeholder: '暂无题材分类数据（双击打开核心词管理）' };
                // 性能修复：整个渲染只调用一次 getRankData()/getCoreTopics()（而不是每个题材调用一次），
                // 避免反复触发 loadAllData() 内的 syncStocksDataToStore() 响应式写入，以及重复读 localStorage。
                const __rankDataForThisRender = getRankData();
                const __coreTopicsForThisRender = getCoreTopics();

                const prevDate = getPreviousTradingDay(currentDate);
                const auctionData = getGroupData(dataSource);
                const prevAuctionList = prevDate ? (auctionData[prevDate] || []) : [];

                // 性能修复：enrichedGroups 里同一只股票可能因命中多个题材而重复出现多次，
                // 原代码对每一行都执行 auctionList.find()/prevAuctionList.find() 做 O(n) 线性查找，
                // 导致总耗时是 O(题材展开后总行数 × 列表长度) 量级，是"分组后处理"耗时2秒+的主因。
                // 这里预建 股票名→记录 的 Map，把每行的查找降到 O(1)。
                const __auctionByName = new Map();
                auctionList.forEach(it => { if (it && it.stock) __auctionByName.set(it.stock.trim(), it); });
                const __prevAuctionByName = new Map();
                prevAuctionList.forEach(it => { if (it && it.stock) __prevAuctionByName.set(it.stock.trim(), it); });

                // 性能修复：deriveAuctionTagState 原本每次调用都对 stocksData[date] 做 O(n) 线性
                // 查找，而它在下方每一行都会被调用一次，同样是 O(总行数 × stocksData长度) 的量级。
                // 这里预建一次 {todayMap, prevMap}，全程复用。
                const __tagStateCache = _buildTagStateCache(currentDate);

                const highRatioInfo2 = getHighRatioStocksForDate(currentDate, dataSource);
                // sort toggles（读 store：renderAuctionPage2 入口已把 DOM 开关同步到 store）
                const _ss2 = auctionStore.sortStateP2[_p];
                const sortByRatioEnabled2 = _ss2.byRatio;
                const sortByParallelEnabled2 = _ss2.byParallel;
                const parallelStockNames2 = sortByParallelEnabled2 ? getParallelStocksForDate(currentDate, dataSource) : null;
                const sortByJingYestEnabled2 = _ss2.byJingYest;
                const jingYestHighlightSet2 = getJingYestHighlightSetForDate(currentDate, dataSource);

                // 统计每只股票出现在多少个题材中（排除"其它"）
                const stockTopicCount = {};
                groups.forEach(g => {
                    if (g.topic === '其它') return;
                    g.stocks.forEach(s => { if (s.stock) stockTopicCount[s.stock] = (stockTopicCount[s.stock] || 0) + 1; });
                });

                // 各题材组强度（与 renderAuctionPage2 19437-19467 同口径）
                groups.forEach(g => {
                    if (g.topic === '其它') { g.strength = null; return; }
                    let strongCount = 0;
                    g.stocks.forEach(s => {
                        let hasDown = false;
                        if (prevAuctionList.length > 0 && s.stock) {
                            const pi = __prevAuctionByName.get(s.stock.trim());
                            if (pi && pi.yestVolume) {
                                const pv = parseFloat(pi.volume) || 0, py = parseFloat(pi.yestVolume) || 0;
                                if (py > 0) {
                                    const prr = (pv / py) * 100;
                                    if (Math.round(s.ratioValue) < Math.round(prr)) hasDown = true;
                                }
                            }
                        }
                        if (!hasDown) strongCount++;
                    });
                    g.strength = g.stocks.length > 0 ? Math.round((strongCount / g.stocks.length) * 100) : 0;
                });

                const topicSortOrder = getTopicSortOrder();
                const otherGroup = groups.find(g => g.topic === '其它');
                let sortedGroups;
                if (isStrengthSortEnabled) {
                    sortedGroups = groups.filter(g => g.topic !== '其它').sort((a, b) => (b.strength || 0) - (a.strength || 0));
                } else {
                    sortedGroups = groups.filter(g => g.topic !== '其它').sort((a, b) => {
                        const ai = topicSortOrder.indexOf(a.topic), bi = topicSortOrder.indexOf(b.topic);
                        if (ai !== -1 && bi !== -1) return ai - bi;
                        if (ai !== -1 && bi === -1) return -1;
                        if (ai === -1 && bi !== -1) return 1;
                        return (b.strength || 0) - (a.strength || 0);
                    });
                }
                if (otherGroup) sortedGroups.push(otherGroup);

                // 组内排序（与 renderAuctionPage2 19564-19658 同口径）
                function sortGroupStocks(stocks) {
                    if (sortByRatioEnabled2) {
                        return stocks.map((s, pos) => {
                            const nm = s.stock ? s.stock.trim() : '';
                            if (!nm) return { s, pos, ratio: null, digitGap: null, tier: 2 };
                            const ti = __auctionByName.get(nm);
                            const tv = ti ? getNumericVolume(ti.volume) : null;
                            const yv = ti ? getNumericVolume(ti.yestVolume) : null;
                            let r = null;
                            if (tv !== null && tv !== 0) {
                                const pi = __prevAuctionByName.get(nm);
                                const pv = pi ? getNumericVolume(pi.volume) : null;
                                if (pv !== null && pv !== 0) r = tv / pv;
                            }
                            const dg = (tv !== null && yv !== null) ? Math.abs(getDigitCount(tv) - getDigitCount(yv)) : null;
                            const hr = nm && highRatioInfo2.stockNames.has(nm);
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
                    if (sortByParallelEnabled2 && parallelStockNames2) {
                        const info = getRatioDiffInfoForDate(currentDate, dataSource);
                        if (sortByJingYestEnabled2) {
                            return stocks.map((s, pos) => {
                                const nm = s.stock ? s.stock.trim() : '';
                                const ip = parallelStockNames2.has(nm);
                                const ih = nm && jingYestHighlightSet2 && jingYestHighlightSet2.has(nm);
                                const tier = ih ? 0 : (ip ? 1 : 2);
                                const fi = (tier === 0 || tier === 1) ? info.get(nm) : null;
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
                            const q = nm && parallelStockNames2.has(nm);
                            const fi = q ? info.get(nm) : null;
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

                // 组装每行的展示数据（与 renderAuctionPage2 19660-19758 同口径）
                let page2RowSeq = 0;
                const enrichedGroups = sortedGroups.map(group => {
                    let rankAppearCount = 0;
                    try { rankAppearCount = getTopicRankCountThisWeek(group.topic, __rankDataForThisRender, __coreTopicsForThisRender); } catch (e) {}
                    const rankAppearText = rankAppearCount > 0 ? ' 上榜' + rankAppearCount + '次' : '';
                    const starText = group.topic !== '其它' ? getStarSymbols(group.starCount) : '';
                    const strengthText = (group.topic !== '其它' && group.strength !== null) ? ' 强度<span style="color:#ef4444;">' + group.strength + '%</span>' : '';
                    const topicAllowsGroupExpand = group.topic !== '其它' && group.topic !== '并购重组';
                    const isGroupExpanded = auctionStore.p2ExpandedTopics.has(_p + '|' + group.topic);

                    const stocks = sortGroupStocks(group.stocks).map(stock => {
                        let ratioClass = 'auction-topic-ratio';
                        if (stock.ratioValue >= 10) ratioClass = 'auction-topic-ratio highlight';
                        else if (stock.ratioValue >= 4.5) ratioClass = 'auction-topic-ratio highlight-light';

                        let ratioArrow = '';
                        if (prevAuctionList.length > 0 && stock.stock) {
                            const pi = __prevAuctionByName.get(stock.stock.trim());
                            if (pi && pi.yestVolume) {
                                const pv = parseFloat(pi.volume) || 0, py = parseFloat(pi.yestVolume) || 0;
                                if (py > 0) {
                                    const prr = Math.round((pv / py) * 100), crr = Math.round(stock.ratioValue);
                                    if (crr > prr) ratioArrow = '<span style="color:#ef4444;">⬆</span>';
                                    else if (crr < prr) ratioArrow = '<span style="color:#10b981;">⬇</span>';
                                }
                            }
                        }

                        const changeValue = getChangePctDisplay(stock);
                        let changeClass = 'auction-topic-change';
                        if (changeValue.includes('涨停') || (changeValue.startsWith('-') === false && changeValue !== '-')) changeClass = 'auction-topic-change auction-change-red';
                        else if (changeValue.startsWith('-')) changeClass = 'auction-topic-change auction-change-green';

                        const topicsDisplay = stock.topics ? stock.topics.join(',').replace(/[，、;；]/g, ',') : '-';
                        const topicCount = stockTopicCount[stock.stock] || 1;
                        let stockStyle = '', topicNameStyle = '';
                        if (topicCount >= 3) { stockStyle = 'color:#ef4444;font-weight:500;'; topicNameStyle = 'color:#6b7280;font-weight:400;'; }
                        else if (topicCount === 2) { stockStyle = 'color:#1f2937;font-weight:500;'; topicNameStyle = 'color:#6b7280;font-weight:400;'; }
                        else { stockStyle = 'color:rgba(0,0,0,0.6);font-weight:500;'; topicNameStyle = 'color:#6b7280;font-weight:400;'; }

                        const auctionItem = __auctionByName.get(stock.stock ? stock.stock.trim() : '');
                        let rowClass = 'auction-topic-row';
                        if (auctionItem) {
                            // 方案 B：标签从 stocksData 实时派生，不读 auctionItem.bought/sold/fixed
                            const _ts2 = deriveAuctionTagState(auctionItem.stock.trim(), currentDate, __tagStateCache);
                            if (_ts2.sold) rowClass = 'auction-topic-row sold';
                            else if (_ts2.bought) rowClass = 'auction-topic-row bought';
                            else if (_ts2.selected) rowClass = 'auction-topic-row selected';
                            else if (auctionItem.selected === true) rowClass = 'auction-topic-row manual-selected';
                        }
                        const nm = stock.stock ? stock.stock.trim() : '';
                        const isJingYestMatch2 = sortByJingYestEnabled2 && jingYestHighlightSet2 && nm && jingYestHighlightSet2.has(nm);
                        const isParallelMatch2 = sortByParallelEnabled2 && !sortByJingYestEnabled2 && parallelStockNames2 && nm && parallelStockNames2.has(nm);
                        const isHighRatioMatch2 = sortByRatioEnabled2 && nm && highRatioInfo2.stockNames.has(nm);
                        if (isJingYestMatch2) rowClass += ' jing-yest-match';
                        else if (isParallelMatch2) rowClass += ' parallel-match';
                        else if (isHighRatioMatch2) rowClass += ' high-ratio';

                        const topicAllowsExpand = group.topic !== '其它' && group.topic !== '并购重组';
                        const rowKey = 'p2-' + group.topic + '-' + (page2RowSeq++);
                        const trendTriggerClass = topicAllowsExpand ? 'auction-trend-trigger-p2' : '';

                        return {
                            stock: stock.stock || '-',
                            rowClass: rowClass + ' ' + trendTriggerClass,
                            ratioClass, changeClass, changeValue, ratioArrow, ratio: stock.ratio,
                            topicsDisplay, stockStyle, topicNameStyle, rowKey, topicAllowsExpand,
                            panelId: _p + 'TrendPanelP2-' + rowKey,
                            highlight: nm === auctionStore.highlightStock
                        };
                    });

                    return {
                        topic: group.topic,
                        stocks,
                        rankAppearText, starText, strengthText,
                        topicAllowsGroupExpand, isGroupExpanded,
                        count: group.stocks.length
                    };
                });

                const __p2Result = {
                    empty: false,
                    dataSource, _p,
                    groups: enrichedGroups,
                    isStrengthSortEnabled,
                    stats: {
                        highRatioCount: highRatioInfo2.count,
                        jingYestCount: jingYestHighlightSet2 ? jingYestHighlightSet2.size : 0
                    }
                };
                const __p2Total = performance.now() - __p2T0;
                _dbgLogVerbose('[PERF-SEG] Page2ViewData/' + dataSource + ' 总耗时=' + __p2Total.toFixed(1) + 'ms ｜ getTodayGroupList前=' + (__p2BeforeGroups - __p2T0).toFixed(1) + 'ms ｜ getTopicGroups=' + (__p2AfterGroups - __p2BeforeGroups).toFixed(1) + 'ms ｜ 分组后处理(排序/组装HTML)=' + (__p2Total - (__p2AfterGroups - __p2T0)).toFixed(1) + 'ms（' + groups.length + '个分组）');
                return __p2Result;
            }

            const Page2Board = {
                name: 'Page2Board',
                directives: { longpress: LongPressDirective },
                props: { dataSource: { type: String, default: 'auction' } },
                setup(props) {
                    // [PERF-CORE] 记忆化 + 仅第 2 页可见时才计算
                    const view = Vue.computed(() => _memoizedView('p2', props.dataSource, 1, computeAuctionPage2ViewData));
                    function onStrengthSort() { toggleStrengthSort(); }
                    function onStockClick(stock) {
                        const nm = (typeof stock === 'string') ? stock : stock;
                        if (nm && nm !== '-') jumpToAuctionPage1(nm);
                    }
                    function onTopicRowClick(row) {
                        if (row.topicAllowsExpand && row.stock && row.stock !== '-' && row.rowKey) {
                            toggleAuctionTrendPanelP2(row.rowKey, row.stock);
                        }
                    }
                    function onGroupExpandClick(topic) { toggleTopicGroupTrendPanels(topic); }
                    function onTopicLongPress(el) {
                        const sn = el.getAttribute('data-stock');
                        if (sn) openAuctionNoteEditFromPage2(sn);
                    }
                    // Vue 路径提前 return，跳过了 innerHTML 路径尾部的第二页计数器 DOM 写入和
                    // 展开/恢复。这里在渲染完成后（flush:post）响应式补回。
                    function _afterRender() {
                        const v = view.value;
                        if (v.empty) return;
                        const _p = props.dataSource === 'hot' ? 'hot' : 'auction';
                        // 第二页头部：竞/昨数 / 竞放量数 / 箭头（与 innerHTML 路径 19855-19884 同口径）
                        const jingYestCountEl2 = document.getElementById(_p + 'JingYestCount2');
                        if (jingYestCountEl2) jingYestCountEl2.textContent = v.stats.jingYestCount || '-';
                        const highRatioCountEl2 = document.getElementById(_p + 'HighRatioCount2');
                        if (highRatioCountEl2) highRatioCountEl2.textContent = v.stats.highRatioCount;
                        const highRatioArrowEl2 = document.getElementById(_p + 'HighRatioArrow2');
                        if (highRatioArrowEl2) {
                            const prevDateForRatio2 = getPreviousTradingDay(currentDate);
                            if (prevDateForRatio2) {
                                const yHigh2 = getHighRatioStocksForDate(prevDateForRatio2, props.dataSource);
                                if (v.stats.highRatioCount > yHigh2.count) { highRatioArrowEl2.textContent = ' ⬆'; highRatioArrowEl2.style.color = '#dc2626'; }
                                else if (v.stats.highRatioCount < yHigh2.count) { highRatioArrowEl2.textContent = ' ⬇'; highRatioArrowEl2.style.color = '#16a34a'; }
                                else { highRatioArrowEl2.textContent = ' -'; highRatioArrowEl2.style.color = '#92400e'; }
                            } else { highRatioArrowEl2.textContent = ''; }
                        }
                        // 全部展开开关打开时批量展开，否则恢复用户手动展开的题材组
                        // （Vue 重渲染会重建面板 DOM，需在 post-flush 后恢复内容/显隐）
                        if (document.getElementById(_p + 'ExpandAllToggle2')?.checked) {
                            expandAllAuctionTrendPanelsP2(_p);
                        } else {
                            restoreExpandedTopicGroupsP2(props.dataSource);
                        }
                    }
                    Vue.onMounted(_afterRender);
                    Vue.watch(view, _afterRender, { flush: 'post' });
                    return { view, onStrengthSort, onStockClick, onTopicRowClick, onGroupExpandClick, onTopicLongPress };
                },
                template: `
                    <div class="auction-scroll-container" v-if="!view.empty">
                        <div class="auction-header-row">
                            <div class="auction-header-item auction-header-stock" style="flex:0 0 75px;padding-left:10px;">股票名称</div>
                            <div class="auction-header-item auction-header-change" style="flex:0 0 55px;">涨幅</div>
                            <div class="auction-header-item auction-header-volume" style="flex:1;text-align:left;padding-left:8px;">题材</div>
                            <div class="auction-header-item auction-header-strength-sort" style="flex:0 0 70px;cursor:pointer;" @click="onStrengthSort">
                                <span :class="view.isStrengthSortEnabled ? 'strength-sort-active' : ''">{{ view.isStrengthSortEnabled ? '▼强度' : '强度' }}</span>
                            </div>
                            <div class="auction-header-item auction-header-ratio" style="flex:0 0 50px;">占比</div>
                        </div>
                        <template v-for="g in view.groups" :key="g.topic">
                            <div class="auction-topic-group" :data-topic-group="g.topic">
                                <div v-if="g.topicAllowsGroupExpand" class="auction-topic-expand-row" :data-topic="g.topic" style="cursor:pointer;" @click="onGroupExpandClick(g.topic)">
                                    <span class="auction-topic-expand-arrow" :class="{ expanded: g.isGroupExpanded }">▼</span>
                                </div>
                                <div class="auction-topic-header" :data-topic="g.topic">
                                    <span class="auction-topic-left">【{{ g.topic }}】{{ g.rankAppearText }}</span>
                                    <span class="auction-topic-stars" v-html="g.starText"></span>
                                    <span class="auction-topic-strength" v-html="g.strengthText"></span>
                                    <span class="auction-topic-count">{{ g.count }}只</span>
                                </div>
                                <template v-for="row in g.stocks" :key="row.rowKey">
                                    <div :class="row.rowClass + (row.highlight ? ' highlight-search' : '')" :data-stock="row.stock" :data-rowkey="row.rowKey" style="cursor:pointer;" @click="onTopicRowClick(row)">
                                        <div class="auction-topic-stock auction-topic-no-select" :style="row.stockStyle" @click.stop="onStockClick(row.stock)">{{ row.stock }}</div>
                                        <div :class="row.changeClass + ' auction-topic-no-select'">{{ row.changeValue }}</div>
                                        <div class="auction-topic-name auction-topic-editable auction-topic-no-select" :data-stock="row.stock" :style="row.topicNameStyle"
                                             v-longpress="onTopicLongPress" @contextmenu.prevent>{{ row.topicsDisplay }}</div>
                                        <div :class="row.ratioClass + ' auction-topic-no-select'" style="cursor:pointer;" @click.stop="onStockClick(row.stock)" v-html="row.ratio + row.ratioArrow"></div>
                                    </div>
                                    <div v-if="row.topicAllowsExpand" class="auction-trend-panel" :id="row.panelId" :data-stock="row.stock" style="display:none;"></div>
                                </template>
                            </div>
                        </template>
                    </div>
                    <div class="auction-topic-placeholder" v-else>{{ view.placeholder }}</div>
                `
            };

            function mountPage2BoardSandbox(dataSource, mountElId) {
                const el = document.getElementById(mountElId);
                if (!el) { console.warn('[AUCTION-VUE] Page2 挂载点不存在: ' + mountElId); return null; }
                const app = Vue.createApp({
                    components: { Page2Board },
                    directives: { longpress: LongPressDirective },
                    template: '<page2-board :data-source="ds"></page2-board>',
                    data() { return { ds: dataSource || 'auction' }; }
                });
                return app.mount(el);
            }

            // 暴露到 window 供验证 / 后续阶段接入
            window.computeAuctionPage2ViewData = computeAuctionPage2ViewData;
            window.Page2BoardComponent = Page2Board;
            window.mountPage2BoardSandbox = mountPage2BoardSandbox;

            _dbgLog('[AUCTION-VUE] Phase 6 脚手架就绪：computeAuctionPage2ViewData / Page2Board / mountPage2BoardSandbox 已暴露');

            // ============================================================
            // Phase 8: 第三页（题材历史）+ 统计看板（星标签）组件化
            // ------------------------------------------------------------
            // computeAuctionPage3ViewData / Page3Board：5 日题材强度历史表，
            //   含强度箭头（规则 A/B）、5 级排序、复制按钮可见性。复制按钮走既有
            //   copyAllTopicStocks / copyTopicStocks 全局 handler。
            // computeAuctionStatsViewData / StatsBoard：星无/星现/星平/星增/星减
            //   伞形图 + 图例 + 汇总 + 横向柱状图。强度自算（复刻 renderAuction
            //   18196-18276 口径），不依赖 page0 DOM，避免双开关时读到陈旧值。
            //   原签名/shape patch-in-place 机制退役（Vue diff 天然替代，见方案 §12）。
            // 全量切换：renderAuctionPage3 / renderAuctionStatsBoard 默认路由到此（不再依赖特性开关）。
            // ============================================================

            // ---- 第三页：题材历史 ----
            // 响应式依赖注册：全局 currentDate/currentGroup 非响应式，各 render 入口的
            // Vue 路由块已把这些值同步到 store；这里访问 store 镜像字段，让 computed 在
            // 日期/tab 切换时自动重算（数据本身仍由全局变量提供，store 仅作变更信号）。
            function _touchReactiveCtx() {
                if (!auctionStore) return '';
                return auctionStore.currentDate + '|' + auctionStore.currentGroup + '|' + auctionStore.stocksDataVersion;
            }

            function computeAuctionPage3ViewData(dataSource) {
                dataSource = dataSource || 'auction';
                _touchReactiveCtx();
                const isStrengthSortEnabled = auctionStore.strengthSortEnabled; // 响应式镜像
                const __segT0 = performance.now();
                const allTradingDays = getLastNTradingDays(6);
                if (allTradingDays.length === 0) return { empty: true, placeholder: '暂无交易日数据' };
                const tradingDays = allTradingDays.slice(0, 5);
                const auctionData = getGroupData(dataSource);
                // 性能修复：整个渲染只调用一次 getRankData()（而不是每个题材×每天都调用一次），
                // 避免反复触发 loadAllData() 内的 syncStocksDataToStore() 响应式写入。
                const __rankDataForThisRender = getRankData();
                const allTopicData = {};
                const __segGetDays = performance.now() - __segT0;

                let __segGetTopicGroupsTotal = 0;
                let __segGetTopicGroupsCalls = 0;
                let __segRankCountTotal = 0;
                const __loopT0 = performance.now();
                allTradingDays.forEach(dateStr => {
                    const dayAuctionList = auctionData[dateStr] || [];
                    if (dayAuctionList.length === 0) return;
                    const __gtgT0 = performance.now();
                    const groups = getTopicGroups(dayAuctionList);
                    __segGetTopicGroupsTotal += performance.now() - __gtgT0;
                    __segGetTopicGroupsCalls++;
                    groups.forEach(group => {
                        if (group.topic === '其它' || group.topic === '并购重组') return;
                        if (!allTopicData[group.topic]) allTopicData[group.topic] = [];
                        let strongCount = 0, upCount = 0, downCount = 0;
                        const prevDate = getPreviousTradingDay(dateStr);
                        const prevAuctionList = prevDate ? (auctionData[prevDate] || []) : [];
                        group.stocks.forEach(stock => {
                            let hasDownArrow = false;
                            if (prevAuctionList.length > 0 && stock.stock) {
                                const prevItem = prevAuctionList.find(p => p.stock && p.stock.trim() === stock.stock.trim());
                                if (prevItem && prevItem.yestVolume) {
                                    const prevVolume = parseFloat(prevItem.volume) || 0;
                                    const prevYestVolume = parseFloat(prevItem.yestVolume) || 0;
                                    if (prevYestVolume > 0) {
                                        if (Math.round(stock.ratioValue) < Math.round((prevVolume / prevYestVolume) * 100)) hasDownArrow = true;
                                    }
                                }
                            }
                            if (!hasDownArrow) strongCount++;
                            const changeValue = getChangePctDisplay(stock);
                            if (changeValue && changeValue !== '-') {
                                if (changeValue.includes('涨停') || (!changeValue.startsWith('-') && !changeValue.includes('跌停'))) upCount++;
                                else if (changeValue.startsWith('-') || changeValue.includes('跌停')) downCount++;
                            }
                        });
                        const strength = group.stocks.length > 0 ? Math.round((strongCount / group.stocks.length) * 100) : 0;
                        let rankAppearCount = 0;
                        const __rcT0 = performance.now();
                        try { rankAppearCount = getTopicRankCountByDate(group.topic, dateStr, __rankDataForThisRender); } catch (e) { if (typeof _dbgLog === 'function') _dbgLog('[RANK-CACHE] ⚠️ getTopicRankCountByDate 抛出异常: ' + (e && e.message) + ' | topic=' + group.topic + ' dateStr=' + dateStr); }
                        __segRankCountTotal += performance.now() - __rcT0;
                        allTopicData[group.topic].push({
                            date: dateStr, rankCount: rankAppearCount, starCount: group.starCount,
                            starText: getStarSymbols(group.starCount), strength, stockCount: group.stocks.length,
                            isUp: upCount >= downCount, hasData: true, hasChangeData: upCount > 0 || downCount > 0
                        });
                    });
                });
                const __segLoopTotal = performance.now() - __loopT0;

                // 只保留 5 天 + 补全缺失日期
                const __fillT0 = performance.now();
                const topicData = {};
                Object.keys(allTopicData).forEach(topic => {
                    topicData[topic] = allTopicData[topic].filter(d => tradingDays.includes(d.date));
                });
                Object.keys(topicData).forEach(topic => {
                    const existingDates = topicData[topic].map(d => d.date);
                    tradingDays.forEach(dateStr => {
                        if (!existingDates.includes(dateStr)) {
                            topicData[topic].push({ date: dateStr, rankCount: 0, starCount: 0, starText: '-', strength: 0, stockCount: 0, isUp: null, hasData: false, strengthUp: false });
                        }
                    });
                });
                const __segFillTotal = performance.now() - __fillT0;

                // 强度箭头（规则 A/B），与原 20309-20347 同口径
                const __arrowT0 = performance.now();
                Object.keys(topicData).forEach(topic => {
                    topicData[topic].forEach(dayData => {
                        if (!dayData.hasData) { dayData.strengthUp = false; return; }
                        let prevDayData = null;
                        const currentIndex = tradingDays.indexOf(dayData.date);
                        if (currentIndex < tradingDays.length - 1) {
                            prevDayData = topicData[topic].find(d => d.date === tradingDays[currentIndex + 1]);
                        }
                        const currStrength = dayData.strength || 0;
                        const prevStrength = prevDayData ? (prevDayData.strength || 0) : 0;
                        const currStarCount = dayData.starCount || 0;
                        const prevStarCount = prevDayData ? (prevDayData.starCount || 0) : 0;
                        if (currStrength > prevStrength) dayData.strengthUp = true;
                        else if (currStrength < prevStrength) {
                            if (prevStrength > 70 && prevStarCount > 0) dayData.strengthUp = true;
                            else if (prevStarCount === 0 && currStarCount > 0) dayData.strengthUp = true;
                            else dayData.strengthUp = false;
                        } else dayData.strengthUp = true;
                    });
                });
                const __segArrowTotal = performance.now() - __arrowT0;

                const validTopics = Object.entries(topicData)
                    .filter(([topic, data]) => data.filter(d => d.hasData).length >= 2)
                    .map(([topic, data]) => ({ topic, data }));
                if (validTopics.length === 0) {
                    _dbgLogVerbose('[PERF-SEG] Page3ViewData/' + dataSource + ' 提前返回(empty)：getLastNTradingDays=' + __segGetDays.toFixed(1) + 'ms，循环总耗时=' + __segLoopTotal.toFixed(1) + 'ms（其中getTopicGroups=' + __segGetTopicGroupsTotal.toFixed(1) + 'ms/' + __segGetTopicGroupsCalls + '次，getTopicRankCountByDate=' + __segRankCountTotal.toFixed(1) + 'ms），补全=' + __segFillTotal.toFixed(1) + 'ms，箭头=' + __segArrowTotal.toFixed(1) + 'ms');
                    return { empty: true, placeholder: '暂无符合条件的题材（需5日内出现2次以上）' };
                }

                // 排序（强度模式 / 5 级优先），与原 20359-20425 同口径
                const __sortT0 = performance.now();
                validTopics.sort((a, b) => {
                    const todayDate = tradingDays[0], prevDate = tradingDays[1];
                    const aTodayData = a.data.find(d => d.date === todayDate);
                    const aPrevData = a.data.find(d => d.date === prevDate);
                    const bTodayData = b.data.find(d => d.date === todayDate);
                    const bPrevData = b.data.find(d => d.date === prevDate);
                    if (isStrengthSortEnabled) {
                        const aTS = aTodayData && aTodayData.hasData ? (aTodayData.strength || 0) : 0;
                        const bTS = bTodayData && bTodayData.hasData ? (bTodayData.strength || 0) : 0;
                        return bTS - aTS;
                    }
                    const aTHD = (aTodayData && aTodayData.hasData) || false;
                    const bTHD = (bTodayData && bTodayData.hasData) || false;
                    if (aTHD !== bTHD) return bTHD ? 1 : -1;
                    const aTHS = aTodayData && aTodayData.hasData && (aTodayData.starCount || 0) > 0;
                    const bTHS = bTodayData && bTodayData.hasData && (bTodayData.starCount || 0) > 0;
                    if (aTHS !== bTHS) return bTHS ? 1 : -1;
                    const aTS = aTodayData && aTodayData.hasData ? (aTodayData.strength || 0) : 0;
                    const aPS = aPrevData && aPrevData.hasData ? (aPrevData.strength || 0) : 0;
                    const bTS = bTodayData && bTodayData.hasData ? (bTodayData.strength || 0) : 0;
                    const bPS = bPrevData && bPrevData.hasData ? (bPrevData.strength || 0) : 0;
                    const aTSC = aTodayData && aTodayData.hasData ? (aTodayData.starCount || 0) : 0;
                    const aPSC = aPrevData && aPrevData.hasData ? (aPrevData.starCount || 0) : 0;
                    const bTSC = bTodayData && bTodayData.hasData ? (bTodayData.starCount || 0) : 0;
                    const bPSC = bPrevData && bPrevData.hasData ? (bPrevData.starCount || 0) : 0;
                    const aSND = aTS >= aPS || (aTS < aPS && aPS > 70 && aPSC > 0) || (aTS < aPS && aPSC === 0 && aTSC > 0);
                    const bSND = bTS >= bPS || (bTS < bPS && bPS > 70 && bPSC > 0) || (bTS < bPS && bPSC === 0 && bTSC > 0);
                    if (aSND !== bSND) return bSND ? 1 : -1;
                    const aUpDays = a.data.filter(d => d.hasChangeData && d.isUp).length;
                    const bUpDays = b.data.filter(d => d.hasChangeData && d.isUp).length;
                    if (aUpDays !== bUpDays) return bUpDays - aUpDays;
                    const aTotal = a.data.filter(d => d.hasData).reduce((s, d) => s + (d.starCount || 0), 0);
                    const bTotal = b.data.filter(d => d.hasData).reduce((s, d) => s + (d.starCount || 0), 0);
                    return bTotal - aTotal;
                });
                const __segSortTotal = performance.now() - __sortT0;

                // 组装每行展示数据 + 箭头，与原 20429-20582 同口径
                const __buildT0 = performance.now();
                const enrichedTopics = validTopics.map(({ topic, data }) => {
                    data.sort((a, b) => b.date.localeCompare(a.date));
                    const todayData = data.find(d => d.date === currentDate);
                    const hasTodayData = !!(todayData && todayData.hasData);
                    const rows = data.map((dayData, index) => {
                        const isToday = dayData.date === currentDate;
                        const rowClass = isToday ? 'auction-topic-history-row today' : 'auction-topic-history-row';
                        const dp = dayData.date.split('-');
                        const formattedDate = parseInt(dp[1]) + '月' + parseInt(dp[2]);
                        let arrow = '';
                        if (index < data.length - 1) {
                            const prevDayData = data[index + 1];
                            if (prevDayData) arrow = _p3Arrow(dayData, prevDayData);
                        } else {
                            const prevDate = getPreviousTradingDay(dayData.date);
                            if (prevDate) {
                                const prevDayData = allTopicData[topic] ? allTopicData[topic].find(d => d.date === prevDate) : null;
                                arrow = _p3Arrow(dayData, prevDayData);
                            }
                        }
                        const rankColor = dayData.rankCount === 0 ? '#9ca3af' : '#9333ea';
                        return _p3BuildRow(rowClass, topic, dayData, formattedDate, arrow, rankColor);
                    });
                    return { topic, hasTodayData, rows };
                });
                const __segBuildTotal = performance.now() - __buildT0;

                const __segGrandTotal = performance.now() - __segT0;
                // [PERF-CORE] 这两条统计日志默认静默（window._DBG_VERBOSE=true 时恢复），
                // 避免每次计算都同步写 sessionStorage
                _dbgLogVerbose('[PERF-SEG] Page3ViewData/' + dataSource + ' 总耗时=' + __segGrandTotal.toFixed(1) + 'ms ｜ 循环=' + __segLoopTotal.toFixed(1) + 'ms(getTopicGroups=' + __segGetTopicGroupsTotal.toFixed(1) + '/' + __segGetTopicGroupsCalls + '次, rankCount=' + __segRankCountTotal.toFixed(1) + 'ms) ｜ 补全=' + __segFillTotal.toFixed(1) + 'ms ｜ 箭头=' + __segArrowTotal.toFixed(1) + 'ms ｜ 排序=' + __segSortTotal.toFixed(1) + 'ms ｜ 组装HTML=' + __segBuildTotal.toFixed(1) + 'ms（' + validTopics.length + '个题材）');
                _dbgLogVerbose('[RANK-CACHE] calls=' + window._rankCacheStats.calls + ' earlyReturn=' + window._rankCacheStats.earlyReturn + ' hit=' + window._rankCacheStats.hit + ' missNoEntry=' + window._rankCacheStats.missNoEntry + ' missRefChanged=' + window._rankCacheStats.missRefChanged + ' missNoTopic=' + window._rankCacheStats.missNoTopic + ' | cache当前共缓存' + _topicRankByDateCache.size + '天 | allData是否为null=' + (allData === null));

                return { empty: false, dataSource, topics: enrichedTopics, isStrengthSortEnabled };
            }

            // 第三页箭头计算（提取自原 20462-20523，hasData 对比规则 A/B）
            function _p3Arrow(dayData, prevDayData) {
                const currStrength = dayData.hasData ? (dayData.strength || 0) : 0;
                const prevStrength = prevDayData && prevDayData.hasData ? (prevDayData.strength || 0) : 0;
                const currStarCount = dayData.hasData ? (dayData.starCount || 0) : 0;
                const prevStarCount = prevDayData && prevDayData.hasData ? (prevDayData.starCount || 0) : 0;
                if (!dayData.hasData) return '<span style="color:#9ca3af;">-</span>';
                if (currStrength > prevStrength) return '<span style="color:#ef4444;">⬆</span>';
                if (currStrength < prevStrength) {
                    if (prevStrength > 70 && prevStarCount > 0) return '<span style="color:#ef4444;">≈</span>';
                    if (prevStarCount === 0 && currStarCount > 0) return '<span style="color:#ef4444;">⬆</span>';
                    return '<span style="color:#10b981;">⬇</span>';
                }
                return '<span style="color:#f97316;">平</span>';
            }

            // 第三页单行构建（提取自原 20529-20577，三种变体）
            function _p3BuildRow(rowClass, topic, dayData, formattedDate, arrow, rankColor) {
                const base = { rowClass, topic, date: dayData.date, formattedDate, rankColor, arrow };
                if (dayData.hasData) {
                    if (dayData.hasChangeData) {
                        const trendColor = dayData.isUp ? '#ef4444' : '#10b981';
                        const trendText = dayData.isUp ? '涨' : '跌';
                        const starStyle = (dayData.starCount >= 6) ? 'font-size:13px;font-weight:600;' : '';
                        return Object.assign(base, {
                            hasData: true, starText: dayData.starText, starStyle, trendColor,
                            strength: dayData.strength + '%', stockCount: dayData.stockCount,
                            trendText, rankText: '上榜' + dayData.rankCount + '次'
                        });
                    }
                    const starColor = (dayData.starCount > 0) ? '#f97316' : '#333';
                    const starStyle = (dayData.starCount >= 6) ? 'font-size:13px;font-weight:600;' : '';
                    return Object.assign(base, {
                        hasData: true, noChange: true, starText: dayData.starText, starStyle, starColor,
                        strength: dayData.strength + '%', stockCount: dayData.stockCount,
                        rankText: '上榜' + dayData.rankCount + '次'
                    });
                }
                return Object.assign(base, { hasData: false, starText: '-', strength: '0%', stockCount: '0', rankText: '上榜0次' });
            }

            const Page3Board = {
                name: 'Page3Board',
                props: { dataSource: { type: String, default: 'auction' } },
                setup(props) {
                    // [PERF-CORE] 记忆化 + 仅第 3 页可见时才计算
                    const view = Vue.computed(() => _memoizedView('p3', props.dataSource, 2, computeAuctionPage3ViewData));
                    function copyAll(topic) { copyAllTopicStocks(topic, props.dataSource); }
                    function copy5(topic) { copyTopicStocks(topic, 5, props.dataSource); }
                    function copy2(topic) { copyTopicStocks(topic, 2, props.dataSource); }
                    return { view, copyAll, copy5, copy2 };
                },
                template: `
                    <div v-if="!view.empty">
                        <div class="auction-topic-history-group" v-for="t in view.topics" :key="t.topic">
                            <div class="auction-topic-history-title">
                                <span>{{ t.topic }}</span>
                                <span class="auction-topic-copy-btns" v-if="t.hasTodayData">
                                    <span class="auction-topic-copy-btn" @click="copyAll(t.topic)">全复制</span>
                                    <span class="auction-topic-copy-btn" @click="copy5(t.topic)">复制5%</span>
                                    <span class="auction-topic-copy-btn" @click="copy2(t.topic)">复制2%</span>
                                </span>
                            </div>
                            <div class="auction-topic-history-header">
                                <span class="auction-history-col auction-history-date">日期</span>
                                <span class="auction-history-col auction-history-rank">上榜次数</span>
                                <span class="auction-history-col auction-history-star">星评</span>
                                <span class="auction-history-col auction-history-strength">强度</span>
                                <span class="auction-history-col auction-history-count">总数</span>
                                <span class="auction-history-col auction-history-arrow">变化</span>
                            </div>
                            <template v-for="row in t.rows" :key="t.topic + '|' + row.date">
                                <div v-if="row.hasData && !row.noChange" :class="row.rowClass" :data-topic="row.topic" :data-date="row.date">
                                    <span class="auction-history-col auction-history-date">{{ row.formattedDate }}</span>
                                    <span class="auction-history-col auction-history-rank" :style="{ color: row.rankColor }">{{ row.rankText }}</span>
                                    <span class="auction-history-col auction-history-star" :style="'color:' + row.trendColor + ';' + row.starStyle" v-html="row.starText"></span>
                                    <span class="auction-history-col auction-history-strength" style="font-size:12px;font-weight:500;"><span :style="{ color: row.trendColor }">{{ row.strength }}</span></span>
                                    <span class="auction-history-col auction-history-count" style="font-size:12px;font-weight:500;" :style="{ color: row.trendColor }">{{ row.stockCount }}</span>
                                    <span class="auction-history-col auction-history-arrow" style="font-size:12px;font-weight:500;"><span :style="{ color: row.trendColor }">{{ row.trendText }}</span><span v-html="row.arrow"></span></span>
                                </div>
                                <div v-else-if="row.hasData && row.noChange" :class="row.rowClass" :data-topic="row.topic" :data-date="row.date">
                                    <span class="auction-history-col auction-history-date">{{ row.formattedDate }}</span>
                                    <span class="auction-history-col auction-history-rank" :style="{ color: row.rankColor }">{{ row.rankText }}</span>
                                    <span class="auction-history-col auction-history-star" :style="'color:' + row.starColor + ';' + row.starStyle" v-html="row.starText"></span>
                                    <span class="auction-history-col auction-history-strength" style="font-size:12px;font-weight:500;"><span :style="{ color: row.starColor }">{{ row.strength }}</span></span>
                                    <span class="auction-history-col auction-history-count" style="font-size:12px;font-weight:500;" :style="{ color: row.starColor }">{{ row.stockCount }}</span>
                                    <span class="auction-history-col auction-history-arrow" style="font-size:12px;font-weight:500;"><span v-html="row.arrow"></span></span>
                                </div>
                                <div v-else :class="row.rowClass" :data-topic="row.topic" :data-date="row.date">
                                    <span class="auction-history-col auction-history-date">{{ row.formattedDate }}</span>
                                    <span class="auction-history-col auction-history-rank" :style="{ color: row.rankColor }">{{ row.rankText }}</span>
                                    <span class="auction-history-col auction-history-star">-</span>
                                    <span class="auction-history-col auction-history-strength" style="font-size:12px;font-weight:500;"><span style="color:#333;">0%</span></span>
                                    <span class="auction-history-col auction-history-count" style="font-size:12px;font-weight:500;color:#333;">0</span>
                                    <span class="auction-history-col auction-history-arrow" style="font-size:12px;font-weight:500;"><span v-html="row.arrow"></span></span>
                                </div>
                            </template>
                        </div>
                    </div>
                    <div class="auction-topic-placeholder" v-else>{{ view.placeholder }}</div>
                `
            };

            // ---- 统计看板：星标签 ----
            function computeAuctionStatsViewData(dataSource) {
                dataSource = dataSource || 'auction';
                _touchReactiveCtx();
                // 分组守卫：与原 renderAuctionStatsBoard 一致，仅当前 tab 才更新看板
                if (dataSource !== currentGroup) return { skip: true };
                const todayAuction = getTodayGroupList(dataSource);
                const yesterdayDate = getYesterdayDate(currentDate);
                const yesterdayAuction = yesterdayDate ? (getGroupData(dataSource)[yesterdayDate] || []) : [];
                const todayGroups = getTopicGroups(todayAuction || []);
                const yesterdayGroups = yesterdayDate ? getTopicGroups(yesterdayAuction || []) : [];

                if (!todayGroups || todayGroups.length === 0) return { empty: true };

                const cats = {
                    xianian: { label: '星无', count: 0, color: '#94a3b8' },
                    xingxian: { label: '星现', count: 0, color: '#f43f5e' },
                    xingping: { label: '星平', count: 0, color: '#3b82f6' },
                    xingzeng: { label: '星增', count: 0, color: '#f59e0b' },
                    xingjian: { label: '星减', count: 0, color: '#10b981' }
                };
                let maxStockTopic = null, maxStockCount = 0;
                todayGroups.forEach(group => {
                    if (!group.topic || group.topic === '---' || group.topic === '其它' || group.topic === '并购重组') return;
                    const todayStarCount = group.starCount || 0;
                    const yesterdayGroup = yesterdayGroups.find(g => g.topic === group.topic);
                    const yesterdayStarCount = yesterdayGroup ? (yesterdayGroup.starCount || 0) : 0;
                    if (todayStarCount === 0) cats.xianian.count++;
                    else if (todayStarCount > 0 && yesterdayStarCount === 0) cats.xingxian.count++;
                    else if (todayStarCount > 0 && todayStarCount === yesterdayStarCount) cats.xingping.count++;
                    else if (todayStarCount > yesterdayStarCount) cats.xingzeng.count++;
                    else if (todayStarCount > 0 && todayStarCount < yesterdayStarCount) cats.xingjian.count++;
                    const stockCount = group.stocks ? group.stocks.length : 0;
                    if (stockCount > maxStockCount) { maxStockCount = stockCount; maxStockTopic = group.topic; }
                });

                const topicCount = todayGroups.filter(g => g.topic && g.topic !== '---' && g.topic !== '其它' && g.topic !== '并购重组').length;
                const total = cats.xianian.count + cats.xingxian.count + cats.xingping.count + cats.xingzeng.count + cats.xingjian.count;
                const todayStockCount = (todayAuction || []).length;
                const yesterdayStockCount = (yesterdayAuction || []).length;
                let stockCountArrow = todayStockCount > yesterdayStockCount ? '↑' : (todayStockCount < yesterdayStockCount ? '↓' : '-');
                const stockCountHtml = todayStockCount + '<span style="color:#1f2937;margin-left:2px;">' + stockCountArrow + '</span>';

                if (total === 0) {
                    return { nostar: true, topicCount, stockCountHtml, maxStockTopic, maxStockCount };
                }

                // 甜甜圈几何（与原 20699-20720 同口径）
                const order = ['xianian', 'xingxian', 'xingping', 'xingzeng', 'xingjian'];
                const size = 220, cx = size / 2, cy = size / 2, strokeWidth = 34, r = (size - strokeWidth) / 2;
                const circumference = 2 * Math.PI * r;
                let offsetAcc = 0;
                const segments = [];
                order.forEach(key => {
                    const c = cats[key];
                    if (c.count <= 0) return;
                    const fraction = c.count / total;
                    segments.push({
                        color: c.color, dash: fraction * circumference, gap: circumference - fraction * circumference,
                        rotation: (offsetAcc / total) * 360 - 90, cx, cy, r, strokeWidth
                    });
                    offsetAcc += c.count;
                });

                // 强度自算（复刻 renderAuction 18196-18276），不读 page0 DOM
                const auctionData = getGroupData(dataSource);
                const prevDate = getPreviousTradingDay(currentDate);
                const prevAuctionList = prevDate ? (auctionData[prevDate] || []) : [];
                const prevPrevDate = getPreviousTradingDay(prevDate);
                const prevPrevAuctionList = prevPrevDate ? (auctionData[prevPrevDate] || []) : [];
                let strengthText = '-', strengthArrow = '-';
                if ((todayAuction || []).length > 0) {
                    let strongCount = 0;
                    todayAuction.forEach(item => {
                        let hasDown = false;
                        if (prevAuctionList.length > 0 && item.stock) {
                            const prevItem = prevAuctionList.find(p => p.stock && p.stock.trim() === item.stock.trim());
                            if (prevItem && prevItem.yestVolume) {
                                const pv = parseFloat(prevItem.volume) || 0, py = parseFloat(prevItem.yestVolume) || 0;
                                if (py > 0) {
                                    const prv = (pv / py) * 100;
                                    const crv = (parseFloat(item.volume) || 0) / (parseFloat(item.yestVolume) || 1) * 100;
                                    if (crv < prv) hasDown = true;
                                }
                            }
                        }
                        if (!hasDown) strongCount++;
                    });
                    const todayStrength = Math.round((strongCount / todayAuction.length) * 100);
                    let yesterdayStrongCount = 0;
                    const yesterdayTotalCount = prevAuctionList.length;
                    if (yesterdayTotalCount > 0) {
                        prevAuctionList.forEach(item => {
                            let hasDown = false;
                            if (prevPrevAuctionList.length > 0 && item.stock) {
                                const pp = prevPrevAuctionList.find(p => p.stock && p.stock.trim() === item.stock.trim());
                                if (pp && pp.yestVolume) {
                                    const ppv = parseFloat(pp.volume) || 0, ppy = parseFloat(pp.yestVolume) || 0;
                                    if (ppy > 0) {
                                        const pprv = (ppv / ppy) * 100;
                                        const prv = (parseFloat(item.volume) || 0) / (parseFloat(item.yestVolume) || 1) * 100;
                                        if (prv < pprv) hasDown = true;
                                    }
                                }
                            }
                            if (!hasDown) yesterdayStrongCount++;
                        });
                    }
                    const yesterdayStrength = yesterdayTotalCount > 0 ? Math.round((yesterdayStrongCount / yesterdayTotalCount) * 100) : null;
                    strengthText = todayStrength + '% ';
                    if (yesterdayStrength !== null) {
                        strengthArrow = todayStrength > yesterdayStrength ? '⬆' : (todayStrength < yesterdayStrength ? '⬇' : '-');
                    } else strengthArrow = '-';
                }

                // 中心显示（空仓判定，与原 20729-20752 同口径）
                const todayJiwang = getTodayJiwang();
                const isKongcang = todayJiwang && todayJiwang.jielun === '空仓';
                let centerColor = '#1f2937', displayArrow = '', centerLabel = '强度';
                if (isKongcang) { centerColor = '#10b981'; displayArrow = strengthArrow === '⬇' ? '↓' : (strengthArrow === '⬆' ? '↑' : ''); centerLabel = '空仓'; }
                else if (strengthArrow === '⬇') { centerColor = '#10b981'; displayArrow = '↓'; centerLabel = '空仓'; }
                else if (strengthArrow === '⬆') { centerColor = '#ef4444'; displayArrow = '↑'; centerLabel = '出手'; }
                else { centerColor = '#1f2937'; displayArrow = ''; centerLabel = '强度'; }

                const legend = order.map(key => {
                    const c = cats[key];
                    const pct = total > 0 ? Math.round((c.count / total) * 100) : 0;
                    return { key, label: c.label, color: c.color, count: c.count, pct };
                });
                const maxCount = Math.max(...order.map(key => cats[key].count), 1);
                const bars = order.map(key => {
                    const c = cats[key];
                    return { key, label: c.label, color: c.color, count: c.count, widthPct: Math.round((c.count / maxCount) * 100) };
                });

                return {
                    full: true, segments, cx, cy, r, strokeWidth, size,
                    centerColor, centerLabel, centerValue: strengthText + displayArrow,
                    strengthText, legend, bars, topicCount, stockCountHtml, maxStockTopic, maxStockCount
                };
            }

            const StatsBoard = {
                name: 'StatsBoard',
                props: { dataSource: { type: String, default: 'auction' } },
                setup(props) {
                    // [PERF-CORE] 记忆化 + 星标签统计看板是独立常驻 DOM（不在滑动页内），
                    // 跟随当前 tab 计算（pageIdx=null）；背景 tab 不计算。
                    const view = Vue.computed(() => _memoizedView('stats', props.dataSource, null, computeAuctionStatsViewData));
                    return { view };
                },
                template: `
                    <div v-if="view.full">
                        <div class="star-stats-donut-wrap">
                            <svg class="star-stats-donut-svg" :viewBox="'0 0 ' + view.size + ' ' + view.size" id="starStatsDonutSvg">
                                <circle :cx="view.cx" :cy="view.cy" :r="view.r" fill="none" stroke="#f1f5f9" :stroke-width="view.strokeWidth"></circle>
                                <circle v-for="(s, i) in view.segments" :key="i" :cx="s.cx" :cy="s.cy" :r="s.r" fill="none" :stroke="s.color" :stroke-width="s.strokeWidth"
                                    :stroke-dasharray="s.dash + ' ' + s.gap" stroke-dashoffset="0"
                                    :transform="'rotate(' + s.rotation + ' ' + s.cx + ' ' + s.cy + ')'" stroke-linecap="butt"></circle>
                                <text :x="view.cx" :y="view.cy - 4" text-anchor="middle" class="star-stats-donut-center-value" id="starStatsDonutValue" :style="{ fill: view.centerColor }">{{ view.centerValue }}</text>
                                <text :x="view.cx" :y="view.cy + 16" text-anchor="middle" class="star-stats-donut-center-label" id="starStatsDonutLabel" :style="{ fill: view.centerColor }">{{ view.centerLabel }}</text>
                            </svg>
                            <div class="star-stats-legend">
                                <div class="star-stats-legend-item" v-for="l in view.legend" :key="l.key" :data-cat="l.key">
                                    <span class="star-stats-legend-dot" :style="{ background: l.color }"></span>
                                    <span>{{ l.label }}</span>
                                    <span class="star-stats-legend-value">{{ l.count }}（{{ l.pct }}%）</span>
                                </div>
                            </div>
                        </div>
                        <div class="star-stats-summary">
                            <div class="star-stats-summary-item">
                                <div class="star-stats-summary-label">题材数量</div>
                                <div class="star-stats-summary-value">{{ view.topicCount }}</div>
                            </div>
                            <div class="star-stats-summary-item">
                                <div class="star-stats-summary-label">个股数量</div>
                                <div class="star-stats-summary-value" v-html="view.stockCountHtml"></div>
                            </div>
                            <div class="star-stats-summary-item">
                                <div class="star-stats-summary-label">个股总数最多题材</div>
                                <div class="star-stats-summary-value topic-name">{{ view.maxStockTopic ? view.maxStockTopic + '（' + view.maxStockCount + '）' : '-' }}</div>
                            </div>
                        </div>
                        <div class="star-stats-divider"></div>
                        <div class="star-stats-bars">
                            <div class="star-stats-bar-row" v-for="b in view.bars" :key="b.key" :data-cat="b.key">
                                <div class="star-stats-bar-label">{{ b.label }}</div>
                                <div class="star-stats-bar-track">
                                    <div class="star-stats-bar-fill" :style="{ width: b.widthPct + '%', background: b.color }"></div>
                                </div>
                                <div class="star-stats-bar-value">{{ b.count }}</div>
                            </div>
                        </div>
                    </div>
                    <div v-else-if="view.nostar">
                        <div class="star-stats-summary">
                            <div class="star-stats-summary-item">
                                <div class="star-stats-summary-label">题材数量</div>
                                <div class="star-stats-summary-value">{{ view.topicCount }}</div>
                            </div>
                            <div class="star-stats-summary-item">
                                <div class="star-stats-summary-label">个股数量</div>
                                <div class="star-stats-summary-value" v-html="view.stockCountHtml"></div>
                            </div>
                            <div class="star-stats-summary-item">
                                <div class="star-stats-summary-label">个股总数最多题材</div>
                                <div class="star-stats-summary-value topic-name">{{ view.maxStockTopic ? view.maxStockTopic + '（' + view.maxStockCount + '）' : '-' }}</div>
                            </div>
                        </div>
                        <div class="star-stats-empty">暂无星变化数据</div>
                    </div>
                    <div v-else-if="view.empty"><div class="star-stats-empty">暂无题材数据</div></div>
                `
            };

            function mountPage3BoardSandbox(dataSource, mountElId) {
                const __mT0 = performance.now();
                window._page3MountCount = (window._page3MountCount || 0) + 1;
                _dbgLog('[PERF-MOUNT] mountPage3BoardSandbox 被调用！第' + window._page3MountCount + '次，dataSource=' + dataSource + '，mountElId=' + mountElId + '（如果这条日志频繁出现，说明 Page3 的 Vue app 被反复重新创建，而不是复用已挂载实例——这是比 computed 重算严重得多的开销）');
                const el = document.getElementById(mountElId);
                if (!el) { console.warn('[AUCTION-VUE] Page3 挂载点不存在: ' + mountElId); return null; }
                const app = Vue.createApp({
                    components: { Page3Board },
                    template: '<page3-board :data-source="ds"></page3-board>',
                    data() { return { ds: dataSource || 'auction' }; }
                });
                const __result = app.mount(el);
                _dbgLog('[PERF-MOUNT] mountPage3BoardSandbox 创建+挂载耗时=' + (performance.now() - __mT0).toFixed(1) + 'ms');
                return __result;
            }

            function mountStatsBoardSandbox(dataSource, mountElId) {
                const el = document.getElementById(mountElId);
                if (!el) { console.warn('[AUCTION-VUE] Stats 挂载点不存在: ' + mountElId); return null; }
                const app = Vue.createApp({
                    components: { StatsBoard },
                    template: '<stats-board :data-source="ds"></stats-board>',
                    data() { return { ds: dataSource || 'auction' }; }
                });
                app.mount(el);
                // 返回 app（而非 app.mount 的组件实例）：Vue 3 组件实例没有 unmount()，
                // 只有 app 对象才有。调用方靠返回值调 .unmount() 卸载旧实例。
                return app;
            }

            window.computeAuctionPage3ViewData = computeAuctionPage3ViewData;
            window.Page3BoardComponent = Page3Board;
            window.mountPage3BoardSandbox = mountPage3BoardSandbox;
            window.computeAuctionStatsViewData = computeAuctionStatsViewData;
            window.StatsBoardComponent = StatsBoard;
            window.mountStatsBoardSandbox = mountStatsBoardSandbox;

            _dbgLog('[AUCTION-VUE] Phase 8 脚手架就绪：Page3Board / StatsBoard 已暴露');
        })();
