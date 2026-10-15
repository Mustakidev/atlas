const test = require('node:test');
const assert = require('node:assert/strict');

const { PaperTradingEngine } = require('../../src/engine/paperTrading');
const { AdvanceRiskEngine } = require('../../src/engine/advanceRisk');
const { CandleEngine } = require('../../src/engine/candles');
const { createExecutionPipeline } = require('../../src/core/executionPipeline');
const { registerLiveSnapshotHandler } = require('../../src/core/liveSnapshot');
const { BinanceMarketData } = require('../../src/network/binanceMarketData');
const { HistoryEngine } = require('../../src/engine/history');
const { EventBus } = require('../../src/core/eventBus');

const logger = { info() {}, warn() {}, error() {}, system() {} };
const HOUR = 3_600_000;
const MINUTE = 60_000;
const BASE = Date.parse('2026-10-15T10:00:00.000Z');
const BUY_PLAN = { stopLoss: 99_500, takeProfit: 101_500, positionSize: 0.2, riskReward: 3 };

function clockAt(nowMs) {
  let monotonic = 0;
  return { nowMs: () => nowMs, monotonicMs: () => ++monotonic };
}

function openBuy(engine, entryMs, plan = BUY_PLAN) {
  const trade = engine.signal({}, 100_000, '1h', 'BUY', plan, { nowMs: entryMs });
  assert.ok(trade);
  return trade;
}

// ---------------------------------------------------------------------------
// Paper trading simulation realism
// ---------------------------------------------------------------------------

test('a candle that began before entry cannot stop out the trade with pre-entry extremes', () => {
  const engine = new PaperTradingEngine({ logger, clock: clockAt(BASE + 30 * MINUTE) });
  openBuy(engine, BASE + 30 * MINUTE);

  // The 10:00 candle dipped to 99,000 at 10:10, before the 10:30 entry.
  const result = engine.onCandle(
    { openTime: BASE, open: 100_200, high: 100_300, low: 99_000, close: 100_000 },
    { nowMs: BASE + 31 * MINUTE },
  );

  assert.equal(result.closed.length, 0);
  assert.equal(engine.open().length, 1);
});

test('a candle that began at or after entry still triggers stop loss', () => {
  const engine = new PaperTradingEngine({ logger, clock: clockAt(BASE) });
  openBuy(engine, BASE);

  const result = engine.onCandle(
    { openTime: BASE + MINUTE, open: 99_900, high: 99_950, low: 99_400, close: 99_450 },
    { nowMs: BASE + 2 * MINUTE },
  );

  assert.equal(result.closed.length, 1);
  assert.equal(result.closed[0].exitReason, 'Stop Loss');
  assert.equal(result.closed[0].exitPrice, 99_500);
});

test('when one candle reaches both stop loss and take profit the loss is recorded', () => {
  const engine = new PaperTradingEngine({ logger, clock: clockAt(BASE) });
  openBuy(engine, BASE);

  const result = engine.onCandle(
    { openTime: BASE, open: 100_000, high: 101_600, low: 99_400, close: 100_000 },
    { nowMs: BASE + HOUR },
  );

  assert.equal(result.closed[0].exitReason, 'Stop Loss');
  assert.ok(result.closed[0].pnl < 0);
});

test('SELL trades resolve a dual-touch candle as a stop loss too', () => {
  const engine = new PaperTradingEngine({ logger, clock: clockAt(BASE) });
  engine.signal({}, 100_000, '1h', 'SELL', {
    stopLoss: 100_500, takeProfit: 98_500, positionSize: 0.2, riskReward: 3,
  }, { nowMs: BASE });

  const result = engine.onCandle(
    { openTime: BASE, open: 100_000, high: 100_600, low: 98_400, close: 100_000 },
    { nowMs: BASE + HOUR },
  );

  assert.equal(result.closed[0].exitReason, 'Stop Loss');
});

test('fees and slippage are charged on both sides of the trade', () => {
  const engine = new PaperTradingEngine({ logger, clock: clockAt(BASE), feePct: 0.1, slippagePct: 0.05 });
  openBuy(engine, BASE);

  const [closed] = engine.evaluateTrades(101_500, { nowMs: BASE + HOUR });
  // Gross: 1,500 * 0.2 = 300. Costs: 0.15% * (100,000 + 101,500) * 0.2 = 60.45.
  assert.equal(closed.pnl, 239.55);
  assert.equal(closed.pnlPercent, 1.2);
  assert.equal(engine.getBalance(), 10_239.55);
});

test('zero-cost engines keep gross PnL', () => {
  const engine = new PaperTradingEngine({ logger, clock: clockAt(BASE) });
  openBuy(engine, BASE);
  const [closed] = engine.evaluateTrades(101_500, { nowMs: BASE + HOUR });
  assert.equal(closed.pnl, 300);
});

test('invalid cost percentages are rejected', () => {
  assert.throws(() => new PaperTradingEngine({ logger, feePct: -0.1 }), /feePct/);
  assert.throws(() => new PaperTradingEngine({ logger, slippagePct: Number.NaN }), /slippagePct/);
});

test('empty performance uses the canonical sortinoRatio key', () => {
  const performance = new PaperTradingEngine({ logger }).performance();
  assert.equal(performance.sortinoRatio, 0);
  assert.equal(Object.hasOwn(performance, 'SortinoRatio'), false);
});

// ---------------------------------------------------------------------------
// Risk sizing
// ---------------------------------------------------------------------------

function riskInput(overrides = {}) {
  return {
    symbol: 'BTCUSDT',
    timeframe: '1h',
    entryPrice: 100_000,
    direction: 'BUY',
    atr: { ready: true, atr: 500, atrPercentage: 0.5 },
    confluence: { confidence: 80 },
    regime: 'TRENDING_BULL',
    nowMs: BASE,
    ...overrides,
  };
}

test('position size follows current paper equity rather than a fixed balance', () => {
  const paper = new PaperTradingEngine({ logger, clock: clockAt(BASE) });
  const risk = new AdvanceRiskEngine({ logger, paperTradeEngine: paper, clock: clockAt(BASE) });
  const before = risk.evaluate(riskInput({ atr: { ready: true, atr: 1_000, atrPercentage: 1 } }));

  paper._balance = 5_000;
  const after = risk.evaluate(riskInput({ atr: { ready: true, atr: 1_000, atrPercentage: 1 } }));

  assert.equal(before.equity, 10_000);
  assert.equal(after.equity, 5_000);
  assert.equal(after.positionSize, before.positionSize / 2);
  assert.ok(after.dollarRisk <= 50);
});

test('a tight stop cannot push notional above equity times MAX_LEVERAGE', () => {
  const paper = new PaperTradingEngine({ logger, clock: clockAt(BASE) });
  const risk = new AdvanceRiskEngine({ logger, paperTradeEngine: paper, clock: clockAt(BASE) });
  // 2 * ATR(100) = 200 stop distance -> 1% risk would need 0.5 BTC = $50,000 notional.
  const result = risk.evaluate(riskInput({ atr: { ready: true, atr: 100, atrPercentage: 0.1 } }));

  assert.equal(result.tradeAllowed, true);
  assert.ok(result.notional <= 10_000);
  assert.equal(result.positionSize, 0.1);
});

test('MAX_LEVERAGE is configurable and validated', () => {
  const config = { get: key => (key === 'MAX_LEVERAGE' ? 2 : undefined) };
  const risk = new AdvanceRiskEngine({ logger, config, clock: clockAt(BASE) });
  const result = risk.evaluate(riskInput({ atr: { ready: true, atr: 100, atrPercentage: 0.1 } }));
  assert.ok(result.notional <= 20_000 && result.notional > 10_000);
  assert.throws(() => new AdvanceRiskEngine({ logger, config: { get: () => -1 }, clock: clockAt(BASE) }), /MAX_LEVERAGE/);
});

// ---------------------------------------------------------------------------
// Execution pipeline exposure cap and exchange-bar lifecycle
// ---------------------------------------------------------------------------

function makePipeline({ paperTradeEngine, config = { get: () => undefined }, nowMs = BASE } = {}) {
  const finalized = Array.from({ length: 20 }, (_, index) => ({
    openTime: BASE - (20 - index) * HOUR, open: 100_000, high: 100_100, low: 99_900, close: 100_000, volume: 1,
  }));
  const riskClosures = [];
  const pipeline = createExecutionPipeline({
    config,
    logger,
    symbol: 'BTCUSDT',
    silent: true,
    candleEngine: { getCandles: () => [...finalized], getActive: () => null },
    regimeEngine: { calculate: () => ({ regime: 'TRENDING_BULL', confidence: 80, trendScore: 80, rangeScore: 20, volatility: 'NORMAL' }) },
    confluenceEngine: { calculate: () => ({ score: 80, bias: 'Bullish', confidence: 80, components: {} }) },
    atrEngine: { calculate: () => ({ ready: true, atr: 250, atrPercentage: 0.25, volatilityLevel: 'Low', volatilityTrend: 'Stable' }) },
    analyzer: { getAnalysis: () => ({ trend: { '1H': 'Bullish' } }) },
    structureEngine: { calculate: () => ({ ready: true, direction: 'bullish', score: 80, structure: 'Bullish' }) },
    indicatorRegistry: { get: () => ({ calculate: () => ({ ready: true, value: 60, trend: 'Above', state: 'Neutral' }) }) },
    macdEngine: { calculate: () => ({ ready: true, trend: 'Bullish' }) },
    bollingerEngine: { calculate: () => ({ ready: true, pricePosition: 'Inside Bands' }) },
    regimeDecisionEngine: { evaluate: () => ({ allowTrade: true, preferredDirection: 'BUY', penalty: 0, reason: 'Allowed' }) },
    mtfConfirmationEngine: { evaluate: () => ({ mtfAllowed: true, rejectionReason: null, confidence: 80, alignmentScore: 100 }) },
    advanceRiskEngine: {
      evaluate: () => ({ tradeAllowed: true, ...BUY_PLAN, session: 'LONDON' }),
      onTradeClosed: pnl => riskClosures.push(pnl),
    },
    mtfEngine: { calculate: () => ({ overallBias: 'Bullish' }) },
    paperTradeEngine,
    clock: clockAt(nowMs),
  });
  return { pipeline, riskClosures };
}

function runAt(pipeline, price, options) {
  pipeline.run({ symbol: 'BTCUSDT', price, timestamp: new Date(BASE).toISOString() }, options);
  return pipeline.getLastDecision();
}

test('a persistent signal opens one position, not a new one every cooldown window', () => {
  let nowMs = BASE;
  const paper = new PaperTradingEngine({ logger, clock: { nowMs: () => nowMs, monotonicMs: () => nowMs } });
  const finalizedNow = () => nowMs;
  const { pipeline } = makePipeline({ paperTradeEngine: paper });
  pipeline.run = pipeline.run.bind(pipeline);

  const opened = [];
  for (let minute = 0; minute < 60; minute++) {
    nowMs = BASE + minute * MINUTE;
    const decision = runAt(pipeline, 100_000);
    if (decision.verdict.tradeOpened) opened.push(finalizedNow());
  }

  assert.equal(paper.open().length, 1);
  assert.equal(opened.length, 1);
  assert.match(pipeline.getLastDecision().verdict.rejectionReason, /Max open positions reached \(1\/1\)/);
});

test('MAX_OPEN_POSITIONS is read from config and must be a positive integer', () => {
  const paper = new PaperTradingEngine({ logger, clock: clockAt(BASE) });
  const config = { get: key => (key === 'MAX_OPEN_POSITIONS' ? 3 : undefined) };
  assert.equal(makePipeline({ paperTradeEngine: paper, config }).pipeline.getPolicy().maxOpenPositions, 3);
  assert.throws(
    () => makePipeline({ paperTradeEngine: paper, config: { get: key => (key === 'MAX_OPEN_POSITIONS' ? 0 : undefined) } }),
    /MAX_OPEN_POSITIONS/,
  );
});

test('exchange bars after entry close a trade inside the hour at 1-minute resolution', () => {
  const paper = new PaperTradingEngine({ logger, clock: clockAt(BASE) });
  openBuy(paper, BASE);
  const { pipeline, riskClosures } = makePipeline({ paperTradeEngine: paper, nowMs: BASE + 3 * MINUTE });

  runAt(pipeline, 99_800, {
    lifecycleCandles: [
      { openTime: BASE, open: 100_000, high: 100_050, low: 99_900, close: 99_950 },
      { openTime: BASE + MINUTE, open: 99_950, high: 99_960, low: 99_450, close: 99_700 },
    ],
  });

  const [closed] = paper.closed();
  assert.equal(closed.exitReason, 'Stop Loss');
  assert.equal(closed.exitPrice, 99_500);
  assert.deepEqual(riskClosures, [closed.pnl]);
});

test('lifecycleCandles must be chronological and cannot be combined with lifecycleCandle', () => {
  const paper = new PaperTradingEngine({ logger, clock: clockAt(BASE) });
  const { pipeline } = makePipeline({ paperTradeEngine: paper });
  const bar = { openTime: BASE, open: 1, high: 1, low: 1, close: 1 };
  assert.throws(() => runAt(pipeline, 100_000, { lifecycleCandles: [bar, bar] }), /chronological/);
  assert.throws(() => runAt(pipeline, 100_000, { lifecycleCandles: [bar], lifecycleCandle: bar }), /not both/);
});

// ---------------------------------------------------------------------------
// Exchange-bar candle aggregation
// ---------------------------------------------------------------------------

function bar(minuteOffset, open, high, low, close, volume = 1) {
  return { openTime: BASE + minuteOffset * MINUTE, open, high, low, close, volume };
}

function candleEngine() {
  return new CandleEngine({ get: key => (key === 'MAX_HISTORY' ? 1500 : undefined) }, logger, 'BTCUSDT');
}

test('1m bars aggregate exactly into higher timeframes', () => {
  const engine = candleEngine();
  engine.ingestBar(bar(0, 100, 105, 99, 104, 2));
  engine.ingestBar(bar(1, 104, 110, 103, 108, 3));
  engine.ingestBar(bar(2, 108, 109, 95, 97, 5));

  assert.deepEqual(engine.getActive('1h'), {
    open: 100, high: 110, low: 95, close: 97, volume: 10,
    openTime: BASE, timestamp: new Date(BASE).toISOString(),
  });
  assert.equal(engine.getCandles('1m').length, 3);
  assert.equal(engine.getActive('1m'), null);
});

test('crossing a bucket boundary finalizes the higher-timeframe candle', () => {
  const engine = candleEngine();
  engine.ingestBar(bar(4, 100, 101, 99, 100));
  const result = engine.ingestBar(bar(5, 100, 102, 98, 101));

  assert.equal(result.finalized['5m'].openTime, BASE);
  assert.equal(engine.getCandles('5m').at(-1).openTime, BASE + 5 * MINUTE);
});

test('re-delivered or older bars are ignored so overlapping batches are safe', () => {
  const engine = candleEngine();
  engine.ingestBar(bar(0, 100, 105, 99, 104, 2));
  assert.equal(engine.ingestBar(bar(0, 100, 105, 99, 104, 2)).ingested, false);
  assert.equal(engine.getActive('1h').volume, 2);
  assert.equal(engine.getLastBarOpenTime(), BASE);
});

test('the forming bar is shown in the active candle but never finalized or double counted', () => {
  const engine = candleEngine();
  engine.ingestBar(bar(0, 100, 105, 99, 104, 2));
  engine.setFormingBar(bar(1, 104, 120, 104, 118, 4));

  assert.equal(engine.getActive('1h').high, 120);
  assert.equal(engine.getActive('1h').volume, 6);

  engine.ingestBar(bar(1, 104, 121, 103, 119, 5));
  assert.equal(engine.getActive('1h').high, 121);
  assert.equal(engine.getActive('1h').volume, 7);
});

test('seeding installs exchange history and the forming candle per timeframe', () => {
  const engine = candleEngine();
  engine.seedTimeframe('1h', [
    { openTime: BASE - 2 * HOUR, open: 1, high: 2, low: 1, close: 2, volume: 1 },
    { openTime: BASE - HOUR, open: 2, high: 3, low: 2, close: 3, volume: 1 },
  ], { openTime: BASE, open: 3, high: 4, low: 3, close: 4, volume: 1 });
  engine.seedTimeframe('1m', [bar(-1, 3, 3, 3, 3)], bar(0, 3, 4, 3, 4));

  assert.equal(engine.getCandles('1h').length, 3);
  assert.equal(engine.getLastBarOpenTime(), BASE - MINUTE);
  assert.throws(() => engine.seedTimeframe('1h', [bar(1, 1, 1, 1, 1)]), /aligned/);
});

test('tick ingestion no longer accumulates provider 24h volume into candles', () => {
  const engine = candleEngine();
  engine.ingest({ price: 100, volume: 30_000_000_000, timestamp: new Date(BASE).toISOString() });
  engine.ingest({ price: 101, volume: 30_000_000_000, timestamp: new Date(BASE + 30_000).toISOString() });
  assert.equal(engine.getActive('1h').volume, 0);
});

// ---------------------------------------------------------------------------
// Binance market data client
// ---------------------------------------------------------------------------

function klineRow(openTime, interval = MINUTE, values = ['100.0', '101.0', '99.0', '100.5', '12.5']) {
  return [openTime, ...values, openTime + interval - 1, '0', 1, '0', '0', '0'];
}

function ticker() {
  return {
    symbol: 'BTCUSDT', lastPrice: '100.75', openPrice: '98.0', highPrice: '102.0',
    lowPrice: '97.0', quoteVolume: '123456.7', priceChangePercent: '-1.25',
  };
}

function makeClient(handler, nowMs = BASE + 2 * MINUTE + 5_000) {
  const urls = [];
  const fetch = async url => {
    urls.push(url);
    const body = handler(new URL(url));
    return { status: 200, async json() { return body; } };
  };
  const retry = { execute: fn => fn() };
  const config = { get: key => ({ SYMBOL: 'BTCUSDT', REQUEST_TIMEOUT: 1000 })[key] };
  return { client: new BinanceMarketData({ fetch, config, logger, retry, clock: { nowMs: () => nowMs } }), urls };
}

test('live fetch splits closed bars from the forming bar and reads the ticker', async () => {
  const { client, urls } = makeClient(url => (url.pathname === '/api/v3/klines'
    ? [klineRow(BASE + MINUTE), klineRow(BASE + 2 * MINUTE)]
    : ticker()));

  const result = await client.fetchMarketData({ sinceOpenTime: BASE });

  assert.equal(result.status, 'FRESH');
  assert.equal(result.snapshot.price, 100.75);
  assert.equal(result.snapshot.change24h, -1.25);
  assert.deepEqual(result.snapshot.bars.map(b => b.openTime), [BASE + MINUTE]);
  assert.equal(result.snapshot.forming.openTime, BASE + 2 * MINUTE);
  const klineUrl = new URL(urls.find(url => url.includes('/klines')));
  assert.equal(klineUrl.searchParams.get('startTime'), String(BASE + MINUTE));
  assert.equal(klineUrl.searchParams.get('interval'), '1m');
});

test('malformed provider data is reported, never passed on', async () => {
  const { client } = makeClient(url => (url.pathname === '/api/v3/klines'
    ? [klineRow(BASE, MINUTE, ['100', '99', '101', '100', '1'])]
    : ticker()));
  const result = await client.fetchMarketData({});
  assert.equal(result.status, 'INVALID_PROVIDER_DATA');
  assert.equal(result.snapshot, null);
  assert.equal(client.isConnected(), false);
});

test('provider outages return PROVIDER_UNAVAILABLE', async () => {
  const fetch = async () => ({ status: 503, async json() { return {}; } });
  const client = new BinanceMarketData({
    fetch, logger, retry: { execute: fn => fn() }, config: { get: () => undefined }, clock: { nowMs: () => BASE },
  });
  const result = await client.fetchMarketData({});
  assert.equal(result.status, 'PROVIDER_UNAVAILABLE');
});

test('seeding requests every timeframe at its native interval and pages 1m history', async () => {
  const nowMs = BASE + 5_000;
  const { client, urls } = makeClient(url => {
    const interval = url.searchParams.get('interval');
    const durations = { '1m': MINUTE, '5m': 5 * MINUTE, '15m': 15 * MINUTE, '30m': 30 * MINUTE, '1h': HOUR, '4h': 4 * HOUR, '12h': 12 * HOUR, '1d': 24 * HOUR };
    const duration = durations[interval];
    const limit = Number(url.searchParams.get('limit'));
    const end = url.searchParams.get('endTime') ? Number(url.searchParams.get('endTime')) + 1 : nowMs;
    const lastOpen = Math.floor((end - 1) / duration) * duration;
    return Array.from({ length: limit }, (_, index) => klineRow(lastOpen - (limit - 1 - index) * duration, duration));
  }, nowMs);

  const seed = await client.fetchSeed({ candleLimit: 10, historyBars: 1500 });

  assert.deepEqual(Object.keys(seed.timeframes), ['1m', '5m', '15m', '30m', '1h', '4h', '12h', '24h']);
  assert.equal(seed.timeframes['1h'].closed.length, 10);
  assert.ok(seed.timeframes['1h'].forming);
  assert.equal(seed.history.length, 1500);
  for (let index = 1; index < seed.history.length; index++) {
    assert.equal(seed.history[index].openTime - seed.history[index - 1].openTime, MINUTE);
  }
  assert.ok(urls.some(url => url.includes('interval=1d')));
});

// ---------------------------------------------------------------------------
// Live snapshot handler in exchange-bar mode
// ---------------------------------------------------------------------------

test('bar snapshots feed candles, analyzer history, and the pipeline lifecycle', () => {
  const engine = candleEngine();
  engine.seedTimeframe('1m', [bar(-1, 100, 100, 100, 100)]);
  const history = new HistoryEngine({ get: () => 1500 }, logger, 'BTCUSDT');
  const runs = [];
  const eventBus = new EventBus();
  registerLiveSnapshotHandler({
    eventBus,
    history,
    analyzer: { analyze() {} },
    signalHistoryEngine: { record() {} },
    executionPipeline: { run: (snapshot, options) => runs.push({ snapshot, options }) },
    candleEngine: engine,
    logger,
  });

  eventBus.emit('market:snapshot', {
    symbol: 'BTCUSDT',
    exchange: 'Binance',
    price: 102,
    volume: 5,
    change24h: 1,
    timestamp: new Date(BASE + 2 * MINUTE).toISOString(),
    bars: [bar(-1, 100, 100, 100, 100), bar(0, 100, 101, 99, 100.5), bar(1, 100.5, 102, 100, 101.5)],
    forming: bar(2, 101.5, 102, 101, 102),
  });

  assert.equal(history.size(), 2);
  assert.equal(history.latest().price, 101.5);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].snapshot.price, 102);
  assert.deepEqual(runs[0].options.lifecycleCandles.map(c => c.openTime), [BASE, BASE + MINUTE]);
  assert.equal(engine.getActive('1h').close, 102);
});
