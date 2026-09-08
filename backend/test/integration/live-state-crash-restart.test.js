const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createAtomicJsonStateStore } = require('../../src/state/atomicJsonStateStore');
const { createLiveStateCommitCoordinator } = require('../../src/state/liveStateCommitCoordinator');
const { createLiveExecutionStateAggregate } = require('../../src/state/liveExecutionStateAggregate');
const { createConfigFingerprint } = require('../../src/state/liveExecutionStateSchema');
const { AdvanceRiskEngine } = require('../../src/engine/advanceRisk');
const { PaperTradingEngine } = require('../../src/engine/paperTrading');
const { API_KEY, createLiveProcess } = require('../helpers/live-process');

const logger = { info() {}, warn() {}, error() {}, system() {} };
const NOW = Date.parse('2024-01-02T00:00:00.000Z');
const configFingerprint = createConfigFingerprint({
  symbol: 'BTCUSDT',
  paperTrading: { initialBalance: 10000, maxTrades: 500, fallbackRiskPerTradePct: 1 },
  confluence: { bullishThreshold: 65, bearishThreshold: 35 },
  advanceRisk: {
    riskPerTradePct: 1, atrMultTrending: 2, atrMultRanging: 1.5, rrTrending: 3, rrRanging: 1.8,
    maxDailyLossPct: 5, maxDailyDrawdownPct: 10, maxConsecutiveLosses: 3, cooldownMs: 3600000,
    sessionMultipliers: { ASIAN: 1, LONDON: 1, NEW_YORK: 1 }, minConfidence: 30, maxVolatilityPct: 5,
  },
  executionPipeline: { signalCooldownMs: 60000 },
  mtf: { aggressive: false },
});

const DEFAULT_RUNTIME_LOG_PATH = path.resolve(__dirname, '../../runtime-data/logs/atlas-events.jsonl');

function readState(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readAuditEvents(filePath) {
  return fs.readFileSync(filePath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line).event);
}

test('live-process children isolate audit paths and preserve restart continuity', async () => {
  const ambientPath = process.env.ATLAS_LOG_FILE_PATH;
  const first = await createLiveProcess();
  const second = await createLiveProcess();
  const explicit = await createLiveProcess();
  const explicitPath = path.join(explicit.stateDirectory, 'explicit-events.jsonl');
  try {
    assert.notEqual(first.logPath, DEFAULT_RUNTIME_LOG_PATH);
    assert.notEqual(second.logPath, DEFAULT_RUNTIME_LOG_PATH);
    assert.notEqual(first.logPath, second.logPath);

    await Promise.all([
      first.start({ marketMode: 'idle' }),
      second.start({ marketMode: 'idle' }),
      explicit.start({ marketMode: 'idle', extraEnv: { ATLAS_LOG_FILE_PATH: explicitPath } }),
    ]);
    assert.equal(explicit.logPath, explicitPath);
    assert.equal(fs.existsSync(first.logPath), true);
    assert.equal(fs.existsSync(second.logPath), true);
    assert.equal(fs.existsSync(explicitPath), true);
    assert.ok(readAuditEvents(first.logPath).includes('ATLAS_STARTING'));
    assert.ok(readAuditEvents(second.logPath).includes('ATLAS_STARTING'));
    assert.ok(readAuditEvents(explicitPath).includes('ATLAS_STARTING'));

    const restartPath = first.logPath;
    await first.stopGracefully();
    await first.start({ marketMode: 'idle' });
    assert.equal(first.logPath, restartPath);
    assert.ok(readAuditEvents(first.logPath).filter(event => event === 'ATLAS_STARTING').length >= 2);
  } finally {
    await Promise.all([first.dispose(), second.dispose(), explicit.dispose()]);
    assert.equal(process.env.ATLAS_LOG_FILE_PATH, ambientPath);
  }
});

async function createCertifiedOpenState() {
  const processHarness = await createLiveProcess();
  await processHarness.start({ marketMode: 'open' });
  await processHarness.waitForLiveState('UNINITIALIZED');
  const initialize = await processHarness.request('/api/live-state/initialize', {
    method: 'POST',
    headers: { 'x-api-key': API_KEY },
    body: {},
  });
  assert.equal(initialize.statusCode, 201);
  await processHarness.waitForReady();
  const state = await processHarness.waitForState(candidate => candidate.mutationSequence === 1);
  assert.equal(state.mutationSequence, 1);
  assert.equal(state.paperTrading.trades[0].tradeId, 'PT-1');
  await processHarness.stopGracefully();
  return { processHarness, state };
}

test('C1 certified durable state survives a real clean restart exactly', async () => {
  const processHarness = await createLiveProcess();
  try {
    await processHarness.start({ marketMode: 'open' });
    await processHarness.waitForLiveState('UNINITIALIZED');

    const initialize = await processHarness.request('/api/live-state/initialize', {
      method: 'POST',
      headers: { 'x-api-key': API_KEY },
      body: {},
    });
    assert.deepEqual(initialize.body, { status: 'READY', mutationSequence: 0 });
    await processHarness.waitForReady();
    const certified = await processHarness.waitForState(candidate => candidate.mutationSequence === 1);
    assert.equal(certified.mutationSequence, 1);
    assert.equal(certified.paperTrading.trades[0].tradeId, 'PT-1');
    assert.equal(certified.executionPipeline.riskSyncFailure, false);

    assert.equal(await processHarness.stopGracefully(), 0);
    await processHarness.start({ marketMode: 'idle' });
    await processHarness.waitForReady();
    assert.deepEqual(readState(processHarness.statePath), certified);
  } finally {
    await processHarness.dispose();
  }
});

test('C2 abrupt idle process death restores the last certified snapshot', async () => {
  const processHarness = await createLiveProcess();
  try {
    await processHarness.start({ marketMode: 'open' });
    await processHarness.waitForLiveState('UNINITIALIZED');
    await processHarness.request('/api/live-state/initialize', {
      method: 'POST', headers: { 'x-api-key': API_KEY }, body: {},
    });
    await processHarness.waitForReady();
    const certified = await processHarness.waitForState(candidate => candidate.mutationSequence === 1);
    assert.equal(certified.mutationSequence, 1);

    await processHarness.killAbruptly();
    await processHarness.start({ marketMode: 'idle' });
    await processHarness.waitForReady();
    assert.deepEqual(readState(processHarness.statePath), certified);
  } finally {
    await processHarness.dispose();
  }
});

test('C4 abrupt death after RAM mutation before write restores the old snapshot', async () => {
  const { processHarness: seedHarness, state: certified } = await createCertifiedOpenState();
  try {
    await seedHarness.start({ mode: 'before-write', marketMode: 'idle' });
    await seedHarness.waitForReady();
    const close = seedHarness.request('/api/paper-trades/close', {
      method: 'POST',
      headers: { 'x-api-key': API_KEY },
      body: { tradeId: 'PT-1' },
    }).catch(() => null);
    await seedHarness.waitForBarrier(seedHarness.markerPath);
    await seedHarness.killAbruptly();
    await close.catch(() => {});

    await seedHarness.start({ marketMode: 'idle' });
    await seedHarness.waitForReady();
    assert.deepEqual(readState(seedHarness.statePath), certified);
  } finally {
    await seedHarness.dispose();
  }
});

test('C8 certified write survives abrupt death before the HTTP response', async () => {
  const processHarness = await createLiveProcess();
  try {
    await processHarness.start({ marketMode: 'open' });
    await processHarness.waitForLiveState('UNINITIALIZED');
    await processHarness.request('/api/live-state/initialize', {
      method: 'POST', headers: { 'x-api-key': API_KEY }, body: {},
    });
    await processHarness.waitForReady();
    await processHarness.waitForState(candidate => candidate.mutationSequence === 1);
    await processHarness.stopGracefully();

    await processHarness.start({ mode: 'after-commit', marketMode: 'idle' });
    await processHarness.waitForReady();
    const response = processHarness.request('/api/paper-trades/close', {
      method: 'POST',
      headers: { 'x-api-key': API_KEY },
      body: { tradeId: 'PT-1' },
    }).catch(() => null);
    await processHarness.waitForBarrier(processHarness.markerPath);
    const certified = readState(processHarness.statePath);
    assert.equal(certified.mutationSequence, 2);
    assert.equal(certified.paperTrading.closedTrades[0].tradeId, 'PT-1');
    await processHarness.killAbruptly();
    await response;

    await processHarness.start({ marketMode: 'idle' });
    await processHarness.waitForReady();
    assert.deepEqual(readState(processHarness.statePath), certified);
  } finally {
    await processHarness.dispose();
  }
});

test('SIGTERM drains an active durable commit before graceful exit', async () => {
  const { processHarness, state: before } = await createCertifiedOpenState();
  try {
    await processHarness.start({ mode: 'deferred-write', marketMode: 'idle' });
    await processHarness.waitForReady();
    const response = processHarness.request('/api/paper-trades/close', {
      method: 'POST',
      headers: { 'x-api-key': API_KEY },
      body: { tradeId: 'PT-1' },
    }).catch(() => null);
    await processHarness.waitForBarrier(processHarness.markerPath);
    assert.equal(readState(processHarness.statePath).mutationSequence, before.mutationSequence);
    processHarness.child.kill('SIGTERM');
    await processHarness.releaseBarrier(processHarness.markerPath);
    assert.equal(await processHarness.waitForExit(), 0);
    await response;
    const committed = readState(processHarness.statePath);
    assert.equal(committed.mutationSequence, before.mutationSequence + 1);
    assert.equal(committed.paperTrading.closedTrades[0].tradeId, 'PT-1');

    await processHarness.start({ marketMode: 'idle' });
    await processHarness.waitForReady();
    assert.deepEqual(readState(processHarness.statePath), committed);
  } finally {
    await processHarness.dispose();
  }
});

test('I1 first-run death before initialization write remains uninitialized', async () => {
  const processHarness = await createLiveProcess();
  try {
    await processHarness.start({ mode: 'before-write', marketMode: 'idle' });
    await processHarness.waitForLiveState('UNINITIALIZED');
    const initialize = processHarness.request('/api/live-state/initialize', {
      method: 'POST', headers: { 'x-api-key': API_KEY }, body: {},
    }).catch(() => null);
    await processHarness.waitForBarrier(processHarness.markerPath);
    await processHarness.killAbruptly();
    await initialize;
    assert.equal(fs.existsSync(processHarness.statePath), false);

    await processHarness.start({ marketMode: 'idle' });
    await processHarness.waitForLiveState('UNINITIALIZED');
    assert.equal(fs.existsSync(processHarness.statePath), false);
  } finally {
    await processHarness.dispose();
  }
});

test('I3 certified sequence-zero initialization restores without second initialization', async () => {
  const processHarness = await createLiveProcess();
  try {
    await processHarness.start({ mode: 'init-after-write', marketMode: 'idle' });
    await processHarness.waitForLiveState('UNINITIALIZED');
    const initialize = processHarness.request('/api/live-state/initialize', {
      method: 'POST', headers: { 'x-api-key': API_KEY }, body: {},
    }).catch(() => null);
    await processHarness.waitForBarrier(processHarness.markerPath);
    const sequenceZero = readState(processHarness.statePath);
    assert.equal(sequenceZero.mutationSequence, 0);
    await processHarness.killAbruptly();
    await initialize;

    await processHarness.start({ marketMode: 'idle' });
    await processHarness.waitForReady();
    assert.deepEqual(readState(processHarness.statePath), sequenceZero);
    const second = await processHarness.request('/api/live-state/initialize', {
      method: 'POST', headers: { 'x-api-key': API_KEY }, body: {},
    });
    assert.equal(second.statusCode, 409);
  } finally {
    await processHarness.dispose();
  }
});

test('corrupt primary fails closed without auto-initialization or overwrite', async () => {
  const processHarness = await createLiveProcess();
  try {
    await processHarness.start({ marketMode: 'idle' });
    await processHarness.waitForLiveState('UNINITIALIZED');
    await processHarness.request('/api/live-state/initialize', {
      method: 'POST', headers: { 'x-api-key': API_KEY }, body: {},
    });
    await processHarness.waitForReady();
    await processHarness.stopGracefully();
    await fs.promises.writeFile(processHarness.statePath, '{');

    await processHarness.start({ marketMode: 'idle' });
    await processHarness.waitForLiveState('FAILED');
    const health = await processHarness.request('/healthz');
    assert.deepEqual(health.body, { status: 'failed', lifecycle: 'FAILED' });
    assert.equal(health.statusCode, 503);
    const ready = await processHarness.request('/readyz');
    assert.equal(ready.statusCode, 503);
    assert.equal(fs.readFileSync(processHarness.statePath, 'utf8'), '{');
    const initialize = await processHarness.request('/api/live-state/initialize', {
      method: 'POST', headers: { 'x-api-key': API_KEY }, body: {},
    });
    assert.equal(initialize.statusCode, 503);
  } finally {
    await processHarness.dispose();
  }
});

test('fingerprint mismatch fails closed without overwrite or scheduler activation', async () => {
  const processHarness = await createLiveProcess();
  try {
    await processHarness.start({ marketMode: 'idle' });
    await processHarness.waitForLiveState('UNINITIALIZED');
    await processHarness.request('/api/live-state/initialize', {
      method: 'POST', headers: { 'x-api-key': API_KEY }, body: {},
    });
    await processHarness.waitForReady();
    await processHarness.stopGracefully();
    const before = fs.readFileSync(processHarness.statePath, 'utf8');

    await processHarness.start({ marketMode: 'idle', extraEnv: { CONFLUENCE_BULLISH_THRESHOLD: '66' } });
    await processHarness.waitForLiveState('FAILED');
    const health = await processHarness.request('/healthz');
    assert.deepEqual(health.body, { status: 'failed', lifecycle: 'FAILED' });
    assert.equal(health.statusCode, 503);
    assert.equal(fs.readFileSync(processHarness.statePath, 'utf8'), before);
    assert.equal((await processHarness.request('/readyz')).statusCode, 503);
  } finally {
    await processHarness.dispose();
  }
});

test('missing primary with a matching temp fails closed instead of becoming first-run', async () => {
  const processHarness = await createLiveProcess();
  try {
    await processHarness.start({ marketMode: 'idle' });
    await processHarness.waitForLiveState('UNINITIALIZED');
    await processHarness.request('/api/live-state/initialize', {
      method: 'POST', headers: { 'x-api-key': API_KEY }, body: {},
    });
    await processHarness.waitForReady();
    await processHarness.stopGracefully();

    const tempPath = path.join(processHarness.stateDirectory, '.live-execution-state.json.1.deadbeef.tmp');
    await fs.promises.rename(processHarness.statePath, tempPath);
    await processHarness.start({ marketMode: 'idle' });
    await processHarness.waitForLiveState('FAILED');
    const health = await processHarness.request('/healthz');
    assert.deepEqual(health.body, { status: 'failed', lifecycle: 'FAILED' });
    assert.equal(health.statusCode, 503);
    assert.equal(fs.existsSync(tempPath), true);
    const initialize = await processHarness.request('/api/live-state/initialize', {
      method: 'POST', headers: { 'x-api-key': API_KEY }, body: {},
    });
    assert.equal(initialize.statusCode, 503);
  } finally {
    await processHarness.dispose();
  }
});

test('delayed restore exposes not-ready state and blocks live routes', async () => {
  const processHarness = await createLiveProcess();
  try {
    await processHarness.start({ marketMode: 'idle' });
    await processHarness.waitForLiveState('UNINITIALIZED');
    await processHarness.request('/api/live-state/initialize', {
      method: 'POST', headers: { 'x-api-key': API_KEY }, body: {},
    });
    await processHarness.waitForReady();
    await processHarness.stopGracefully();

    await processHarness.start({ mode: 'delayed-read', marketMode: 'idle' });
    await processHarness.waitForBarrier(processHarness.markerPath);
    const ready = await processHarness.request('/readyz');
    assert.equal(ready.statusCode, 503);
    const status = await processHarness.request('/api/status', { headers: { 'x-api-key': API_KEY } });
    assert.equal(status.body.liveStateReadiness, 'RESTORING');
    const paper = await processHarness.request('/api/paper-trades', { headers: { 'x-api-key': API_KEY } });
    assert.equal(paper.statusCode, 503);
    await processHarness.releaseBarrier(processHarness.markerPath);
    await processHarness.waitForReady();
  } finally {
    await processHarness.dispose();
  }
});

test('C9 certified disk state restores after sequence application is interrupted', async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'atlas-ph4f-c9-'));
  try {
    const clock = { nowMs: () => NOW, monotonicMs: () => 0 };
    const paperTrading = new PaperTradingEngine({ logger, symbol: 'BTCUSDT', clock });
    const advanceRisk = new AdvanceRiskEngine({ logger, symbol: 'BTCUSDT', paperTradeEngine: paperTrading, config: null, clock });
    const executionPipeline = {
      exportDurableState: () => ({ lastSignalTime: 0, riskSyncFailure: false }),
      prepareDurableState: state => ({ ...state }),
      applyDurableState() {},
    };
    const sourceAggregate = createLiveExecutionStateAggregate({
      symbol: 'BTCUSDT', configFingerprint, paperTrading, advanceRisk, executionPipeline, now: () => new Date(NOW),
    });
    const aggregate = {
      captureDurableDomainState: sourceAggregate.captureDurableDomainState,
      captureSnapshotForSequence: sourceAggregate.captureSnapshotForSequence,
      getMutationSequence: sourceAggregate.getMutationSequence,
      setMutationSequence: () => { throw new Error('sequence apply interrupted'); },
    };
    const store = createAtomicJsonStateStore({ filePath: path.join(directory, 'state.json'), now: () => NOW });
    const coordinator = createLiveStateCommitCoordinator({ aggregate, stateStore: store });
    await assert.rejects(
      coordinator.runMutation({
        name: 'c9',
        mutate: () => paperTrading.signal({}, 100, '1h', 'BUY', {
          stopLoss: 96, takeProfit: 106, positionSize: 25, riskReward: 2.5,
        }, { nowMs: NOW }),
      }),
      error => error.code === 'LIVE_STATE_DURABILITY_UNAVAILABLE',
    );

    const committed = await store.read({ expectedFingerprint: configFingerprint, expectedSymbol: 'BTCUSDT', nowMs: NOW });
    assert.equal(committed.status, 'VALID');
    assert.equal(committed.state.mutationSequence, 1);
    const restoredPaper = new PaperTradingEngine({ logger, symbol: 'BTCUSDT', clock });
    const restoredRisk = new AdvanceRiskEngine({ logger, symbol: 'BTCUSDT', paperTradeEngine: restoredPaper, config: null, clock });
    const restoredAggregate = createLiveExecutionStateAggregate({
      symbol: 'BTCUSDT', configFingerprint, paperTrading: restoredPaper, advanceRisk: restoredRisk, executionPipeline, now: () => new Date(NOW),
    });
    restoredAggregate.restoreSnapshot(committed.state);
    assert.equal(restoredAggregate.getMutationSequence(), 1);
    assert.equal(restoredPaper.getTrade('PT-1').status, 'OPEN');
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});
