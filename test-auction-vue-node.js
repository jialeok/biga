/**
 * 早盘竞价看板 Vue 3 JSDOM 测试
 * 运行：node test-auction-vue-node.js
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { JSDOM } = require('jsdom');

const PORT = 8765;
const ROOT = __dirname;

const server = http.createServer((req, res) => {
  const filePath = path.join(ROOT, decodeURIComponent(req.url));
  const ext = path.extname(filePath).toLowerCase();
  const contentTypeMap = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8'
  };
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404); res.end('Not found'); return;
    }
    res.writeHead(200, { 'Content-Type': contentTypeMap[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function run() {
  await new Promise(resolve => server.listen(PORT, resolve));
  const html = await new Promise((resolve, reject) => {
    http.get('http://localhost:' + PORT + '/test-auction-vue.html', res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    resources: 'usable',
    url: 'http://localhost:' + PORT + '/test-auction-vue.html'
  });

  const win = dom.window;
  const doc = win.document;

  await wait(1200);
  const errors = [];

  function assert(cond, msg) { if (!cond) errors.push(msg); }
  function textContains(el, substr) { return el && el.textContent.indexOf(substr) !== -1; }

  // 1. Vue / Store / Sandbox 函数存在
  assert(!!win.Vue, 'Vue 未加载');
  assert(!!win.auctionStore, 'auctionStore 未创建');
  assert(typeof win.mountAuctionBoardSandbox === 'function', 'mountAuctionBoardSandbox 未暴露');
  assert(typeof win.mountPage2BoardSandbox === 'function', 'mountPage2BoardSandbox 未暴露');
  assert(typeof win.mountPage3BoardSandbox === 'function', 'mountPage3BoardSandbox 未暴露');
  assert(typeof win.mountStatsBoardSandbox === 'function', 'mountStatsBoardSandbox 未暴露');

  // 2. autoMountAll 已自动挂载 page1 组件
  const auctionContent = doc.getElementById('auctionContent');
  const hotContent = doc.getElementById('hotContent');
  assert(!!auctionContent, 'auctionContent 不存在');
  assert(!!hotContent, 'hotContent 不存在');
  assert(!!auctionContent.querySelector('.auction-board-vue'), 'auctionContent 未渲染 AuctionBoard');
  assert(!!hotContent.querySelector('.auction-board-vue'), 'hotContent 未渲染 AuctionBoard');

  // 3. 早盘竞价 tab 显示正确数据
  const auctionItems = auctionContent.querySelectorAll('.auction-item');
  assert(auctionItems.length === 2, 'auctionContent 股票数量应为 2，实际 ' + auctionItems.length);
  assert(textContains(auctionContent, '测试A'), 'auctionContent 应包含 测试A');
  assert(textContains(auctionContent, '测试B'), 'auctionContent 应包含 测试B');
  assert(!textContains(auctionContent, '热门A'), 'auctionContent 不应包含 热门A');

  // 4. 后台 tab 守卫：当前未激活的热门股票 tab 不应重算/渲染数据行
  const hotItemsBeforeSwitch = hotContent.querySelectorAll('.auction-item');
  assert(hotItemsBeforeSwitch.length === 0, '未激活时 hotContent 不应渲染数据行，实际 ' + hotItemsBeforeSwitch.length);

  // 5. 切换 store.currentGroup 后内容应随数据源变化（响应式验证）
  if (win.auctionStore && win.auctionStore.actions) {
    // 强制把 auction 数据替换，验证响应式
    win.__auctionGroupData['auction']['2026-07-28'] = [
      { stock: '新股C', volume: '15000', yestVolume: '7000', ratioValue: 214, topic: '5G', starCount: 1 }
    ];
    // 触发 store 状态变化以强制重算（按数据源版本号）
    win.auctionStore.dataVersions['auction'] = (win.auctionStore.dataVersions['auction'] || 0) + 1;
    win.auctionStore.stocksDataVersion += 1;
    await wait(100);
    assert(textContains(auctionContent, '新股C'), '响应式更新后 auctionContent 应包含 新股C');
  }

  // 8. 点击序号应触发 toggleAuctionTrendPanel（在切换到 hot 之前测试）
  assert(!win.__trendPanelToggled, '初始状态不应触发趋势图展开');
  const firstNumber = auctionContent.querySelector('.auction-number');
  if (firstNumber) {
    firstNumber.click();
    await wait(50);
    assert(win.__trendPanelToggled, '点击序号未触发 toggleAuctionTrendPanel');
    assert(win.__trendPanelIndex === 0, '点击序号传入的 index 应为 0，实际 ' + win.__trendPanelIndex);
  } else {
    errors.push('auctionContent 中未找到序号元素');
  }

  // 6. Page2 / Page3 / 独立 StatsBoard 自动挂载（可能显示 placeholder）
  assert(doc.getElementById('auctionContent2').children.length > 0, 'auctionContent2 未渲染 Page2Board');
  assert(doc.getElementById('auctionContent3').children.length > 0, 'auctionContent3 未渲染 Page3Board');
  // StatsBoard 应挂载到独立的 #starStatsContent，而不是 page4 容器；page4 是“复制的题材股票”原生区域
  const statsEls = doc.querySelectorAll('#starStatsContent .stats-board, #starStatsContent .star-stats-empty');
  assert(statsEls.length > 0, '#starStatsContent 未渲染 StatsBoard');
  const leakedStatsEls = doc.querySelectorAll('#auctionContent4 .stats-board, #hotContent4 .stats-board');
  assert(leakedStatsEls.length === 0, 'StatsBoard 不应渲染到 page4 容器');

  // 6.1 标题栏强度数值与星标签统计看板甜甜圈应显示
  const strengthValueEl = doc.getElementById('auctionStrengthValue');
  const strengthArrowEl = doc.getElementById('auctionStrengthArrow');
  assert(!!strengthValueEl && strengthValueEl.textContent !== '-', '标题栏强度数值应显示，实际 ' + (strengthValueEl && strengthValueEl.textContent));
  assert(!!strengthArrowEl, '标题栏强度箭头元素应存在');
  const starStatsContent = doc.getElementById('starStatsContent');
  assert(!!starStatsContent.querySelector('.stats-board'), '星标签统计看板应渲染');
  assert(!!starStatsContent.querySelector('.star-stats-donut-svg'), '星标签统计看板应显示甜甜圈');

  // 7. 顶部竞/昨数、竞放量数统计条自动挂载
  const auctionStat = doc.getElementById('auctionHighRatioStat');
  assert(!!auctionStat && auctionStat.querySelector('.auction-highratio-stat-vue'), 'auctionHighRatioStat 未渲染 HighRatioStat');
  assert(textContains(auctionStat, '竞/昨数'), 'auctionHighRatioStat 应显示“竞/昨数”');
  assert(textContains(auctionStat, '竞放量数'), 'auctionHighRatioStat 应显示“竞放量数”');

  // 7.1 竞/昨开关打开后，所有行都应出现蓝色高光，且统计数字与高光行数一致
  win.auctionStore.sortState['auction'].byJingYest = true;
  await wait(300);
  const auctionRows = auctionContent.querySelectorAll('.auction-item');
  const auctionBlueRows = auctionContent.querySelectorAll('.auction-item.jing-yest-match');
  assert(auctionRows.length > 0, 'auctionContent 中应存在数据行');
  assert(auctionBlueRows.length === auctionRows.length, '竞/昨开启后，蓝色高光行数(' + auctionBlueRows.length + ')应等于总行数(' + auctionRows.length + ')');
  const auctionJingYestCountText = auctionStat.querySelector('#auctionJingYestCount');
  assert(!!auctionJingYestCountText, '竞/昨数元素应存在');
  assert(String(auctionJingYestCountText.textContent) === String(auctionBlueRows.length),
    '竞/昨数显示(' + auctionJingYestCountText.textContent + ')应与蓝色高光行数(' + auctionBlueRows.length + ')一致');

  // 7.2 切换到热门股票 tab 后，竞/昨数、竞放量数应同步显示且蓝色高光一致
  const hotStat = doc.getElementById('hotHighRatioStat');
  assert(!!hotStat && hotStat.querySelector('.auction-highratio-stat-vue'), 'hotHighRatioStat 未渲染 HighRatioStat');
  win.auctionStore.actions.switchGroup('hot');
  await wait(200);
  // 切换后原 auctionContent 应进入后台守卫状态
  const auctionItemsAfterSwitch = auctionContent.querySelectorAll('.auction-item');
  assert(auctionItemsAfterSwitch.length === 0, '切换到 hot 后 auctionContent 不应再渲染数据行');
  assert(textContains(hotStat, '竞/昨数'), 'hotHighRatioStat 应显示“竞/昨数”');
  assert(textContains(hotStat, '竞放量数'), 'hotHighRatioStat 应显示“竞放量数”');
  const hotJingYestCountText = hotStat.querySelector('#hotJingYestCount');
  const hotHighRatioCountText = hotStat.querySelector('#hotHighRatioCount');
  assert(!!hotJingYestCountText && hotJingYestCountText.textContent !== '-', '热门 tab 竞/昨数应为具体数字');
  assert(!!hotHighRatioCountText && hotHighRatioCountText.textContent !== '-', '热门 tab 竞放量数应为具体数字');

  // 7.2.1 搜索框与响应式搜索高亮
  const hotSearchInput = hotContent.querySelector('.auction-search-input');
  assert(!!hotSearchInput, 'hotContent 应渲染搜索输入框');
  win.auctionStore.actions.setHighlightKeyword('热门A');
  await wait(100);
  const hotHighlightedRows = hotContent.querySelectorAll('.auction-item.highlight-search');
  assert(hotHighlightedRows.length === 1, '搜索“热门A”后应只有 1 行高亮，实际 ' + hotHighlightedRows.length);
  // 切换分组应清空搜索关键词
  win.auctionStore.actions.switchGroup('auction');
  await wait(100);
  assert(win.auctionStore.highlightKeyword === '', '切换分组后搜索关键词应被清空');
  // 切回 hot 后再做后续断言
  win.auctionStore.actions.switchGroup('hot');
  await wait(100);

  win.auctionStore.sortState['hot'].byJingYest = true;
  await wait(300);
  const hotRows = hotContent.querySelectorAll('.auction-item');
  const hotBlueRows = hotContent.querySelectorAll('.auction-item.jing-yest-match');
  assert(hotRows.length > 0, 'hotContent 中应存在数据行');
  assert(hotBlueRows.length === hotRows.length, '热门 tab 竞/昨开启后，蓝色高光行数(' + hotBlueRows.length + ')应等于总行数(' + hotRows.length + ')');
  assert(String(hotJingYestCountText.textContent) === String(hotBlueRows.length),
    '热门 tab 竞/昨数显示(' + hotJingYestCountText.textContent + ')应与蓝色高光行数(' + hotBlueRows.length + ')一致');

  // 7.3 切换 tab 后标题栏强度数值与甜甜圈应跟随更新
  assert(strengthValueEl.textContent !== '-', '切换到热门 tab 后标题栏强度数值应仍显示');
  assert(!!starStatsContent.querySelector('.stats-board'), '切换到热门 tab 后星标签统计看板应仍渲染');
  assert(!!starStatsContent.querySelector('.star-stats-donut-svg'), '切换到热门 tab 后甜甜圈应仍显示');

  // 8. 全部展开状态与 store 同步
  if (win.auctionStore && win.auctionStore.actions) {
    win.auctionStore.actions.setExpandAll(true, 1);
    assert(win.auctionStore.expandAll === true, 'store.expandAll 应为 true');
    win.auctionStore.actions.setExpandAll(false, 1);
    assert(win.auctionStore.expandAll === false, 'store.expandAll 应为 false');
    win.auctionStore.actions.setExpandAll(true, 2);
    assert(win.auctionStore.expandAllP2 === true, 'store.expandAllP2 应为 true');
    win.auctionStore.actions.setExpandAll(false, 2);
    assert(win.auctionStore.expandAllP2 === false, 'store.expandAllP2 应为 false');
  }

  // 9. sandbox 函数可手动挂载到任意容器
  const manualEl = doc.createElement('div');
  manualEl.id = 'manualMount';
  doc.body.appendChild(manualEl);
  win.mountAuctionBoardSandbox('hot', 'manualMount');
  await wait(100);
  assert(!!manualEl.querySelector('.auction-board-vue'), '手动 mountAuctionBoardSandbox 未渲染');

  server.close();

  if (errors.length > 0) {
    console.error('❌ 测试失败:');
    errors.forEach(e => console.error('  - ' + e));
    process.exit(1);
  }

  console.log('✅ 早盘竞价看板 Vue 渲染与交互测试通过');
  process.exit(0);
}

run().catch(e => {
  console.error('❌ 测试异常:', e.message || e);
  try { server.close(); } catch (_) {}
  process.exit(1);
});
