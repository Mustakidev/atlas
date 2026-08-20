const test = require('node:test');
const assert = require('node:assert/strict');

const { createRouter } = require('../../src/routes/routes');
const { PaperTradingEngine } = require('../../src/engine/paperTrading');

const logger = { info() {}, warn() {}, error() {}, system() {} };
const BUY_PLAN = { stopLoss: 96, takeProfit: 106, positionSize: 25, riskReward: 2.5 };
const SELL_PLAN = { stopLoss: 104, takeProfit: 96, positionSize: 25, riskReward: 2 };

const BULLISH_ENGINES = {
  trend: { trend: { '1H': 'Bullish' } },
  structure: { ready: true, direction: 'bullish', structure: 'Bullish', score: 80 },
  rsi: { ready: true, value: 70, state: 'Overbought' },
  ema: { ready: true, value: 110, trend: 'Above' },
  macd: { ready: true, trend: 'Bullish', histogram: 1 },
  bollinger: { ready: true, pricePosition: 'Inside Bands' },
  confluence: { bias: 'Bullish', score: 80, confidence: 80 },
  mtf: { overallBias: 'Bullish', timeframeAgreement: 100 },
};

const BEARISH_ENGINES = {
  trend: { trend: { '1H': 'Bearish' } },
  structure: { ready: true, direction: 'bearish', structure: 'Bearish', score: -80 },
  rsi: { ready: true, value: 30, state: 'Oversold' },
  ema: { ready: true, value: 90, trend: 'Below' },
  macd: { ready: true, trend: 'Bearish', histogram: -1 },
  bollinger: { ready: true, pricePosition: 'Inside Bands' },
  confluence: { bias: 'Bearish', score: 20, confidence: 80 },
  mtf: { overallBias: 'Bearish', timeframeAgreement: 100 },
};

function makeEngine() {
  return new PaperTradingEngine({ logger, symbol: 'BTCUSDT' });
}

function openTrade(engine, direction = 'BUY') {
  const trade = engine.signal(
    direction === 'BUY' ? BULLISH_ENGINES : BEARISH_ENGINES,
    100,
    '1h',
    direction,
    direction === 'BUY' ? BUY_PLAN : SELL_PLAN
  );
  assert.ok(trade);
  return trade;
}

function activeCandle(close = 100) {
  return { open: close, high: close + 1, low: close - 1, close, timestamp: '2024-01-01T00:00:00.000Z' };
}

function responseHarness(resolve, reject) {
  return {
    statusCode: 200,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    getHeader(name) { return this.headers[name]; },
    status(code) { this.statusCode = code; return this; },
    json(body) { resolve({ statusCode: this.statusCode, body }); return this; },
    end(body) { resolve({ statusCode: this.statusCode, body }); return this; },
  };
}

function dispatch(engine, method, path, body = {}, query = {}) {
  const router = createRouter({
    paperTradeEngine: engine,
    advanceRiskEngine: { onTradeClosed() {} },
    logger,
  });
  const request = { method, url: path, originalUrl: path, path, query, body, headers: {}, ip: '127.0.0.1' };

  return new Promise((resolve, reject) => {
    router.handle(request, responseHarness(resolve, reject), reject);
  });
}

test('signal returns a mutable isolated trade snapshot', () => {
  const engine = makeEngine();
  const opened = openTrade(engine);
  const tradeId = opened.tradeId;

  assert.notEqual(Object.isFrozen(opened), true);
  opened.status = 'CLOSED';
  opened.stopLoss = -999;
  opened.tradeId = 'external-id';

  const current = engine.getTrade(tradeId);
  assert.equal(opened.status, 'CLOSED');
  assert.equal(current.status, 'OPEN');
  assert.equal(current.stopLoss, BUY_PLAN.stopLoss);
  assert.equal(current.tradeId, tradeId);
});

test('onCandle returns an isolated lifecycle result and preserves shape', () => {
  const engine = makeEngine();
  const opened = openTrade(engine);
  const result = engine.onCandle(activeCandle());

  assert.deepEqual(Object.keys(result), ['opened', 'closed']);
  assert.ok(Array.isArray(result.opened));
  assert.ok(Array.isArray(result.closed));
  assert.equal(result.closed.length, 0);

  const closedResult = engine.onCandle({ ...activeCandle(106), high: 107 });
  assert.equal(closedResult.closed.length, 1);
  closedResult.closed[0].status = 'OPEN';
  closedResult.closed[0].pnl = 999999;
  closedResult.closed.push({ tradeId: 'external' });

  assert.equal(engine.getTrade(opened.tradeId).status, 'CLOSED');
  assert.equal(engine.history()[0].status, 'CLOSED');
  assert.notEqual(engine.history()[0].pnl, 999999);
});

test('evaluateTrades returns isolated closed-trade snapshots', () => {
  const engine = makeEngine();
  const opened = openTrade(engine);
  const result = engine.evaluateTrades(106);

  assert.equal(result.length, 1);
  result[0].status = 'OPEN';
  result[0].pnl = -999999;
  result.pop();

  assert.equal(engine.getTrade(opened.tradeId).status, 'CLOSED');
  assert.equal(engine.history().length, 1);
  assert.notEqual(engine.stats().totalPnl, -999999);
});

test('close and invalidate return isolated snapshots and preserve duplicate behavior', () => {
  const engine = makeEngine();
  const manuallyClosed = openTrade(engine);
  const closed = engine.close(manuallyClosed.tradeId, 'Manual');

  assert.ok(closed);
  closed.status = 'OPEN';
  closed.pnl = -123456;
  assert.equal(engine.getTrade(manuallyClosed.tradeId).status, 'CLOSED');
  assert.equal(engine.close(manuallyClosed.tradeId, 'Manual'), null);

  const invalidated = openTrade(engine);
  const invalidatedResult = engine.invalidate(invalidated.tradeId);
  assert.ok(invalidatedResult);
  invalidatedResult.exitReason = 'External';
  assert.equal(engine.getTrade(invalidated.tradeId).exitReason, 'Invalidated');
  assert.equal(engine.invalidate(invalidated.tradeId), null);
  assert.equal(engine.close('missing', 'Manual'), null);
});

test('all, open, pending, closed, and history isolate arrays and elements', () => {
  const engine = makeEngine();
  const opened = openTrade(engine);
  engine._openTrade({
    symbol: 'BTCUSDT',
    timeframe: '1h',
    direction: 'BUY',
    entryPrice: 100,
    stopLoss: 96,
    takeProfit: 106,
    riskReward: 2.5,
    positionSize: 25,
    currentPrice: 100,
    confidence: 80,
    reason: 'pending',
    status: 'PENDING',
  });

  const all = engine.all();
  const open = engine.open();
  const pending = engine.pending();
  assert.notStrictEqual(all, engine.all());
  assert.notStrictEqual(open, engine.open());
  assert.notStrictEqual(pending, engine.pending());

  all.pop();
  all[0].status = 'CLOSED';
  open.pop();
  pending[0].status = 'OPEN';

  assert.equal(engine.all().length, 2);
  assert.equal(engine.getTrade(opened.tradeId).status, 'OPEN');
  assert.equal(engine.pending()[0].status, 'PENDING');

  engine.close(opened.tradeId, 'Manual');
  const closed = engine.closed();
  const history = engine.history();
  assert.notStrictEqual(closed, engine.closed());
  assert.notStrictEqual(history, engine.history());
  assert.notStrictEqual(closed[0], history[0]);
  closed.pop();
  history[0].pnl = 321321;
  assert.equal(engine.closed().length, 1);
  assert.notEqual(engine.stats().totalPnl, 321321);
});

test('getTrade and getLastAnalysis return fresh isolated values', () => {
  const engine = makeEngine();
  const opened = openTrade(engine);
  const firstTrade = engine.getTrade(opened.tradeId);
  const secondTrade = engine.getTrade(opened.tradeId);
  assert.notStrictEqual(firstTrade, secondTrade);
  firstTrade.takeProfit = -1;
  assert.equal(engine.getTrade(opened.tradeId).takeProfit, BUY_PLAN.takeProfit);

  const firstAnalysis = engine.getLastAnalysis();
  const secondAnalysis = engine.getLastAnalysis();
  assert.notStrictEqual(firstAnalysis, secondAnalysis);
  firstAnalysis.direction = 'SELL';
  firstAnalysis.reason = 'External';
  assert.equal(engine.getLastAnalysis().direction, 'BUY');
  assert.notEqual(engine.getLastAnalysis().reason, 'External');

  assert.equal(typeof engine.getBalance(), 'number');
  assert.notStrictEqual(engine.stats(), engine.stats());
  assert.notStrictEqual(engine.performance(), engine.performance());
  assert.notStrictEqual(engine.getInfo(), engine.getInfo());
});

test('earlier snapshots remain stale while fresh queries follow the BUY lifecycle', () => {
  const engine = makeEngine();
  const opened = openTrade(engine);
  const initial = engine.getTrade(opened.tradeId);

  engine.onCandle(activeCandle());
  assert.equal(initial.status, 'OPEN');
  assert.equal(engine.getTrade(opened.tradeId).status, 'ACTIVE');

  engine.onCandle({ ...activeCandle(106), high: 107 });
  assert.equal(initial.status, 'OPEN');
  assert.equal(engine.getTrade(opened.tradeId).status, 'CLOSED');
  assert.equal(engine.history().length, 1);
});

test('SELL lifecycle, balance, statistics, and performance remain correct', () => {
  const engine = makeEngine();
  const opened = openTrade(engine, 'SELL');
  const result = engine.evaluateTrades(96);

  assert.equal(result.length, 1);
  assert.equal(result[0].direction, 'SELL');
  assert.equal(result[0].status, 'CLOSED');
  assert.ok(result[0].pnl > 0);
  assert.equal(engine.stats().closedTrades, 1);
  assert.ok(engine.stats().totalPnl > 0);
  assert.ok(engine.performance().totalPnl > 0);
  assert.ok(engine.getBalance() > 10000);
  assert.equal(engine.getTrade(opened.tradeId).status, 'CLOSED');
});

test('paper-trading API response shapes and close behavior remain unchanged', async () => {
  const engine = makeEngine();
  const opened = openTrade(engine);

  const aggregate = await dispatch(engine, 'GET', '/paper-trades');
  assert.equal(aggregate.statusCode, 200);
  assert.deepEqual(Object.keys(aggregate.body).sort(), ['balance', 'closed', 'open', 'performance', 'stats']);
  assert.ok(Array.isArray(aggregate.body.open));
  assert.ok(Array.isArray(aggregate.body.closed));

  const openResponse = await dispatch(engine, 'GET', '/paper-trades/open');
  const historyResponse = await dispatch(engine, 'GET', '/paper-trades/history', {}, { limit: '10' });
  const statsResponse = await dispatch(engine, 'GET', '/paper-trades/stats');
  const performanceResponse = await dispatch(engine, 'GET', '/paper-trades/performance');
  assert.equal(openResponse.statusCode, 200);
  assert.equal(historyResponse.statusCode, 200);
  assert.equal(statsResponse.statusCode, 200);
  assert.equal(performanceResponse.statusCode, 200);
  assert.ok(Array.isArray(openResponse.body));
  assert.ok(Array.isArray(historyResponse.body));
  assert.equal(typeof statsResponse.body, 'object');
  assert.equal(typeof performanceResponse.body, 'object');

  aggregate.body.open[0].status = 'CLOSED';
  assert.equal(engine.getTrade(opened.tradeId).status, 'OPEN');

  const closeResponse = await dispatch(engine, 'POST', '/paper-trades/close', { tradeId: opened.tradeId });
  assert.equal(closeResponse.statusCode, 200);
  assert.equal(closeResponse.body.status, 'CLOSED');
  closeResponse.body.pnl = 999999;
  assert.notEqual(engine.stats().totalPnl, 999999);
  assert.equal((await dispatch(engine, 'POST', '/paper-trades/close', { tradeId: opened.tradeId })).statusCode, 404);
  assert.equal((await dispatch(engine, 'POST', '/paper-trades/close', {})).statusCode, 400);
});
