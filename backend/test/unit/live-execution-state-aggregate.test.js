const test = require('node:test');
const assert = require('node:assert/strict');

const { AdvanceRiskEngine } = require('../../src/engine/advanceRisk');
const { createExecutionPipeline } = require('../../src/core/executionPipeline');
const { PaperTradingEngine } = require('../../src/engine/paperTrading');
const { createLiveExecutionStateAggregate } = require('../../src/state/liveExecutionStateAggregate');
const { createConfigFingerprint } = require('../../src/state/liveExecutionStateSchema');

const NOW = Date.parse('2024-01-02T00:00:00.000Z');
const logger = { info() {}, warn() {}, error() {}, system() {} };
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

function clock() {
  return { nowMs: () => NOW, monotonicMs: () => 0 };
}

function makePipeline(paper, risk) {
  const candleEngine = { getActive: () => null, getCandles: () => [] };
  return createExecutionPipeline({
    config: { get: () => undefined },
    logger,
    symbol: 'BTCUSDT',
    candleEngine,
    mtfCandleEngine: candleEngine,
    atrEngine: {},
    regimeEngine: {},
    confluenceEngine: {},
    analyzer: {},
    structureEngine: {},
    indicatorRegistry: {},
    macdEngine: {},
    bollingerEngine: {},
    regimeDecisionEngine: {},
    mtfConfirmationEngine: {},
    advanceRiskEngine: risk,
    mtfEngine: {},
    paperTradeEngine: paper,
    clock: clock(),
  });
}

function makeGraph() {
  const paperTrading = new PaperTradingEngine({ logger, symbol: 'BTCUSDT', clock: clock() });
  const advanceRisk = new AdvanceRiskEngine({ logger, symbol: 'BTCUSDT', paperTradeEngine: paperTrading, config: null, clock: clock() });
  const executionPipeline = makePipeline(paperTrading, advanceRisk);
  const aggregate = createLiveExecutionStateAggregate({
    symbol: 'BTCUSDT',
    configFingerprint,
    paperTrading,
    advanceRisk,
    executionPipeline,
    now: () => new Date(NOW),
  });
  return { paperTrading, advanceRisk, executionPipeline, aggregate };
}

function openTrade(paperTrading, price = 100) {
  return paperTrading.signal({}, price, '1h', 'BUY', {
    stopLoss: price - 4,
    takeProfit: price + 6,
    positionSize: 25,
    riskReward: 2.5,
  }, { nowMs: NOW });
}

function setRiskState(advanceRisk) {
  advanceRisk.setAccountBalance(25000);
  advanceRisk.onTradeClosed(-100, { nowMs: NOW });
}

function context() {
  return { expectedFingerprint: configFingerprint, expectedSymbol: 'BTCUSDT', nowMs: NOW };
}

test('captures and restores all durable authorities without retaining snapshot aliases', () => {
  const source = makeGraph();
  const first = openTrade(source.paperTrading);
  source.paperTrading.close(first.tradeId, 'Manual', { nowMs: NOW });
  const active = openTrade(source.paperTrading, 110);
  setRiskState(source.advanceRisk);
  source.aggregate.setMutationSequence(7);

  const snapshot = source.aggregate.captureSnapshot();
  const target = makeGraph();
  target.aggregate.restoreSnapshot(snapshot);
  const restored = target.aggregate.captureSnapshot();

  assert.deepEqual(restored, snapshot);
  assert.equal(target.aggregate.getMutationSequence(), 7);
  assert.equal(target.paperTrading.getTrade(active.tradeId).status, 'OPEN');
  assert.equal(target.paperTrading.close(first.tradeId, 'Manual'), null);

  snapshot.paperTrading.trades[0].status = 'OPEN';
  snapshot.paperTrading.closedTrades[0].pnl = -999;
  snapshot.advanceRisk.dailyPnL = 999;
  snapshot.executionPipeline.lastSignalTime = NOW;
  assert.equal(target.paperTrading.getTrade(first.tradeId).status, 'CLOSED');
  assert.equal(target.advanceRisk.getDailyPnL(), -100);
  assert.equal(target.executionPipeline.exportDurableState().lastSignalTime, 0);
});

test('restores PH-3 latches and cooldown metadata without healing or resetting them', () => {
  const source = makeGraph();
  const snapshot = structuredClone(source.aggregate.captureSnapshot());
  snapshot.advanceRisk.riskStateHealthy = false;
  snapshot.executionPipeline.lastSignalTime = NOW - 1000;
  snapshot.executionPipeline.riskSyncFailure = true;

  const target = makeGraph();
  target.aggregate.restoreSnapshot(snapshot);
  const captured = target.aggregate.captureSnapshot();

  assert.equal(captured.advanceRisk.riskStateHealthy, false);
  assert.equal(captured.executionPipeline.lastSignalTime, NOW - 1000);
  assert.equal(captured.executionPipeline.riskSyncFailure, true);
  assert.equal(target.advanceRisk.isRiskStateHealthy(), false);
  assert.equal(target.executionPipeline.exportDurableState().riskSyncFailure, true);
});

test('preserves independent PaperTrading and AdvanceRisk balances', () => {
  const source = makeGraph();
  const snapshot = structuredClone(source.aggregate.captureSnapshot());
  snapshot.paperTrading.balance = 12000;
  snapshot.paperTrading.peakEquity = 12000;
  snapshot.advanceRisk.accountBalance = 25000;
  snapshot.advanceRisk.dailyHighWater = 25000;

  const target = makeGraph();
  target.aggregate.restoreSnapshot(snapshot);
  assert.equal(target.paperTrading.getBalance(), 12000);
  assert.equal(target.advanceRisk.getAccountBalance(), 25000);
});

test('reconstructs closed IDs and preserves future trade ID allocation', () => {
  const source = makeGraph();
  const first = openTrade(source.paperTrading);
  source.paperTrading.close(first.tradeId, 'Manual', { nowMs: NOW });
  openTrade(source.paperTrading, 110);
  const snapshot = source.aggregate.captureSnapshot();

  const target = makeGraph();
  target.aggregate.restoreSnapshot(snapshot);
  assert.deepEqual([...target.paperTrading._closedIds], [first.tradeId]);
  assert.equal(target.paperTrading.close(first.tradeId, 'Manual'), null);
  const next = openTrade(target.paperTrading, 120);
  assert.equal(next.tradeId, 'PT-3');
});

test('invalid restore performs zero domain or aggregate mutation', () => {
  const target = makeGraph();
  const opened = openTrade(target.paperTrading);
  setRiskState(target.advanceRisk);
  target.aggregate.setMutationSequence(9);
  const before = target.aggregate.captureSnapshot();

  for (const invalid of [
    { ...before, configFingerprint: 'sha256:' + '0'.repeat(64) },
    { ...before, symbol: 'ETHUSDT' },
    { ...before, paperTrading: { ...before.paperTrading, balance: NaN } },
    { ...before, executionPipeline: { ...before.executionPipeline, riskSyncFailure: 'true' } },
  ]) {
    assert.throws(() => target.aggregate.restoreSnapshot(invalid), error => error.code === 'STATE_CONTEXT_MISMATCH' || error.code === 'STATE_VALIDATION_FAILED');
    assert.deepEqual(target.aggregate.captureSnapshot(), before);
  }
  assert.equal(target.paperTrading.getTrade(opened.tradeId).status, 'OPEN');
  assert.equal(target.aggregate.getMutationSequence(), 9);
});

test('preparation failure occurs before any component apply', () => {
  const target = makeGraph();
  const before = target.aggregate.captureSnapshot();
  const originalPrepare = target.executionPipeline.prepareDurableState;
  target.executionPipeline.prepareDurableState = () => { throw new Error('prepare failed'); };

  assert.throws(() => target.aggregate.restoreSnapshot(before), /prepare failed/);
  target.executionPipeline.prepareDurableState = originalPrepare;
  assert.deepEqual(target.aggregate.captureSnapshot(), before);
});

test('domain export methods return defensive copies', () => {
  const graph = makeGraph();
  openTrade(graph.paperTrading);
  const paper = graph.paperTrading.exportDurableState();
  const risk = graph.advanceRisk.exportDurableState();
  const pipeline = graph.executionPipeline.exportDurableState();

  paper.trades[0].status = 'CLOSED';
  paper.trades.push({});
  risk.dailyPnL = 999;
  pipeline.lastSignalTime = NOW;

  assert.equal(graph.paperTrading.open()[0].status, 'OPEN');
  assert.equal(graph.paperTrading.exportDurableState().trades.length, 1);
  assert.equal(graph.advanceRisk.getDailyPnL(), 0);
  assert.equal(graph.executionPipeline.exportDurableState().lastSignalTime, 0);
});

test('restore accepts the PH-4B validated context and rejects wrong context before mutation', () => {
  const graph = makeGraph();
  const snapshot = graph.aggregate.captureSnapshot();
  assert.doesNotThrow(() => graph.aggregate.restoreSnapshot(snapshot));
  assert.throws(() => graph.aggregate.restoreSnapshot({ ...snapshot, symbol: 'ETHUSDT' }), error => error instanceof Error);
  assert.equal(graph.aggregate.getMutationSequence(), 0);
  assert.deepEqual(graph.aggregate.captureSnapshot(), snapshot);
  assert.doesNotThrow(() => validateSnapshotForTest(snapshot));
});

function validateSnapshotForTest(snapshot) {
  if (snapshot.symbol !== 'BTCUSDT') throw new Error('unexpected symbol');
}
