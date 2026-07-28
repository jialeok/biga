const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'test-boards-vue.html'), 'utf8');
const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  resources: 'usable',
  url: 'file://' + __dirname + '/'
});
const win = dom.window;

function assert(cond, msg) {
  if (!cond) {
    console.error('ASSERT FAIL:', msg);
    process.exit(1);
  }
}

function sleep(ms) {
  return new Promise(resolve => win.setTimeout(resolve, ms));
}

(async function run() {
  await sleep(200);

  const doc = win.document;

  // 1. stocks list
  const cards = doc.querySelectorAll('#stockList .stock-card');
  assert(cards.length === 1, 'stocks card count expected 1, got ' + cards.length);
  assert(cards[0].textContent.includes('测试股A'), 'stock name missing');
  assert(cards[0].textContent.includes('竞价开盘'), 'stock body missing');

  // 2. hotspot display
  const hotspotContent = doc.querySelector('#hotspotBoard .hotspot-content');
  assert(hotspotContent, 'hotspot content missing');
  hotspotContent.click();
  await sleep(50);

  const hotspotTextarea = doc.querySelector('#hotspotBoard .vue-edit-modal textarea');
  assert(hotspotTextarea, 'hotspot edit modal not opened');
  hotspotTextarea.value = '新的题材思路';
  hotspotTextarea.dispatchEvent(new win.Event('input', { bubbles: true }));
  const hotspotSave = doc.querySelector('#hotspotBoard .vue-edit-save');
  assert(hotspotSave, 'hotspot save button missing');
  hotspotSave.click();
  await sleep(50);

  const hotspotContentAfter = doc.querySelector('#hotspotBoard .hotspot-content');
  assert(hotspotContentAfter.textContent.includes('新的题材思路'), 'hotspot save failed: ' + hotspotContentAfter.textContent);

  // 3. pattern expand + edit
  const patternHeader = doc.querySelector('#patternBoard .pattern-header');
  assert(patternHeader, 'pattern header missing');
  patternHeader.click();
  await sleep(50);

  const patternContent = doc.querySelector('#patternBoard .pattern-content');
  assert(patternContent, 'pattern content missing after expand');
  patternContent.click();
  await sleep(50);

  const patternTextarea = doc.querySelector('#patternBoard .vue-edit-modal textarea');
  assert(patternTextarea, 'pattern edit modal not opened');
  patternTextarea.value = '新的模式心得';
  patternTextarea.dispatchEvent(new win.Event('input', { bubbles: true }));
  const patternSave = doc.querySelector('#patternBoard .vue-edit-save');
  assert(patternSave, 'pattern save button missing');
  patternSave.click();
  await sleep(50);

  const patternContentAfter = doc.querySelector('#patternBoard .pattern-content');
  assert(patternContentAfter.textContent.includes('新的模式心得'), 'pattern save failed: ' + patternContentAfter.textContent);

  console.log('✅ boards-vue 渲染与编辑测试通过');
  win.close();
  process.exit(0);
})();
