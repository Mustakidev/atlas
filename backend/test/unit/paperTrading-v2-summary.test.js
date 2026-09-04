const assert = require('node:assert/strict');
const test = require('node:test');

const {
  PaperTradingEngine,
  RECENT_CLOSED_TRADES_LIMIT,
} = require('../../src/engine/paperTrading');
const {
  legacyPerformance,
  legacyStats,
} = require('../helpers/paper-trading-legacy-metrics');

const START = Date.parse('2024-01-01T00:00:00.000Z');
const logger = { info() {}, warn() {}, error() {} };

function makeEngine() {
  return new PaperTradingEngine({
    logger,
    symbol: 'BTCUSDT',
    clock: { nowMs: () => START, monotonicMs: () => 0 },
  });
}

function closeTrade(engine, index, { pnl, direction = 'BUY', timeframe = '1h', reason = 'Manual' }) {
  const entryPrice = 100;
  const exitPrice = direction === 'BUY' ? entryPrice + pnl : entryPrice - pnl;
  const trade = engine._openTrade({
    symbol: 'BTCUSDT',
    timeframe,
    direction,
    entryPrice,
    stopLoss: direction === 'BUY' ? 1 : 199,
    takeProfit: direction === 'BUY' ? 199 : 1,
    riskReward: 2,
    positionSize: 1,
    currentPrice: entryPrice,
    confidence: 80,
    reason: 'summary test',
    status: 'OPEN',
  });
  engine._lastPrice = exitPrice;
  const closed = engine.close(trade.tradeId, reason, { nowMs: START + index + 1 });
  assert.ok(closed);
  return closed;
}

function welford(values) {
  let mean = 0;
  let m2 = 0;
  for (let index = 0; index < values.length; index++) {
    const n = index + 1;
    const delta = values[index] - mean;
    mean += delta / n;
    const delta2 = values[index] - mean;
    m2 += delta * delta2;
  }
  return { mean, m2 };
}

function stableSharpe(values) {
  if (values.length === 0) return 0;
  const { mean, m2 } = welford(values);
  const deviation = Math.sqrt(m2 / values.length);
  return deviation > 0 ? Math.round((mean / deviation) * 100) / 100 : 0;
}

test('fresh engines initialize the exact zero lifetime summary', () => {
  const engine = makeEngine();
  assert.deepEqual(engine.exportDurableState().lifetimeSummary, {
    totalClosedTrades: 0,
    winningTrades: 0,
    losingTrades: 0,
    breakevenTrades: 0,
    grossProfit: 0,
    lossPnlSum: 0,
    totalPnl: 0,
    totalPnlPercent: 0,
    totalDuration: 0,
    maxPnl: 0,
    minPnl: 0,
    bestTrade: null,
    worstTrade: null,
    drawdownPeakEquity: 10000,
    maxDrawdown: 0,
    maxDrawdownPct: 0,
    maxConsecutiveWins: 0,
    maxConsecutiveLosses: 0,
    winningStreakCount: 0,
    losingStreakCount: 0,
    currentStreak: 0,
    currentStreakType: 'None',
    returnMean: 0,
    returnM2: 0,
    downsideReturnCount: 0,
    downsideReturnSumSquares: 0,
    byDirection: {
      BUY: { total: 0, wins: 0, losses: 0, totalPnl: 0 },
      SELL: { total: 0, wins: 0, losses: 0, totalPnl: 0 },
    },
    byTimeframe: {},
    byExitReason: {},
  });
});

test('V2 public stats and performance equal the legacy formulas on a large corpus', () => {
  const engine = makeEngine();
  const fullClosedTrades = [];
  const pnlPattern = [
    0, 0.0001, -0.0002, 0.37, -0.29, 1.75, -2.25, 0.01, -0.01,
  ];

  for (let index = 0; index < 1200; index++) {
    const pnl = pnlPattern[index % pnlPattern.length];
    const direction = index % 3 === 0 ? 'SELL' : 'BUY';
    const closed = closeTrade(engine, index, {
      pnl,
      direction,
      timeframe: index % 2 === 0 ? '1h' : '4h',
      reason: index % 5 === 0 ? 'Manual' : 'Take Profit',
    });
    fullClosedTrades.push(closed);
  }

  const input = {
    trades: engine.all(),
    closedTrades: fullClosedTrades,
    balance: engine.getBalance(),
    initialBalance: 10000,
  };
  assert.deepStrictEqual(engine.stats(), legacyStats(input));
  const actualPerformance = engine.performance();
  const expectedPerformance = legacyPerformance(input);
  assert.equal(actualPerformance.metricsVersion, 2);
  delete actualPerformance.metricsVersion;
  delete actualPerformance.sharpeRatio;
  delete expectedPerformance.sharpeRatio;
  assert.deepStrictEqual(actualPerformance, expectedPerformance);
  assert.equal(engine.performance().sharpeRatio, stableSharpe(fullClosedTrades.map(trade => trade.pnlPercent)));
  assert.equal(engine.history(10000).length, RECENT_CLOSED_TRADES_LIMIT);
  assert.equal(engine.closed().length, RECENT_CLOSED_TRADES_LIMIT);
  assert.equal(engine._closedIds.size, RECENT_CLOSED_TRADES_LIMIT);
  assert.equal(engine.stats().closedTrades, fullClosedTrades.length);
});

test('summary preserves earliest best and worst trade ties and all distributions', () => {
  const engine = makeEngine();
  const first = closeTrade(engine, 1, { pnl: 2, reason: 'Custom-A', timeframe: '1h' });
  const second = closeTrade(engine, 2, { pnl: 2, reason: 'Custom-B', timeframe: '4h' });
  closeTrade(engine, 3, { pnl: -2, direction: 'SELL', reason: 'Custom-A', timeframe: '1h' });
  closeTrade(engine, 4, { pnl: -2, direction: 'SELL', reason: 'Custom-B', timeframe: '4h' });
  closeTrade(engine, 5, { pnl: 0, reason: 'Custom-A', timeframe: '1h' });

  const stats = engine.stats();
  assert.equal(stats.largestWin, first.tradeId);
  assert.equal(stats.largestLoss, 'PT-3');
  assert.equal(stats.closedTrades, 5);
  assert.equal(stats.byDirection.BUY.total, 3);
  assert.equal(stats.byDirection.SELL.total, 2);
  assert.equal(stats.byTimeframe['1h'].total, 3);
  assert.equal(stats.byTimeframe['4h'].total, 2);
  assert.equal(stats.byExitReason['Custom-A'].count, 3);
  assert.equal(stats.byExitReason['Custom-B'].count, 2);
  assert.equal(stats.currentStreakType, 'Breakeven');
  assert.equal(stats.currentStreak, 1);
});

test('V2 uses stable zero-dispersion Sharpe semantics', () => {
  const empty = makeEngine();
  assert.equal(empty.performance().metricsVersion, 2);
  assert.equal(empty.performance().sharpeRatio, 0);

  const one = makeEngine();
  closeTrade(one, 1, { pnl: 0.1 });
  assert.equal(one.exportDurableState().lifetimeSummary.returnMean, 0.1);
  assert.equal(one.exportDurableState().lifetimeSummary.returnM2, 0);
  assert.equal(one.performance().sharpeRatio, 0);

  const identical = makeEngine();
  for (let index = 0; index < 1000; index++) closeTrade(identical, index, { pnl: 0.1 });
  assert.equal(identical.history(10000).length, 500);
  assert.equal(identical.stats().closedTrades, 1000);
  assert.equal(identical.performance().metricsVersion, 2);
  assert.equal(identical.performance().sharpeRatio, 0);
});

test('V2 Welford state equals a direct ordered reference for varied returns', () => {
  const engine = makeEngine();
  const returns = [];
  for (let index = 0; index < 1500; index++) {
    const pnl = [0.000001, -0.000002, 0.01, -0.01, 2.75, -3.25, 29.3, -29.3][index % 8];
    returns.push(closeTrade(engine, index, { pnl }).pnlPercent);
  }
  const expected = welford(returns);
  const summary = engine.exportDurableState().lifetimeSummary;
  assert.equal(summary.returnMean, expected.mean);
  assert.equal(summary.returnM2, expected.m2);
  assert.equal(engine.performance().sharpeRatio, stableSharpe(returns));
});
