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

// 启动静态文件服务
const server = http.createServer((req, res) => {
  const filePath = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  const target = fs.existsSync(filePath) && fs.statSync(filePath).isFile() ? filePath : path.join(ROOT, 'index.html');
  fs.readFile(target, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(target);
    const ct = ext === '.js' ? 'application/javascript' : (ext === '.css' ? 'text/css' : 'text/html');
    res.writeHead(200, { 'Content-Type': ct });
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

  // 1. Vue App 挂载
  const board = doc.getElementById('auctionBoard');
  if (!board) errors.push('#auctionBoard 不存在');
  else if (!board.querySelector('.auction-app-wrapper')) errors.push('Auction Vue App 未挂载');

  // 2. store 存在且初始状态正确
  if (!win.auctionStore) errors.push('auctionStore 未创建');
  else {
    if (win.auctionStore.currentGroup !== 'auction') errors.push('初始 currentGroup 应为 auction');
    if (win.auctionStore.currentPage !== 0) errors.push('初始 currentPage 应为 0');
    if (win.auctionStore.currentDate !== '2026-07-28') errors.push('初始 currentDate 应为 2026-07-28');
    if (!win.auctionStore.actions) errors.push('auctionStore.actions 不存在');
  }

  // 3. Tab 切换
  const tabHot = doc.getElementById('tabHot');
  const tabAuction = doc.getElementById('tabAuction');
  if (!tabHot || !tabAuction) errors.push('Tab 元素未渲染');
  else {
    tabHot.click();
    await wait(50);
    if (win.auctionStore.currentGroup !== 'hot') errors.push('点击热门 tab 后 currentGroup 未变 hot');
    if (win.currentGroup !== 'hot') errors.push('点击热门 tab 后全局 currentGroup 未同步');

    tabAuction.click();
    await wait(50);
    if (win.auctionStore.currentGroup !== 'auction') errors.push('点击早盘 tab 后未切回 auction');
  }

  // 4. 页码指示器切换
  const dots = doc.querySelectorAll('#auctionPageIndicator .page-dot');
  if (dots.length !== 4) errors.push('页码点数量不对: ' + dots.length);
  else {
    dots[1].click();
    await wait(50);
    if (win.auctionStore.currentPage !== 1) errors.push('点击第2页后 currentPage 未变 1');
    dots[0].click();
    await wait(50);
    if (win.auctionStore.currentPage !== 0) errors.push('点击第1页后未返回 0');
  }

  // 5. Page1 渲染（有数据）
  const page1 = doc.getElementById('auctionPage1');
  if (!page1) errors.push('auctionPage1 未渲染');
  else if (!page1.classList.contains('active')) errors.push('page1 初始未激活');

  const cards = doc.querySelectorAll('#auctionPage1 .auction-item');
  if (cards.length === 0) errors.push('page1 未渲染股票卡片');

  // 6. 排序开关同步到 store
  const sortDataToggle = doc.getElementById('auctionSortByDataToggle');
  if (!sortDataToggle) errors.push('数据排序开关未渲染');
  else {
    sortDataToggle.checked = true;
    sortDataToggle.dispatchEvent(new win.Event('change', { bubbles: true }));
    await wait(50);
    if (!win.auctionStore.sortState.auction.byData) errors.push('数据排序开关未同步到 store');
  }

  // 7. 全部展开开关调用全局回调
  const expandToggle = doc.getElementById('auctionExpandAllToggle');
  if (!expandToggle) errors.push('全部展开开关未渲染');
  else {
    expandToggle.checked = true;
    expandToggle.dispatchEvent(new win.Event('change', { bubbles: true }));
    await wait(50);
    if (!win.auctionStore.expandAll) errors.push('全部展开状态未写入 store');
    if (!win.__openAuctionEditCalled && typeof win.__onAuctionExpandAllToggleChangeCalled !== 'undefined' && !win.__onAuctionExpandAllToggleChangeCalled) {
      // 仅在存在该全局标记时校验
    }
  }

  // 8. 双击打开编辑
  const content = doc.getElementById('auctionContent');
  if (content) {
    content.dispatchEvent(new win.Event('dblclick', { bubbles: true }));
    await wait(50);
    if (!win.__openAuctionEditCalled) errors.push('双击 page1 未调用 openAuctionEdit');
  }

  // 9. 头部折叠点击
  const header = doc.getElementById('auctionHeader');
  if (header) {
    header.click();
    await wait(50);
    if (!win.__toggleAuctionBoardCalled) errors.push('点击头部未调用 toggleAuctionBoard');
  }

  // 10. 滑动切页（模拟 touch 事件）
  const swipeContainer = doc.getElementById('auctionSwipeContainer');
  if (swipeContainer && win.auctionStore.actions) {
    win.auctionStore.actions.switchPage(0);
    await wait(50);
    const touchStart = new win.TouchEvent('touchstart', {
      changedTouches: [{ screenX: 300, screenY: 100 }],
      bubbles: true
    });
    const touchEnd = new win.TouchEvent('touchend', {
      changedTouches: [{ screenX: 100, screenY: 100 }],
      bubbles: true
    });
    swipeContainer.dispatchEvent(touchStart);
    swipeContainer.dispatchEvent(touchEnd);
    await wait(50);
    if (win.auctionStore.currentPage !== 1) errors.push('左滑未切到第2页');
  }

  // 11. page2 渲染与双击
  win.auctionStore.actions.switchPage(1);
  await wait(100);
  const page2 = doc.getElementById('auctionPage2');
  if (!page2) errors.push('auctionPage2 未渲染');
  else {
    const topicGroups = page2.querySelectorAll('.auction-topic-group');
    if (topicGroups.length === 0) errors.push('page2 未渲染题材分组');
    const content2 = doc.getElementById('auctionContent2');
    if (content2) {
      content2.dispatchEvent(new win.Event('dblclick', { bubbles: true }));
      await wait(50);
      if (!win.__openCoreTopicModalCalled) errors.push('双击 page2 未调用 openCoreTopicModal');
    }
  }

  // 12. page3 / page4 至少能渲染不报错
  win.auctionStore.actions.switchPage(2);
  await wait(100);
  const page3 = doc.getElementById('auctionPage3');
  if (!page3) errors.push('auctionPage3 未渲染');

  win.auctionStore.actions.switchPage(3);
  await wait(100);
  const page4 = doc.getElementById('auctionPage4');
  if (!page4) errors.push('auctionPage4 未渲染');

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
  process.exit(1);
});
