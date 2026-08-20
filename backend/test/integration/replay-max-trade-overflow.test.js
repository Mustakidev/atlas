const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeReplayAnalyzerInput } = require('../../src/engine/replayAnalyzerInput');
const { createReplayDependencies } = require('../../src/engine/replayDependencies');
const { createReplayPipelineRunner } = require('../../src/engine/replayPipelineRunner');

const BASE_TIME = Date.parse('2024-01-01T00:00:00.000Z');
const HOUR = 3600000;
const logger = { info() {}, warn() {}, error() {}, system() {} };
const config = {
  get(key) {
    if (key === 'CONFLUENCE_BULLISH_THRESHOLD') return 65;
    if (key === 'CONFLUENCE_BEARISH_THRESHOLD') return 35;
    if (key === 'MAX_HISTORY') return 500;
    return undefined;
  },
};

function makeInput(count = 18) {
  const candles = Array.from({ length: count }, (_, index) => ({
    openTime: BASE_TIME + index * HOUR,
    timestamp: new Date(BASE_TIME + index * HOUR).toISOString(),
    open: 100 + index,
    high: 101 + index,
    low: 99 + index,
    close: 100 + index,
    volume: 1,
  })).map(candle => Object.freeze(candle));

  return Object.freeze({
    schemaVersion: 1,
    timeframe: '1h',
    candles: Object.freeze(candles),
  });
}

function makeAnalyzerInput() {
  return normalizeReplayAnalyzerInput({
    schemaVersion: 1,
    symbol: 'BTCUSDT',
    snapshots: [
      { timestamp: new Date(BASE_TIME).toISOString(), price: 100, volume: 1000, change24h: 0 },
      { timestamp: new Date(BASE_TIME + 60000).toISOString(), price: 101, volume: 1000, change24h: 0 },
    ],
  });
}

function prepareEligibleBundle(bundle) {
  bundle.analyzer.getAnalysis = () => ({ trend: { '1H': 'Bullish' } });
  bundle.regimeEngine.calculate = () => ({
    regime: 'TRENDING_BULL', confidence: 80, trendScore: 80, rangeScore: 20, volatility: 'Low',
  });
  bundle.confluenceEngine.calculate = () => ({
    score: 80, bias: 'Bullish', confidence: 80, components: {}, missing: [],
  });
  bundle.atrEngine.calculate = () => ({
    ready: true, atr: 1, atrPercentage: 1, volatilityLevel: 'Low', volatilityTrend: 'Stable',
  });
  bundle.structureEngine.calculate = () => ({
    ready: true, direction: 'bullish', structure: 'Bullish', score: 80,
  });
  bundle.indicatorRegistry.get = name => ({
    calculate: () => name === 'RSI'
      ? { ready: true, value: 70, state: 'Overbought' }
      : { ready: true, value: 110, trend: 'Above' },
  });
  bundle.macdEngine.calculate = () => ({
    ready: true, macd: 1, signal: 0, histogram: 1, trend: 'Bullish',
  });
  bundle.bollingerEngine.calculate = () => ({
    ready: false, middleBand: null, upperBand: null, lowerBand: null, pricePosition: 'Inside Bands', squeeze: false,
  });
  bundle.regimeDecisionEngine.evaluate = () => ({
    allowTrade: true, preferredDirection: 'BUY', penalty: 0, reason: 'Allowed',
  });
  bundle.mtfConfirmationEngine.evaluate = () => ({
    mtfAllowed: true, rejectionReason: null, confidence: 80, alignmentScore: 100,
  });
  bundle.advanceRiskEngine.evaluate = ({ entryPrice }) => ({
    tradeAllowed: true,
    positionSize: 1,
    stopLoss: entryPrice - 50,
    takeProfit: entryPrice + 50,
    riskReward: 1,
    session: 'ASIAN',
  });
  bundle.mtfEngine.calculate = () => ({ overallBias: 'Bullish', timeframeAgreement: 100 });
}

function runQuietly(runner) {
  const originalLog = console.log;
  console.log = () => {};
  try {
    return runner.runNextCycle();
  } finally {
    console.log = originalLog;
  }
}

test('replay shared pipeline records overflow locally and EOD does not duplicate it', () => {
  const input = makeInput();
  let monotonicMs = 0;
  const bundle = createReplayDependencies({
    logger,
    symbol: 'BTCUSDT',
    config,
    normalizedInput: input,
    analyzerInput: makeAnalyzerInput(),
    clock: {
      nowMs: () => BASE_TIME,
      monotonicMs: () => monotonicMs++,
    },
  });
  prepareEligibleBundle(bundle);
  bundle.paperTradeEngine._maxTrades = 1;

  const riskClosures = [];
  const originalOnTradeClosed = bundle.advanceRiskEngine.onTradeClosed.bind(bundle.advanceRiskEngine);
  bundle.advanceRiskEngine.onTradeClosed = (pnl, context) => {
    riskClosures.push({ pnl, context });
    return originalOnTradeClosed(pnl, context);
  };

  const runner = createReplayPipelineRunner({ dependencies: bundle, normalizedInput: input });
  const results = [];
  let observedReplacement = false;
  while (runner.hasNext()) {
    results.push(runQuietly(runner));
    const history = bundle.paperTradeEngine.history();
    if (history.length === 1 && !observedReplacement) {
      assert.equal(history[0].exitReason, 'Invalidated');
      assert.equal(bundle.paperTradeEngine.open().length, 1);
      assert.notEqual(bundle.paperTradeEngine.open()[0].tradeId, history[0].tradeId);
      assert.equal(bundle.paperTradeEngine.open()[0].status, 'OPEN');
      observedReplacement = true;
    }
  }

  const history = bundle.paperTradeEngine.history();
  assert.equal(observedReplacement, true);
  assert.equal(results.some(result => result.decision.verdict.trade?.tradeId === 'PT-1'), true);
  assert.equal(results.some(result => result.decision.verdict.trade?.tradeId === 'PT-2'), true);
  assert.equal(history.filter(trade => trade.exitReason === 'Invalidated').length, 3);
  assert.equal(history.filter(trade => trade.exitReason === 'End of Data').length, 1);
  assert.equal(new Set(history.map(trade => trade.tradeId)).size, history.length);
  assert.equal(riskClosures.length, 4);
  assert.deepEqual(riskClosures.map(closure => closure.pnl), [0, 0, 0, 0]);
  assert.equal(bundle.paperTradeEngine.open().length, 0);
  assert.equal(bundle.paperTradeEngine.stats().closedTrades, 4);
  assert.equal(bundle.advanceRiskEngine.getDailyPnL(), 0);
  assert.equal(runner.getState().status, 'EXHAUSTED');
});
