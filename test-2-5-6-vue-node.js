/**
 * 2/5/6 看板 Vue 化 JSDOM 测试
 * 运行：node test-2-5-6-vue-node.js
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, 'test-2-5-6-vue.html'), 'utf8');

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  resources: 'usable',
  url: 'file://' + __dirname + '/'
});

const win = dom.window;
const doc = win.document;

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function run() {
  await wait(800);

  const errors = [];

  // 1. rank 看板渲染
  const rankItems = doc.querySelectorAll('.rank-board .rank-item');
  if (rankItems.length !== 2) errors.push('rank 渲染行数不对: ' + rankItems.length);
  const rankFirstName = doc.querySelector('.rank-board .rank-item .rank-stock-name');
  if (!rankFirstName || rankFirstName.textContent !== '测试A') errors.push('rank 第一行名称不对');

  // 2. 打开 rank 编辑弹窗
  const rankContent = doc.querySelector('.rank-board .rank-content');
  rankContent.dispatchEvent(new win.Event('dblclick', { bubbles: true }));
  await wait(50);
  const rankModal = doc.querySelector('.rank-vue-modal-backdrop');
  if (!rankModal) errors.push('rank 编辑弹窗未打开');

  // 3. 添加一行并保存
  if (rankModal) {
    const addBtns = rankModal.querySelectorAll('.rank-vue-add-btn');
    const addBtn = addBtns[addBtns.length - 1];
    addBtn.click();
    await wait(50);
    const inputs = rankModal.querySelectorAll('.rank-vue-form-row input.rank-vue-form-stock');
    const lastInput = inputs[inputs.length - 1];
    lastInput.value = '测试C';
    lastInput.dispatchEvent(new win.Event('input', { bubbles: true }));
    await wait(50);
    const saveBtn = rankModal.querySelector('.rank-vue-save-btn');
    saveBtn.click();
    await wait(100);
  }

  // 验证保存后 rank 多了一行
  const rankItemsAfter = doc.querySelectorAll('.rank-board .rank-item');
  if (rankItemsAfter.length !== 3) errors.push('rank 保存后行数不对: ' + rankItemsAfter.length);
  if (!win.__rankSaved || !win.__rankSaved['2026-07-28'] || win.__rankSaved['2026-07-28'].length !== 3) {
    errors.push('rank 保存后 saveData 数据不对');
  }

  // 4. duiban / etf 看板渲染
  const duibanVueRoot = doc.querySelector('#duiban-vue-root');
  const etfVueRoot = doc.querySelector('#etf-vue-root');
  if (!duibanVueRoot) errors.push('duiban Vue 根节点未挂载');
  if (!etfVueRoot) errors.push('etf Vue 根节点未挂载');

  // 5. 验证 dashboards.js 覆盖了原函数
  if (typeof win.getTodayDuiban !== 'function') errors.push('getTodayDuiban 未定义');
  if (typeof win.getEtfData !== 'function') errors.push('getEtfData 未定义');
  if (typeof win.renderRank !== 'function') errors.push('renderRank 未定义');

  if (errors.length > 0) {
    console.error('❌ 测试失败:');
    errors.forEach(e => console.error('  - ' + e));
    process.exit(1);
  }

  console.log('✅ 2/5/6 看板 Vue 渲染与编辑测试通过');
  process.exit(0);
}

run().catch(e => {
  console.error('❌ 测试异常:', e.message || e);
  process.exit(1);
});
