const test = require('node:test');
const assert = require('node:assert/strict');

const { createExecutionPipeline } = require('../../src/core/executionPipeline');
const { AdvanceRiskEngine } = require('../../src/engine/advanceRisk');
const { PaperTradingEngine } = require('../../src/engine/paperTrading');

const logger = { info() {}, warn() {}, error() {} };
const candles = Array.from({ length: 20 }, (_, index) => ({
  openTime: index * 3600000,
  open: 100,
  high: 101,
  low: 99,
  close: 100,
  volume: 1,
}));

function makeHarness({ onTradeClosed, onEvaluate, riskAuthority } = {}) {
  let nowMs = 60000;
  let monotonicMs = 0;
  const riskClosures = [];
  let riskEvaluateCalls = 0;
  let signalCalls = 0;
  const riskNotifier = onTradeClosed || ((pnl, context) => riskClosures.push({ pnl, context }));
  const paperTradeEngine = new PaperTradingEngine({
    logger,
    symbol: 'BTCUSDT',
    clock: {
      nowMs: () => nowMs,
      monotonicMs: () => monotonicMs++,
    },
  });
  paperTradeEngine._maxTrades = 1;
  const originalSignal = paperTradeEngine.signal.bind(paperTradeEngine);
  paperTradeEngine.signal = (...args) => {
    signalCalls++;
    return originalSignal(...args);
  };

  const pipeline = createExecutionPipeline({
    config: {
      get(key) {
        if (key === 'CONFLUENCE_BULLISH_THRESHOLD') return 65;
        if (key === 'CONFLUENCE_BEARISH_THRESHOLD') return 35;
        return undefined;
      },
    },
    logger,
    symbol: 'BTCUSDT',
    clock: {
      nowMs: () => nowMs,
      monotonicMs: () => monotonicMs++,
    },
    candleEngine: {
      getCandles: () => candles,
      getActive: () => null,
    },
    regimeEngine: {
      calculate: () => ({ regime: 'TRENDING_BULL', confidence: 80, trendScore: 80, rangeScore: 20, volatility: 'Low' }),
    },
    confluenceEngine: {
      calculate: () => ({ score: 80, bias: 'Bullish', confidence: 80, components: {}, missing: [] }),
    },
    atrEngine: {
      calculate: () => ({ ready: true, atr: 2, atrPercentage: 1, volatilityLevel: 'Low', volatilityTrend: 'Stable' }),
    },
    analyzer: {
      getAnalysis: () => ({ trend: { '1H': 'Bullish' } }),
    },
    structureEngine: {
      calculate: () => ({ ready: true, direction: 'bullish', score: 80, structure: 'Bullish' }),
    },
    indicatorRegistry: {
      get: name => ({
        calculate: () => name === 'RSI'
          ? { ready: true, value: 70, state: 'Overbought' }
          : { ready: true, value: 110, trend: 'Above' },
      }),
    },
    macdEngine: {
      calculate: () => ({ ready: true, macd: 1, signal: 0, histogram: 1, trend: 'Bullish' }),
    },
    bollingerEngine: {
      calculate: () => ({ ready: true, middleBand: 100, upperBand: 110, lowerBand: 90, pricePosition: 'Inside Bands', squeeze: false }),
    },
    regimeDecisionEngine: {
      evaluate: () => ({ allowTrade: true, preferredDirection: 'BUY', penalty: 0, reason: 'Allowed' }),
    },
    mtfConfirmationEngine: {
      evaluate: () => ({ mtfAllowed: true, rejectionReason: null, confidence: 80, alignmentScore: 100 }),
    },
    advanceRiskEngine: riskAuthority || {
      evaluate: (...args) => {
        riskEvaluateCalls++;
        return onEvaluate ? onEvaluate(...args) : { tradeAllowed: true, positionSize: 1, stopLoss: 90, takeProfit: 200, riskReward: 4.4, session: 'ASIAN' };
      },
      onTradeClosed: riskNotifier,
    },
    mtfEngine: {
      calculate: () => ({ overallBias: 'Bullish', timeframeAgreement: 100 }),
    },
    paperTradeEngine,
  });

  return {
    pipeline,
    paperTradeEngine,
    riskClosures,
    getRiskEvaluateCalls() { return riskEvaluateCalls; },
    getSignalCalls() { return signalCalls; },
    setNow(value) { nowMs = value; },
  };
}

function runQuietly(harness, price, nowMs) {
  harness.setNow(nowMs);
  const originalLog = console.log;
  console.log = () => {};
  try {
    harness.pipeline.run({ price, timestamp: new Date(nowMs).toISOString() });
  } finally {
    console.log = originalLog;
  }
  return harness.pipeline.getLastDecision();
}

test('pipeline observes signal-time overflow and notifies canonical risk once per closure', () => {
  const harness = makeHarness();

  const firstDecision = runQuietly(harness, 100, 60000);
  const secondDecision = runQuietly(harness, 101, 120000);
  const thirdDecision = runQuietly(harness, 102, 180000);
  const history = harness.paperTradeEngine.history();

  assert.equal(firstDecision.verdict.tradeOpened, true);
  assert.equal(firstDecision.verdict.trade.tradeId, 'PT-1');
  assert.equal(secondDecision.verdict.tradeOpened, true);
  assert.equal(secondDecision.verdict.trade.tradeId, 'PT-2');
  assert.equal(thirdDecision.verdict.tradeOpened, true);
  assert.equal(thirdDecision.verdict.trade.tradeId, 'PT-3');
  assert.deepEqual(harness.paperTradeEngine.open().map(trade => trade.tradeId), ['PT-3']);
  assert.deepEqual(history.map(trade => trade.tradeId), ['PT-1', 'PT-2']);
  assert.deepEqual(history.map(trade => trade.exitReason), ['Invalidated', 'Invalidated']);
  assert.deepEqual(history.map(trade => trade.status), ['CLOSED', 'CLOSED']);
  assert.deepEqual(harness.riskClosures, [
    { pnl: 1, context: { nowMs: 120000 } },
    { pnl: 1, context: { nowMs: 180000 } },
  ]);
  assert.equal(harness.paperTradeEngine.getBalance(), 10002);
  assert.equal(harness.paperTradeEngine.stats().closedTrades, 2);
  assert.equal(harness.paperTradeEngine.stats().openTrades, 1);
});

test('pre-open risk synchronization failure prevents replacement exposure', () => {
  let syncCalls = 0;
  const harness = makeHarness({
    onTradeClosed: () => {
      syncCalls++;
      throw new Error('risk synchronization unavailable');
    },
  });

  const firstDecision = runQuietly(harness, 100, 60000);
  const secondDecision = runQuietly(harness, 101, 120000);

  assert.equal(firstDecision.verdict.tradeOpened, true);
  assert.equal(secondDecision.verdict.tradeOpened, false);
  assert.equal(secondDecision.verdict.rejectionReason, 'RISK_STATE_SYNC_FAILURE');
  assert.equal(harness.pipeline.getLastRunStatus().status, 'FAILED');
  assert.equal(syncCalls, 1);
  assert.deepEqual(harness.paperTradeEngine.open(), []);
  assert.deepEqual(harness.paperTradeEngine.history().map(trade => trade.tradeId), ['PT-1']);
  assert.equal(harness.paperTradeEngine.stats().closedTrades, 1);
});

test('risk synchronization failure remains fail-closed across later cycles', () => {
  const harness = makeHarness({
    onTradeClosed: () => { throw new Error('risk synchronization unavailable'); },
  });

  runQuietly(harness, 100, 60000);
  const failedDecision = runQuietly(harness, 101, 120000);
  const laterDecision = runQuietly(harness, 102, 180000);

  assert.equal(failedDecision.verdict.rejectionReason, 'RISK_STATE_SYNC_FAILURE');
  assert.equal(laterDecision.verdict.rejectionReason, 'RISK_STATE_SYNC_FAILURE');
  assert.equal(harness.pipeline.getLastRunStatus().status, 'FAILED');
  assert.equal(harness.getRiskEvaluateCalls(), 2);
  assert.equal(harness.getSignalCalls(), 2);
  assert.deepEqual(harness.paperTradeEngine.open(), []);
  assert.equal(harness.paperTradeEngine.history().length, 1);
});

test('malformed pre-open closure PnL blocks replacement and later cycles', () => {
  const authority = new AdvanceRiskEngine({
    logger,
    symbol: 'BTCUSDT',
    paperTradeEngine: null,
    config: {},
    clock: { nowMs: () => 60000, monotonicMs: () => 0 },
  });
  const harness = makeHarness({ riskAuthority: authority });

  const firstDecision = runQuietly(harness, 100, 60000);
  harness.paperTradeEngine._trades[0].positionSize = NaN;
  const failedDecision = runQuietly(harness, 101, 120000);
  const laterDecision = runQuietly(harness, 102, 180000);

  assert.equal(firstDecision.verdict.tradeOpened, true);
  assert.equal(failedDecision.verdict.tradeOpened, false);
  assert.equal(failedDecision.verdict.rejectionReason, 'RISK_STATE_SYNC_FAILURE');
  assert.equal(authority.isRiskStateHealthy(), false);
  assert.deepEqual(harness.paperTradeEngine.open(), []);
  assert.deepEqual(harness.paperTradeEngine.history().map(trade => trade.tradeId), ['PT-1']);
  assert.equal(laterDecision.verdict.rejectionReason, 'RISK_STATE_SYNC_FAILURE');
  assert.equal(harness.paperTradeEngine.history().length, 1);
});

test('fresh execution graph restores valid admission after a failed graph', () => {
  const failedHarness = makeHarness({
    onTradeClosed: () => { throw new Error('risk synchronization unavailable'); },
  });
  runQuietly(failedHarness, 100, 60000);
  runQuietly(failedHarness, 101, 120000);

  const freshHarness = makeHarness();
  const decision = runQuietly(freshHarness, 102, 180000);

  assert.equal(decision.verdict.tradeOpened, true);
  assert.equal(freshHarness.getRiskEvaluateCalls(), 1);
  assert.equal(freshHarness.getSignalCalls(), 1);
  assert.deepEqual(freshHarness.paperTradeEngine.open().map(trade => trade.tradeId), ['PT-1']);
});
