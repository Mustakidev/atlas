const test = require('node:test');
const assert = require('node:assert/strict');

const { StrategyReplayEngine } = require('../../src/engine/strategyReplay');
const { AdvanceRiskEngine } = require('../../src/engine/advanceRisk');
const { MTFConfirmationEngine } = require('../../src/engine/mtfConfirmation');
const { PaperTradingEngine } = require('../../src/engine/paperTrading');

const logger = { info() {}, warn() {}, error() {} };
const config = {
  get(key) {
    if (key === 'CONFLUENCE_BULLISH_THRESHOLD') return 65;
    if (key === 'CONFLUENCE_BEARISH_THRESHOLD') return 35;
    return undefined;
  },
};

function candles(direction = 'up') {
  return Array.from({ length: 52 }, (_, index) => {
    const close = direction === 'up' ? 100 + index : 200 - index;
    return {
      open: close,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1,
      timestamp: new Date(index * 60000).toISOString(),
    };
  });
}

function flatCandles() {
  return Array.from({ length: 52 }, (_, index) => ({
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 1,
    timestamp: new Date(index * 60000).toISOString(),
  }));
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, nested] of Object.entries(value)) {
      if (!['lastUpdated', 'calculationTime', 'timestamp'].includes(key)) result[key] = stable(nested);
    }
    return result;
  }
  return value;
}

function makeReplay({ riskPolicySource, sourceMtf, lowerOpposition = false } = {}) {
  const risk = riskPolicySource || new AdvanceRiskEngine({ logger, symbol: 'BTCUSDT', paperTradeEngine: {}, config });
  const mtf = sourceMtf || new MTFConfirmationEngine({ logger, symbol: 'BTCUSDT', config });
  const replay = new StrategyReplayEngine({
    logger,
    symbol: 'BTCUSDT',
    config,
    riskPolicySource: risk,
    mtfConfirmationEngine: mtf,
  });

  replay._runMarketRegime = () => ({
    regime: 'TRENDING_BULL',
    confidence: 80,
    trendScore: 80,
    rangeScore: 20,
    volatility: 'LOW',
  });
  replay._runConfluence = (_candles, timeframe) => (lowerOpposition && timeframe === '1m'
    ? { score: 30, bias: 'Bearish', confidence: 60 }
    : { score: 80, bias: 'Bullish', confidence: 80 });
  replay._runATR = () => ({ ready: true, atr: 1, atrPercentage: 1 });
  replay._runStructure = () => ({ ready: true, direction: 'bullish', structure: 'Bullish', score: 80 });
  replay._synthesizeAnalyzer = () => ({ trend: { '1H': 'Bullish' } });
  replay._runRSI = () => ({ ready: true, value: 70, state: 'Overbought' });
  replay._runEMA = () => ({ ready: true, value: 110, trend: 'Above' });
  replay._runMACD = () => ({ ready: true, trend: 'Bullish', histogram: 1 });
  replay._runBollinger = () => ({ ready: true, pricePosition: 'Inside Bands' });
  replay._analyzeEngines = () => ({ direction: 'BUY', confidence: 80, reason: 'controlled replay', buyRatio: 0.8, sellRatio: 0.2 });

  return { replay, risk, mtf };
}

function resultSummary(result) {
  return {
    trades: result.trades,
    rejections: result.rejections,
    regimeHistory: result.regimeHistory,
    stats: result.stats,
  };
}

test('repeated identical replays are deterministic', () => {
  const { replay } = makeReplay();
  const first = replay.run(candles('up'), '1h');
  const second = replay.run(candles('up'), '1h');

  assert.deepEqual(stable(resultSummary(first)), stable(resultSummary(second)));
});

test('replay A -> B -> A does not leak session state', () => {
  const { replay } = makeReplay();
  const firstA = replay.run(candles('up'), '1h');
  replay.run(candles('down'), '1h');
  const secondA = replay.run(candles('up'), '1h');

  assert.deepEqual(stable(resultSummary(secondA)), stable(resultSummary(firstA)));
});

test('live risk state does not change replay output', () => {
  const liveRisk = new AdvanceRiskEngine({ logger, symbol: 'BTCUSDT', paperTradeEngine: {}, config });
  for (let index = 0; index < 3; index++) liveRisk.onTradeClosed(-100);

  const contaminated = makeReplay({ riskPolicySource: liveRisk }).replay.run(candles('up'), '1h');
  const clean = makeReplay().replay.run(candles('up'), '1h');

  assert.deepEqual(stable(resultSummary(contaminated)), stable(resultSummary(clean)));
  assert.equal(contaminated.trades.length, 1);
  assert.equal(contaminated.rejections.length, 0);
});

test('replay uses fresh risk state and does not change later live risk behavior', () => {
  const liveRisk = new AdvanceRiskEngine({ logger, symbol: 'BTCUSDT', paperTradeEngine: {}, config });
  const liveParams = {
    symbol: 'BTCUSDT',
    timeframe: '1h',
    entryPrice: 100,
    atr: { ready: true, atr: 1, atrPercentage: 1 },
    direction: 'BUY',
    trend: {},
    structure: {},
    confluence: { confidence: 80 },
    regime: 'TRENDING_BULL',
  };
  const before = liveRisk.evaluate(liveParams);
  const beforeState = liveRisk.getState();

  makeReplay({ riskPolicySource: liveRisk }).replay.run(candles('down'), '1h');

  const after = liveRisk.evaluate(liveParams);
  const afterState = liveRisk.getState();
  assert.deepEqual(stable(after), stable(before));
  assert.deepEqual({ dailyPnL: afterState.dailyPnL, consecutiveLosses: afterState.consecutiveLosses, tradingEnabled: afterState.tradingEnabled }, {
    dailyPnL: beforeState.dailyPnL,
    consecutiveLosses: beforeState.consecutiveLosses,
    tradingEnabled: beforeState.tradingEnabled,
  });
});

test('replay ignores production regime dependencies and uses replay-local regime data', () => {
  let productionRegimeCalls = 0;
  const { replay } = makeReplay();
  replay.setRegimeEngine({ calculate() { productionRegimeCalls++; return { regime: 'HIGH_VOLATILITY' }; } });

  const result = replay.run(flatCandles(), '1h');

  assert.equal(productionRegimeCalls, 0);
  assert.equal(result.regimeHistory[0].regime, 'TRENDING_BULL');
});

test('replay creates fresh MTF state and explicitly requests normal mode', () => {
  const sourceMtf = new MTFConfirmationEngine({ logger, symbol: 'BTCUSDT', config });
  sourceMtf.enableAggressive();
  const contaminated = makeReplay({ sourceMtf, lowerOpposition: true }).replay.run(candles('up'), '1h');
  const clean = makeReplay({ lowerOpposition: true }).replay.run(candles('up'), '1h');

  assert.deepEqual(stable(resultSummary(contaminated)), stable(resultSummary(clean)));
  assert.equal(contaminated.trades.length, 0);
  assert.equal(contaminated.rejections.length, 2);
});

test('risk policy values are copied without copying live business state', () => {
  const source = new AdvanceRiskEngine({ logger, symbol: 'BTCUSDT', paperTradeEngine: {}, config });
  source.setAccountBalance(25000);
  source.setRiskPerTradePct(2);
  source.setAtrMultTrending(3);
  source.setAtrMultRanging(2);
  source.setRrTrending(4);
  source.setRrRanging(2);
  source.setMaxDailyLossPct(7);
  source.setMaxDailyDrawdownPct(12);
  source.setMaxConsecutiveLosses(5);
  source.setConsecutiveCooldownMs(1234);
  source.setSessionMultiplier('ASIAN', 1.5);
  source.onTradeClosed(-100);

  const { replay } = makeReplay({ riskPolicySource: source });
  const local = replay._createReplayDependencies().advanceRiskEngine;
  const policy = local.getPolicy();

  assert.deepEqual(policy, {
    accountBalance: 25000,
    riskPerTradePct: 2,
    atrMultTrending: 3,
    atrMultRanging: 2,
    rrTrending: 4,
    rrRanging: 2,
    maxDailyLossPct: 7,
    maxDailyDrawdownPct: 12,
    maxConsecutiveLosses: 5,
    cooldownMs: 1234,
    sessionMultipliers: { ASIAN: 1.5, LONDON: 1, NEW_YORK: 1 },
  });
  assert.equal(local.paperTradeEngine, null);
  assert.equal(local.getDailyDrawdownPct(), 0);
  assert.deepEqual({ dailyPnL: local.getDailyPnL(), consecutiveLosses: local.getConsecutiveLosses(), tradingEnabled: local.isTradingEnabled() }, {
    dailyPnL: 0,
    consecutiveLosses: 0,
    tradingEnabled: true,
  });
});

test('replay trades use the approved AdvanceRisk execution plan', () => {
  const source = new AdvanceRiskEngine({ logger, symbol: 'BTCUSDT', paperTradeEngine: {}, config });
  source.setAccountBalance(25000);
  source.setRiskPerTradePct(2);
  source.setAtrMultTrending(3);
  source.setRrTrending(4);
  for (const session of ['ASIAN', 'LONDON', 'NEW_YORK']) source.setSessionMultiplier(session, 2);

  const { replay } = makeReplay({ riskPolicySource: source });
  const result = replay.run(candles('up'), '1h');
  const trade = result.trades[0];

  assert.ok(trade);
  assert.equal(trade.stopLoss, 147);
  assert.equal(trade.takeProfit, 162);
  assert.equal(trade.positionSize, 166.67);
  assert.equal(trade.riskReward, 4);
  assert.equal(trade.riskSize, 3);
});

test('replay exception does not contaminate subsequent replay or production risk state', () => {
  const liveRisk = new AdvanceRiskEngine({ logger, symbol: 'BTCUSDT', paperTradeEngine: {}, config });
  const { replay } = makeReplay({ riskPolicySource: liveRisk });
  const originalAnalysis = replay._analyzeEngines;
  let throwOnce = true;
  replay._analyzeEngines = () => {
    if (throwOnce) {
      throwOnce = false;
      throw new Error('controlled replay failure');
    }
    return originalAnalysis();
  };

  assert.throws(() => replay.run(candles('up'), '1h'), /controlled replay failure/);
  replay._analyzeEngines = originalAnalysis;
  const afterFailure = replay.run(candles('up'), '1h');
  const clean = makeReplay().replay.run(candles('up'), '1h');

  assert.deepEqual(stable(resultSummary(afterFailure)), stable(resultSummary(clean)));
  assert.equal(liveRisk.getDailyPnL(), 0);
  assert.equal(liveRisk.getConsecutiveLosses(), 0);
});

test('replay does not mutate input candles or production paper trading state', () => {
  const paperTrade = new PaperTradingEngine({ logger, symbol: 'BTCUSDT' });
  const liveRisk = new AdvanceRiskEngine({ logger, symbol: 'BTCUSDT', paperTradeEngine: paperTrade, config });
  const { replay } = makeReplay({ riskPolicySource: liveRisk });
  const input = candles('up');
  const inputBefore = JSON.stringify(input);
  const paperBefore = { balance: paperTrade.getBalance(), open: paperTrade.open(), history: paperTrade.history(), stats: paperTrade.stats() };

  replay.run(input, '1h');

  assert.equal(JSON.stringify(input), inputBefore);
  assert.deepEqual({ balance: paperTrade.getBalance(), open: paperTrade.open(), history: paperTrade.history(), stats: paperTrade.stats() }, paperBefore);
});

test('replay results are independently owned', () => {
  const { replay } = makeReplay();
  const resultA = replay.run(candles('up'), '1h');
  const expected = stable(resultA);
  resultA.trades[0].entry = -999;
  resultA.rejections.push({ reason: 'mutated' });
  resultA.regimeHistory[0].regime = 'MUTATED';
  resultA.stats.totalTrades = -1;

  const resultB = replay.run(candles('up'), '1h');

  assert.deepEqual(stable(resultB), expected);
});

test('clean replay trade lifecycle and statistics remain unchanged', () => {
  const { replay } = makeReplay();
  const result = replay.run(candles('up'), '1h');

  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].direction, 'BUY');
  assert.equal(result.trades[0].entry, 150);
  assert.equal(result.trades[0].exitReason, 'End of Data');
  assert.equal(result.stats.totalTrades, 1);
  assert.equal(result.stats.wins, 1);
  assert.equal(result.stats.totalRejections, 0);
});
