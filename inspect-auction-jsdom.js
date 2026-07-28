const fs = require('fs');
const path = require('path');
const http = require('http');
const { JSDOM } = require('jsdom');

const PORT = 8766;
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

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

async function run() {
  await new Promise(r => server.listen(PORT, r));
  const html = await new Promise((resolve, reject) => {
    http.get('http://localhost:' + PORT + '/index.html', res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
    }).on('error', reject);
  });

  const errors = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    resources: 'usable',
    url: 'http://localhost:' + PORT + '/index.html'
  });
  const win = dom.window;

  win.addEventListener('error', e => errors.push('window error: ' + (e.message || e)));
  win.console.error = (...args) => errors.push('console.error: ' + args.join(' '));
  win.console.warn = (...args) => errors.push('console.warn: ' + args.join(' '));

  await wait(5000);

  const doc = win.document;
  const board = doc.getElementById('auctionBoard');
  console.log('board exists:', !!board);
  console.log('board class:', board ? board.className : 'N/A');
  console.log('board innerHTML length:', board ? board.innerHTML.length : 0);
  console.log('board innerHTML first 1500:', board ? board.innerHTML.slice(0, 1500) : 'N/A');

  console.log('auctionHeader exists:', !!doc.getElementById('auctionHeader'));
  console.log('auctionSwipeContainer exists:', !!doc.getElementById('auctionSwipeContainer'));
  console.log('auctionPage1 exists:', !!doc.getElementById('auctionPage1'));

  const items = doc.querySelectorAll('#auctionPage1 .auction-item');
  console.log('auctionPage1 items count:', items.length);

  console.log('auctionStore exists:', !!win.auctionStore);
  if (win.auctionStore) {
    console.log('store.currentDate:', win.auctionStore.currentDate);
    console.log('store.currentGroup:', win.auctionStore.currentGroup);
    console.log('store.currentPage:', win.auctionStore.currentPage);
  }

  console.log('Vue exists:', !!win.Vue);
  console.log('AuctionAppComponent exists:', !!win.AuctionAppComponent);
  console.log('mountAuctionBoardApp exists:', typeof win.mountAuctionBoardApp);

  const header = doc.getElementById('auctionHeader');
  if (header) {
    header.click();
    await wait(500);
    console.log('after click board class:', board ? board.className : 'N/A');
  }

  if (errors.length) {
    console.log('ERRORS:');
    errors.forEach(e => console.log('  ', e));
  }

  server.close();
  process.exit(0);
}

run().catch(e => { console.error(e); server.close(); process.exit(1); });
