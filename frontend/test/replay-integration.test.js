const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const frontendDir = path.join(__dirname, '..');
const appSource = fs.readFileSync(path.join(frontendDir, 'app.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(frontendDir, 'index.html'), 'utf8');
const requestSource = fs.readFileSync(path.join(frontendDir, 'replayRequest.js'), 'utf8');
const replaySection = appSource.slice(appSource.indexOf('// Strategy Replay'));
const runReplaySource = replaySection.slice(replaySection.indexOf('window.runReplay'));

test('loads canonical replay globals before app.js', () => {
  const requestScript = htmlSource.indexOf('<script src="replayRequest.js"></script>');
  const presentationScript = htmlSource.indexOf('<script src="replayPresentation.js"></script>');
  const appScript = htmlSource.indexOf('<script src="app.js"></script>');

  assert.ok(requestScript >= 0);
  assert.ok(presentationScript > requestScript);
  assert.ok(appScript > presentationScript);
});

test('production replay uses both canonical globals and the V2 helper', () => {
  assert.match(runReplaySource, /window\.AtlasReplayRequest\.buildUrl/);
  assert.match(runReplaySource, /window\.AtlasReplayPresentation\.presentCanonicalReplay/);
  assert.match(requestSource, /\/api\/strategy\/replay\/v2/);
  assert.match(runReplaySource, /fetch\(replayUrl, \{ headers: authHeaders\(\) \}\)/);
});

test('calls Date.now exactly once for each replay request construction', () => {
  assert.equal((runReplaySource.match(/Date\.now\(\)/g) || []).length, 1);
  assert.match(runReplaySource, /var nowMs = Date\.now\(\);[\s\S]*buildUrl\(API, nowMs\)/);
});

test('contains no legacy replay request or fallback in production runtime', () => {
  assert.equal(appSource.includes('/api/strategy/replay?timeframe=1h&days=30'), false);
  assert.equal(runReplaySource.includes('/api/strategy/replay'), false);
  assert.equal(runReplaySource.includes('fetch(') && runReplaySource.includes('legacy'), false);
});

test('keeps legacy response fields out of the replay runtime and uses safe DOM rendering', () => {
  for (const field of [
    'candlesAnalyzed',
    'calculationTime',
    'rejections',
    'totalRejections',
    'averageR',
    'rMultiple',
    'trade.win',
  ]) {
    assert.equal(runReplaySource.includes(field), false, field);
  }
  assert.equal(replaySection.includes('.innerHTML'), false);
  assert.match(replaySection, /textContent/);
  assert.match(replaySection, /createElement/);
});
