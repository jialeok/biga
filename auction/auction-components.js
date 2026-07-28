/**
 * auction-components.js
 * 早盘竞价看板 Vue 3 组件层（彻底重构版）
 *
 * 设计原则：
 * 1. 所有显示数据通过 template 渲染，禁止在 watch 中直接操作 DOM。
 * 2. 业务计算抽成纯函数（computeAuction*ViewData），由 Vue computed 缓存。
 * 3. 组件按职责拆分：HeaderStats / HighRatioStat / StockCard / AuctionBoard /
 *    TopicGroup / Page2Board / Page3Board / StatsBoard。
 * 4. 交互统一走 useAuctionEvents，不再直接调用全局函数。
 */
(function () {
    'use strict';
    if (typeof window === 'undefined' || typeof document === 'undefined') return;

    const Vue = window.Vue || (typeof Vue !== 'undefined' ? Vue : null);
    const auctionStore = window.auctionStore;
    if (!Vue || !auctionStore ||
        typeof useAuctionData !== 'function' || typeof useAuctionSort !== 'function' ||
        typeof useAuctionEvents !== 'function' || typeof useAuctionExpand !== 'function') {
        console.warn('[AUCTION-COMPONENTS] Vue、auctionStore 或 auction-composables 未就绪，组件层跳过');
        return;
    }

    // ============================================================
    // 初始化可复用逻辑层
    // ============================================================
    const {
        getTodayList, getPrevList, getPrevPrevList,
        ensureTopicCache, getTagStateCache, getHistRowMap, getHistoryCountMap,
        getConfirmedSoldSet, getSignalSets, getDuibanTushiLink, getObsContext
    } = useAuctionData();
    const { sortPage1RenderOrder, sortPage2GroupStocks } = useAuctionSort();
    const { createHandlers } = useAuctionEvents();
    const { isStockExpanded } = useAuctionExpand();

    // ============================================================
    // 通用工具
    // ============================================================
    function touchReactiveCtx() {
        if (!auctionStore) return '';
        return auctionStore.currentDate + '|' + auctionStore.currentGroup;
    }

    function tabKey(dataSource) {
        return dataSource === 'hot' ? 'hot' : 'auction';
    }

    // ============================================================
    // Page1 视图数据计算
    // ============================================================
    function buildDisplayStockHtml(item, ctx) {
        let html = item.stock || '-';
        const name = item.stock ? item.stock.trim() : '';
        const _tagState = deriveAuctionTagState(name, ctx.date || currentDate, ctx.tagCache);
        const isConfirmedSold = _tagState.sold || ctx.confirmedSoldSet.has(name);
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
        if (!_tagState.sold && !isConfirmedSold) {
            if (isSelected) {
                html += '<sup style="color:#2563eb;font-size:10px;font-weight:700;margin-left:2px;">持</sup>';
            } else if (_isObsBought || isBought) {
                html += '<sup style="color:#dc2626;font-size:10px;font-weight:700;margin-left:2px;">买</sup>';
            }
        }
        return html;
    }

    function enrichAuctionItem(item, index, ctx) {
        const volume = parseFloat(item.volume) || 0;
        const yestVolume = parseFloat(item.yestVolume) || 0;
        let ratioValue = 0;
        let ratio = '-';
        if (yestVolume > 0) { ratioValue = (volume / yestVolume) * 100; ratio = Math.round(ratioValue) + '%'; }

        let ratioArrow = '';
        if (ctx.prevAuctionList.length > 0 && item.stock) {
            const prevItem = getHistRowMap(ctx.prevAuctionList).get(item.stock.trim());
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

        return {
            index, stock: item.stock || '',
            itemClass, ratioClass, numberClass, stockClass, yestColorClass,
            volumeDisplay, volumeHtml, yestVolumeDisplay, ratio, ratioArrow, ratioValue,
            note: displayNote || '',
            displayStockHtml: buildDisplayStockHtml(item, ctx),
            isBought, isSelected, isSold, isConfirmedSold
        };
    }

    function computeAuctionViewData(dataSource) {
        dataSource = dataSource || 'auction';
        touchReactiveCtx();
        const _p = tabKey(dataSource);
        const auctionList = getTodayList(dataSource);
        const prevAuctionList = getPrevList(dataSource, currentDate);
        const prevPrevAuctionList = getPrevPrevList(dataSource, currentDate);

        ensureTopicCache(auctionList);
        const __tagStateCache = getTagStateCache(currentDate);
        const __prevDayMap = getHistRowMap(prevAuctionList);
        const __prevPrevDayMap = getHistRowMap(prevPrevAuctionList);
        const __historyCountMap = getHistoryCountMap(dataSource, currentDate);
        const confirmedSoldSet = getConfirmedSoldSet(auctionList, currentDate);

        const _ss = auctionStore.sortState[_p];
        const sortState = {
            byData: _ss.byData,
            byRatio: _ss.byRatio,
            byParallel: _ss.byParallel,
            byJingYest: _ss.byJingYest
        };
        const jingYestToggleChecked = sortState.byJingYest;

        const highRatioToday = getSignalSets(currentDate, dataSource, { parallel: sortState.byParallel, ratioDiff: sortState.byParallel });
        const duibanTushiLink = getDuibanTushiLink();

        let renderOrder = auctionList.map((it, idx) => idx);
        renderOrder = sortPage1RenderOrder(renderOrder, auctionList, {
            sortState,
            historyCountMap: __historyCountMap,
            prevDayMap: __prevDayMap,
            signalSets: highRatioToday
        });

        const { obsStocks, autoAddedSet, obsBoughtSet } = getObsContext(currentDate, dataSource);
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
                const matchesToday = highRatioToday.jingYest && highRatioToday.jingYest.has(nm);
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
            jingYestToggleChecked, jingYestHighlightSet: highRatioToday.jingYest,
            sortByParallelEnabled: sortState.byParallel, sortByRatioEnabled: sortState.byRatio,
            parallelStocksToday: highRatioToday.parallel, highRatioToday: highRatioToday.highRatio,
            duibanTushiLink, tagCache: __tagStateCache
        };
        const fullOrder = obsIndices.concat(regularIndices);
        const items = fullOrder.map((i, pos) => enrichAuctionItem(auctionList[i], i, ctx));

        const __prevMapForStats = getHistRowMap(prevAuctionList);
        const __prevPrevMapForStats = getHistRowMap(prevPrevAuctionList);
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
                highRatioCount: highRatioToday.highRatio.count,
                jingYestCount: highRatioToday.jingYest ? highRatioToday.jingYest.size : 0
            },
            duibanTushiLink
        };
    }

    // ============================================================
    // Page2 视图数据计算
    // ============================================================
    function computeAuctionPage2ViewData(dataSource) {
        dataSource = dataSource || 'auction';
        touchReactiveCtx();
        const isStrengthSortEnabled = auctionStore.strengthSortEnabled;
        const _p = tabKey(dataSource);
        const auctionList = getTodayList(dataSource);
        if (auctionList.length === 0) return { empty: true, placeholder: '暂无数据' };
        const groups = getTopicGroups(auctionList);
        if (groups.length === 0) return { empty: true, placeholder: '暂无题材分类数据（双击打开核心词管理）' };

        const __rankDataForThisRender = getRankData();
        const __coreTopicsForThisRender = getCoreTopics();
        const prevAuctionList = getPrevList(dataSource, currentDate);

        const __auctionByName = new Map();
        auctionList.forEach(it => { if (it && it.stock) __auctionByName.set(it.stock.trim(), it); });
        const __prevAuctionByName = new Map();
        prevAuctionList.forEach(it => { if (it && it.stock) __prevAuctionByName.set(it.stock.trim(), it); });
        const __tagStateCache = getTagStateCache(currentDate);

        const highRatioInfo2 = getHighRatioStocksForDate(currentDate, dataSource);
        const _ss2 = auctionStore.sortStateP2[_p];
        const sortStateP2 = {
            byRatio: _ss2.byRatio,
            byParallel: _ss2.byParallel,
            byJingYest: _ss2.byJingYest
        };
        const signalSetsP2 = {
            parallel: sortStateP2.byParallel ? getParallelStocksForDate(currentDate, dataSource) : null,
            jingYest: getJingYestHighlightSetForDate(currentDate, dataSource),
            ratioDiff: sortStateP2.byParallel ? getRatioDiffInfoForDate(currentDate, dataSource) : null
        };

        const stockTopicCount = {};
        groups.forEach(g => {
            if (g.topic === '其它') return;
            g.stocks.forEach(s => { if (s.stock) stockTopicCount[s.stock] = (stockTopicCount[s.stock] || 0) + 1; });
        });

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

        let page2RowSeq = 0;
        const enrichedGroups = sortedGroups.map(group => {
            let rankAppearCount = 0;
            try { rankAppearCount = getTopicRankCountThisWeek(group.topic, __rankDataForThisRender, __coreTopicsForThisRender); } catch (e) {}
            const rankAppearText = rankAppearCount > 0 ? ' 上榜' + rankAppearCount + '次' : '';
            const starText = group.topic !== '其它' ? getStarSymbols(group.starCount) : '';
            const strengthText = (group.topic !== '其它' && group.strength !== null) ? ' 强度<span style="color:#ef4444;">' + group.strength + '%</span>' : '';
            const topicAllowsGroupExpand = group.topic !== '其它' && group.topic !== '并购重组';
            const isGroupExpanded = auctionStore.p2ExpandedTopics.has(_p + '|' + group.topic);

            const stocks = sortPage2GroupStocks(group.stocks, {
                auctionByName: __auctionByName,
                prevAuctionByName: __prevAuctionByName,
                sortState: sortStateP2,
                signalSets: signalSetsP2,
                highRatioInfo: highRatioInfo2
            }).map(stock => {
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
                    const _ts2 = deriveAuctionTagState(auctionItem.stock.trim(), currentDate, __tagStateCache);
                    if (_ts2.sold) rowClass = 'auction-topic-row sold';
                    else if (_ts2.bought) rowClass = 'auction-topic-row bought';
                    else if (_ts2.selected) rowClass = 'auction-topic-row selected';
                    else if (auctionItem.selected === true) rowClass = 'auction-topic-row manual-selected';
                }
                const nm = stock.stock ? stock.stock.trim() : '';
                const isJingYestMatch2 = sortStateP2.byJingYest && signalSetsP2.jingYest && nm && signalSetsP2.jingYest.has(nm);
                const isParallelMatch2 = sortStateP2.byParallel && !sortStateP2.byJingYest && signalSetsP2.parallel && nm && signalSetsP2.parallel.has(nm);
                const isHighRatioMatch2 = sortStateP2.byRatio && nm && highRatioInfo2.stockNames.has(nm);
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

        return {
            empty: false,
            dataSource, _p,
            groups: enrichedGroups,
            isStrengthSortEnabled,
            stats: {
                highRatioCount: highRatioInfo2.count,
                jingYestCount: signalSetsP2.jingYest ? signalSetsP2.jingYest.size : 0
            }
        };
    }

    // ============================================================
    // Page3 视图数据计算
    // ============================================================
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

    function computeAuctionPage3ViewData(dataSource) {
        dataSource = dataSource || 'auction';
        touchReactiveCtx();
        const isStrengthSortEnabled = auctionStore.strengthSortEnabled;
        const allTradingDays = getLastNTradingDays(6);
        if (allTradingDays.length === 0) return { empty: true, placeholder: '暂无交易日数据' };
        const tradingDays = allTradingDays.slice(0, 5);
        const auctionData = getGroupData(dataSource);
        const __rankDataForThisRender = getRankData();
        const allTopicData = {};

        allTradingDays.forEach(dateStr => {
            const dayAuctionList = auctionData[dateStr] || [];
            if (dayAuctionList.length === 0) return;
            const groups = getTopicGroups(dayAuctionList);
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
                try { rankAppearCount = getTopicRankCountByDate(group.topic, dateStr, __rankDataForThisRender); } catch (e) {}
                allTopicData[group.topic].push({
                    date: dateStr, rankCount: rankAppearCount, starCount: group.starCount,
                    starText: getStarSymbols(group.starCount), strength, stockCount: group.stocks.length,
                    isUp: upCount >= downCount, hasData: true, hasChangeData: upCount > 0 || downCount > 0
                });
            });
        });

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

        const validTopics = Object.entries(topicData)
            .filter(([topic, data]) => data.filter(d => d.hasData).length >= 2)
            .map(([topic, data]) => ({ topic, data }));
        if (validTopics.length === 0) {
            return { empty: true, placeholder: '暂无符合条件的题材（需5日内出现2次以上）' };
        }

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

        return { empty: false, dataSource, topics: enrichedTopics, isStrengthSortEnabled };
    }

    // ============================================================
    // Stats 视图数据计算
    // ============================================================
    function computeAuctionStatsViewData(dataSource) {
        dataSource = dataSource || 'auction';
        touchReactiveCtx();
        if (dataSource !== currentGroup) return { skip: true };
        const todayAuction = getTodayList(dataSource);
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

    // ============================================================
    // 长按手势指令
    // ============================================================
    const LongPressDirective = {
        beforeMount(el, binding) {
            const cb = typeof binding.value === 'function' ? binding.value : function () { };
            const state = { timer: null, isLongPress: false, isMoved: false, lastTapTime: 0 };
            el._lp = state;
            const start = function (e) {
                if (e.touches && e.touches.length > 1) { clearTimeout(state.timer); return; }
                if (e.button === 2) { return; }
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

    // ============================================================
    // 小组件：Page1 统计条（数据驱动，替代 watch DOM 写入）
    // ============================================================
    const HighRatioStat = {
        name: 'HighRatioStat',
        props: { prefix: { type: String, default: 'auction' }, page: { type: Number, default: 1 } },
        setup(props) {
            const suffix = props.page === 2 ? '2' : '';
            const ds = Vue.computed(() => tabKey(props.prefix));
            const stateKey = props.page === 2 ? 'sortStateP2' : 'sortState';
            const view = Vue.computed(() => {
                touchReactiveCtx();
                if (auctionStore.currentGroup !== ds.value) return null;
                if (props.page === 2 && auctionStore.currentPage !== 1) return null;
                if (props.page === 1 && auctionStore.currentPage !== 0) return null;
                const dataSource = ds.value;
                if (props.page === 2) {
                    const list = getTodayList(dataSource);
                    if (list.length === 0) return { jingYestCount: '-', highRatioCount: '-', arrow: '' };
                    const ss = auctionStore.sortStateP2[ds.value];
                    const signalSets = {
                        parallel: ss.byParallel ? getParallelStocksForDate(currentDate, dataSource) : null,
                        jingYest: getJingYestHighlightSetForDate(currentDate, dataSource),
                        ratioDiff: ss.byParallel ? getRatioDiffInfoForDate(currentDate, dataSource) : null
                    };
                    const highRatioInfo = getHighRatioStocksForDate(currentDate, dataSource);
                    return {
                        jingYestCount: signalSets.jingYest ? signalSets.jingYest.size : 0,
                        highRatioCount: highRatioInfo.count,
                        arrow: computeHighRatioArrow(highRatioInfo.count, dataSource)
                    };
                }
                const viewData = computeAuctionViewData(dataSource);
                return {
                    jingYestCount: viewData.stats.jingYestCount || '-',
                    highRatioCount: viewData.stats.highRatioCount,
                    arrow: computeHighRatioArrow(viewData.stats.highRatioCount, dataSource)
                };
            });

            function computeHighRatioArrow(todayCount, dataSource) {
                const prevDate = getPreviousTradingDay(currentDate);
                if (!prevDate) return { text: '', color: '' };
                const yHigh = getHighRatioStocksForDate(prevDate, dataSource);
                if (todayCount > yHigh.count) return { text: ' ⬆', color: '#dc2626' };
                if (todayCount < yHigh.count) return { text: ' ⬇', color: '#16a34a' };
                return { text: ' -', color: '#92400e' };
            }

            function toggleHelp(e) {
                e.stopPropagation();
                const panelId = props.prefix + 'SortHelpPanel' + suffix;
                auctionStore.actions.toggleSortHelp(panelId);
            }

            return { view, suffix, prefix: props.prefix, toggleHelp };
        },
        template: `
            <div class="auction-highratio-stat" :id="prefix + 'HighRatioStat' + suffix">
                <span style="font-weight:700;color:#dc2626;">竞/昨数：<span :id="prefix + 'JingYestCount' + suffix">{{ view ? view.jingYestCount : '-' }}</span></span>
                <span style="display:inline-block;width:28px;"></span>
                竞放量数：<span :id="prefix + 'HighRatioCount' + suffix" style="font-weight:700;">{{ view ? view.highRatioCount : '-' }}</span>
                <span :id="prefix + 'HighRatioArrow' + suffix" style="font-weight:700;" :style="{ color: view ? view.arrow.color : '' }">{{ view ? view.arrow.text : '' }}</span>
                <span class="auction-sort-help-icon" @click.stop="toggleHelp">?</span>
                <div class="auction-sort-help-panel" :id="prefix + 'SortHelpPanel' + suffix" @click.stop></div>
            </div>
        `
    };

    // ============================================================
    // 小组件：Page1 单行卡片
    // ============================================================
    const StockCard = {
        name: 'StockCard',
        directives: { longpress: LongPressDirective },
        props: { item: { type: Object, required: true }, displayNum: { type: Number, default: 0 }, dataSource: { type: String, default: 'auction' } },
        setup(props) {
            const handlers = createHandlers(props.dataSource);
            const panelId = (props.dataSource === 'hot' ? 'hot' : 'auction') + 'TrendPanel-' + props.item.index;
            const yestEl = Vue.ref(null);
            const nameEl = Vue.ref(null);

            function onYestClick(e) { handlers.onYestClick(yestEl.value, props.item.note, e.currentTarget._lp, e); }
            function onYestContext(e) { handlers.onYestContext(e); }
            function onYestLongPress() { handlers.onYestLongPress(props.item.index, yestEl.value); }
            function onNameClick(e) { handlers.onNameClick(props.item.stock, e.currentTarget._lp, e); }
            function onNameDblClick(e) { handlers.onNameDblClick(props.item.note, yestEl.value, e); }
            function onNameContext(e) { handlers.onNameContext(e); }
            function onNameLongPress() { handlers.onNameLongPress(props.item.stock); }
            function onNumberClick(e) { handlers.onNumberClick(props.item.index, e); }
            function onRatioClick(e) { handlers.onRatioClick(props.item.index, e); }

            return {
                item: props.item, displayNum: props.displayNum, panelId, yestEl, nameEl,
                onYestClick, onYestContext, onYestLongPress,
                onNameClick, onNameDblClick, onNameContext, onNameLongPress,
                onNumberClick, onRatioClick
            };
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

    // ============================================================
    // 组件：Page1 主列表
    // ============================================================
    const AuctionBoard = {
        name: 'AuctionBoard',
        components: { StockCard },
        props: { dataSource: { type: String, default: 'auction' } },
        setup(props) {
            const ds = Vue.computed(() => tabKey(props.dataSource));
            const view = Vue.computed(() => {
                touchReactiveCtx();
                return computeAuctionViewData(ds.value);
            });
            const obsItems = Vue.computed(() => view.value.items.slice(0, view.value.obsIndices.length));
            const regItems = Vue.computed(() => view.value.items.slice(view.value.obsIndices.length));
            const hasObs = Vue.computed(() => view.value.obsIndices.length > 0);
            const hasReg = Vue.computed(() => view.value.regularIndices.length > 0);
            return { view, obsItems, regItems, hasObs, hasReg, dataSource: ds };
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

    // ============================================================
    // 组件：Page2 题材分组
    // ============================================================
    const TopicGroup = {
        name: 'TopicGroup',
        directives: { longpress: LongPressDirective },
        props: { group: { type: Object, required: true }, dataSource: { type: String, default: 'auction' } },
        setup(props) {
            const handlers = createHandlers(props.dataSource);
            return { group: props.group, handlers };
        },
        template: `
            <div class="auction-topic-group" :data-topic-group="group.topic">
                <div v-if="group.topicAllowsGroupExpand" class="auction-topic-expand-row" :data-topic="group.topic" style="cursor:pointer;" @click="handlers.onGroupExpandClick(group.topic, $event)">
                    <span class="auction-topic-expand-arrow" :class="{ expanded: group.isGroupExpanded }">▼</span>
                </div>
                <div class="auction-topic-header" :data-topic="group.topic">
                    <span class="auction-topic-left">【{{ group.topic }}】{{ group.rankAppearText }}</span>
                    <span class="auction-topic-stars" v-html="group.starText"></span>
                    <span class="auction-topic-strength" v-html="group.strengthText"></span>
                    <span class="auction-topic-count">{{ group.count }}只</span>
                </div>
                <template v-for="row in group.stocks" :key="row.rowKey">
                    <div :class="row.rowClass + (row.highlight ? ' highlight-search' : '')" :data-stock="row.stock" :data-rowkey="row.rowKey" style="cursor:pointer;" @click="handlers.onPage2RowClick(row, $event)">
                        <div class="auction-topic-stock auction-topic-no-select" :style="row.stockStyle" @click.stop="handlers.onPage2StockClick(row.stock, $event)">{{ row.stock }}</div>
                        <div :class="row.changeClass + ' auction-topic-no-select'">{{ row.changeValue }}</div>
                        <div class="auction-topic-name auction-topic-editable auction-topic-no-select" :data-stock="row.stock" :style="row.topicNameStyle"
                             v-longpress="handlers.onTopicLongPress" @contextmenu.prevent>{{ row.topicsDisplay }}</div>
                        <div :class="row.ratioClass + ' auction-topic-no-select'" style="cursor:pointer;" @click.stop="handlers.onPage2StockClick(row.stock, $event)" v-html="row.ratio + row.ratioArrow"></div>
                    </div>
                    <div v-if="row.topicAllowsExpand" class="auction-trend-panel" :id="row.panelId" :data-stock="row.stock" style="display:none;"></div>
                </template>
            </div>
        `
    };

    const Page2Board = {
        name: 'Page2Board',
        components: { TopicGroup },
        props: { dataSource: { type: String, default: 'auction' } },
        setup(props) {
            const ds = Vue.computed(() => tabKey(props.dataSource));
            const handlers = createHandlers(props.dataSource);
            const view = Vue.computed(() => {
                touchReactiveCtx();
                return computeAuctionPage2ViewData(ds.value);
            });
            return { view, handlers, dataSource: ds };
        },
        template: `
            <div class="auction-scroll-container" v-if="!view.empty">
                <div class="auction-header-row">
                    <div class="auction-header-item auction-header-stock" style="flex:0 0 75px;padding-left:10px;">股票名称</div>
                    <div class="auction-header-item auction-header-change" style="flex:0 0 55px;">涨幅</div>
                    <div class="auction-header-item auction-header-volume" style="flex:1;text-align:left;padding-left:8px;">题材</div>
                    <div class="auction-header-item auction-header-strength-sort" style="flex:0 0 70px;cursor:pointer;" @click="handlers.onStrengthSortClick">
                        <span :class="view.isStrengthSortEnabled ? 'strength-sort-active' : ''">{{ view.isStrengthSortEnabled ? '▼强度' : '强度' }}</span>
                    </div>
                    <div class="auction-header-item auction-header-ratio" style="flex:0 0 50px;">占比</div>
                </div>
                <topic-group v-for="g in view.groups" :key="g.topic" :group="g" :data-source="dataSource"></topic-group>
            </div>
            <div class="auction-topic-placeholder" v-else>{{ view.placeholder }}</div>
        `
    };

    // ============================================================
    // 组件：Page3 题材历史
    // ============================================================
    const Page3Board = {
        name: 'Page3Board',
        props: { dataSource: { type: String, default: 'auction' } },
        setup(props) {
            const ds = Vue.computed(() => tabKey(props.dataSource));
            const handlers = createHandlers(props.dataSource);
            const view = Vue.computed(() => {
                touchReactiveCtx();
                return computeAuctionPage3ViewData(ds.value);
            });
            return { view, handlers };
        },
        template: `
            <div v-if="!view.empty">
                <div class="auction-topic-history-group" v-for="t in view.topics" :key="t.topic">
                    <div class="auction-topic-history-title">
                        <span>{{ t.topic }}</span>
                        <span class="auction-topic-copy-btns" v-if="t.hasTodayData">
                            <span class="auction-topic-copy-btn" @click="handlers.copyAll(t.topic)">全复制</span>
                            <span class="auction-topic-copy-btn" @click="handlers.copy5(t.topic)">复制5%</span>
                            <span class="auction-topic-copy-btn" @click="handlers.copy2(t.topic)">复制2%</span>
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

    // ============================================================
    // 组件：Page4 统计看板
    // ============================================================
    const StatsBoard = {
        name: 'StatsBoard',
        props: { dataSource: { type: String, default: 'auction' } },
        setup(props) {
            const ds = Vue.computed(() => tabKey(props.dataSource));
            const view = Vue.computed(() => {
                touchReactiveCtx();
                return computeAuctionStatsViewData(ds.value);
            });
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

    // ============================================================
    // 暴露全局
    // ============================================================
    window.computeAuctionViewData = computeAuctionViewData;
    window.computeAuctionPage2ViewData = computeAuctionPage2ViewData;
    window.computeAuctionPage3ViewData = computeAuctionPage3ViewData;
    window.computeAuctionStatsViewData = computeAuctionStatsViewData;
    window.AuctionBoardComponent = AuctionBoard;
    window.Page2BoardComponent = Page2Board;
    window.Page3BoardComponent = Page3Board;
    window.StatsBoardComponent = StatsBoard;
    window.StockCardComponent = StockCard;
    window.HighRatioStatComponent = HighRatioStat;
    window.LongPressDirective = LongPressDirective;

    if (typeof _dbgLog === 'function') _dbgLog('[AUCTION-COMPONENTS] 组件层已就绪');
})();
