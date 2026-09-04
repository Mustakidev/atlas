const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

test('frontend polls the public readiness endpoint and renders non-ready states', () => {
  assert.match(appSource, /fetch\(API \+ '\/readyz'/);
  assert.match(appSource, /function readinessLabel\(state\)/);
  assert.match(appSource, /UNINITIALIZED/);
  assert.match(appSource, /UNSAFE/);
  assert.match(appSource, /liveReadiness === 'READY'/);
});

test('readiness polling is started before protected dashboard refreshes', () => {
  assert.match(appSource, /function startPolling\(\)[\s\S]*fetchReadiness\(\);[\s\S]*fetchMarket\(\);/);
  assert.match(appSource, /setInterval\(function\(\) \{[\s\S]*fetchReadiness\(\);/);
});
