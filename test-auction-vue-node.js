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

  // 4. 热门股票 tab 显示正确数据
  const hotItems = hotContent.querySelectorAll('.auction-item');
  assert(hotItems.length === 2, 'hotContent 股票数量应为 2，实际 ' + hotItems.length);
  assert(textContains(hotContent, '热门A'), 'hotContent 应包含 热门A');
  assert(textContains(hotContent, '热门B'), 'hotContent 应包含 热门B');
  assert(!textContains(hotContent, '测试A'), 'hotContent 不应包含 测试A');

  // 5. 切换 store.currentGroup 后内容应随数据源变化（响应式验证）
  if (win.auctionStore && win.auctionStore.actions) {
    // 强制把 auction 数据替换，验证响应式
    win.__auctionGroupData['auction']['2026-07-28'] = [
      { stock: '新股C', volume: '15000', yestVolume: '7000', ratioValue: 214, topic: '5G', starCount: 1 }
    ];
    // 触发 store 状态变化以强制重算
    win.auctionStore.stocksDataVersion += 1;
    await wait(100);
    assert(textContains(auctionContent, '新股C'), '响应式更新后 auctionContent 应包含 新股C');
  }

  // 6. Page2 / Page3 / 独立 StatsBoard 自动挂载（可能显示 placeholder）
  assert(doc.getElementById('auctionContent2').children.length > 0, 'auctionContent2 未渲染 Page2Board');
  assert(doc.getElementById('auctionContent3').children.length > 0, 'auctionContent3 未渲染 Page3Board');
  // StatsBoard 应挂载到独立的 #starStatsContent，而不是 page4 容器；page4 是“复制的题材股票”原生区域
  const statsEls = doc.querySelectorAll('#starStatsContent .stats-board, #starStatsContent .star-stats-empty');
  assert(statsEls.length > 0, '#starStatsContent 未渲染 StatsBoard');
  const leakedStatsEls = doc.querySelectorAll('#auctionContent4 .stats-board, #hotContent4 .stats-board');
  assert(leakedStatsEls.length === 0, 'StatsBoard 不应渲染到 page4 容器');

  // 7. 顶部竞/昨数、竞放量数统计条自动挂载
  const auctionStat = doc.getElementById('auctionHighRatioStat');
  assert(!!auctionStat && auctionStat.querySelector('.auction-highratio-stat'), 'auctionHighRatioStat 未渲染 HighRatioStat');
  assert(textContains(auctionStat, '竞/昨数'), 'auctionHighRatioStat 应显示“竞/昨数”');
  assert(textContains(auctionStat, '竞放量数'), 'auctionHighRatioStat 应显示“竞放量数”');

  // 8. 点击序号应触发 toggleAuctionTrendPanel
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
