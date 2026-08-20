const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const frontendDir = path.join(__dirname, '..');
const appSource = fs.readFileSync(path.join(frontendDir, 'app.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(frontendDir, 'index.html'), 'utf8');

test('frontend exposes only the canonical live risk consumer', () => {
  assert.equal(appSource.includes('/api/risk'), false);
  assert.equal(appSource.includes('fetchRisk'), false);
  assert.match(appSource, /fetchAdvanceRisk/);
  assert.match(appSource, /\/api\/advance-risk/);
});

test('frontend keeps Advance Risk and removes the standalone Risk Engine panel', () => {
  assert.equal(htmlSource.includes('id="panelRisk"'), false);
  assert.equal(htmlSource.includes('panel-title">Risk Engine'), false);
  assert.match(htmlSource, /id="panelAdvanceRisk"/);
  assert.match(htmlSource, /panel-title">Advance Risk/);
});
