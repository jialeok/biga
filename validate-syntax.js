const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
let match;
let blockIdx = 0;
let errors = [];

while ((match = scriptRe.exec(html)) !== null) {
  const attrs = match[1];
  if (/\bsrc\s*=/.test(attrs)) continue;
  const code = match[2];
  blockIdx++;
  try {
    new Function(code);
    console.log(`Script block ${blockIdx}: OK (${code.length} chars)`);
  } catch (e) {
    errors.push({ block: blockIdx, message: e.message });
    console.error(`Script block ${blockIdx}: SYNTAX ERROR: ${e.message}`);
  }
}

if (errors.length > 0) {
  console.error('\nValidation failed with ' + errors.length + ' syntax error(s)');
  process.exit(1);
} else {
  console.log('\nAll inline script blocks passed syntax check.');
  process.exit(0);
}
