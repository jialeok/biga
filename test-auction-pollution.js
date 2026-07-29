const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

// 提取第二个内联 script 块（业务逻辑主体）
const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
let match;
let blockIdx = 0;
let code = '';
while ((match = scriptRe.exec(html)) !== null) {
  const attrs = match[1];
  if (/\bsrc\s*=/.test(attrs)) continue;
  blockIdx++;
  if (blockIdx === 2) { code = match[2]; break; }
}

let errors = [];

// 辅助：提取函数体（假设函数以 `function name(...) {` 开头，且第一个匹配的 `}` 结束）
function getFunctionBody(funcName, paramPattern = '[^)]*') {
  const re = new RegExp('function\\s+' + funcName + '\\s*\\(' + paramPattern + '\\)\\s*\\{([\\s\\S]*?)\\n\\s*\\}\\s*\\n\\s*function\\s+');
  const m = code.match(re);
  return m ? m[1] : '';
}

// 1. getTodayAuction / getTodayGroupList 不再把 undefined 就地修复为 true
const getTodayAuctionBody = getFunctionBody('getTodayAuction');
if (getTodayAuctionBody && /r\.in_watchlist\s*=\s*true;/.test(getTodayAuctionBody)) {
  errors.push('getTodayAuction 仍在就地修改 in_watchlist=true');
}
const getTodayGroupListBody = getFunctionBody('getTodayGroupList', "\\s*dataSource\\s*=\\s*['\"]auction['\"]\\s*");
if (getTodayGroupListBody && /r\.in_watchlist\s*=\s*true;/.test(getTodayGroupListBody)) {
  errors.push('getTodayGroupList 仍在就地修改 in_watchlist=true');
}

// 2. setAuctionDateData 对缺失 in_watchlist 的行默认置 false（防止污染）
const setAuctionMatch = code.match(/function setAuctionDateData\s*\([^)]*\)\s*\{([\s\S]*?)\n\s*\}\s*\n\s*function clearAuctionDateData/);
if (!setAuctionMatch) {
  errors.push('找不到 setAuctionDateData 函数');
} else {
  const setFn = setAuctionMatch[1];
  if (!/in_watchlist\s*===\s*undefined/.test(setFn) || !/in_watchlist:\s*false/.test(setFn)) {
    errors.push('setAuctionDateData 未对缺失 in_watchlist 的行默认置 false');
  }
}

// 3. mergeAuctionDateRows 在合并缺失 in_watchlist 的行时保留旧值或默认 false
const mergeMatch = code.match(/function mergeAuctionDateRows\s*\([^)]*\)\s*\{([\s\S]*?)\n\s*\}\s*\n\s*function clearAllAuctionDates/);
if (!mergeMatch) {
  errors.push('找不到 mergeAuctionDateRows 函数');
} else {
  const mergeFn = mergeMatch[1];
  if (!/in_watchlist\s*===\s*undefined/.test(mergeFn)) {
    errors.push('mergeAuctionDateRows 未处理缺失 in_watchlist 的合并行');
  }
}

// 4. 主要创建路径显式设置 in_watchlist: true
const requiredCreationPatterns = [
  { name: 'importAuctionFromPaste 全数据新股票', regex: /auctionList\.push\(\{\s*\.\.\.dataItem,[\s\S]*?in_watchlist:\s*true\s*\}\);/ },
  { name: 'importAuctionFromPaste 注释新股票', regex: /auctionList\.push\(\{\s*stock:\s*noteItem\.stock,[\s\S]*?in_watchlist:\s*true\s*\}\);/ },
  { name: 'importAuctionHistoryFill 新记录', regex: /targetList\.push\(\{\s*stock,\s*volume:\s*'',[\s\S]*?in_watchlist:\s*true\s*\}\);/ },
  { name: 'importAuctionCodeMap 新股票', regex: /newRows\.push\(\{\s*stock:\s*name,[\s\S]*?in_watchlist:\s*true\s*\}\);/ },
  { name: 'saveAuction 表单保存', regex: /auctionList\.push\(\{\s*stock,[\s\S]*?in_watchlist:\s*true,[\s\S]*?\}\);/ },
  { name: 'ensureObservationStocks 观察组继承', regex: /dayList\.push\(\{\s*stock:\s*name,[\s\S]*?in_watchlist:\s*true,[\s\S]*?obsAutoAdded:\s*true\s*\}\);/ },
  { name: 'ensureBoughtStocksForDate 买入继承', regex: /dayList\.push\(\{\s*stock:\s*name,[\s\S]*?in_watchlist:\s*true,[\s\S]*?obsAutoAdded:\s*true\s*\}\);/ },
];

requiredCreationPatterns.forEach(function(p) {
  if (!p.regex.test(code)) {
    errors.push('创建路径缺少 in_watchlist=true：' + p.name);
  }
});

if (errors.length > 0) {
  console.error('Auction pollution tests failed:');
  errors.forEach(e => console.error('  - ' + e));
  process.exit(1);
} else {
  console.log('Auction pollution tests passed.');
  process.exit(0);
}
