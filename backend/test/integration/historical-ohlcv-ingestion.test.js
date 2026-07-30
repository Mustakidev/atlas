const test = require('node:test');
const assert = require('node:assert/strict');

const { CandleEngine, sortHistoricalOhlcRows } = require('../../src/engine/candles');
const { ATREngine } = require('../../src/engine/atr');
const { AdvanceRiskEngine } = require('../../src/engine/advanceRisk');
const { PaperTradingEngine } = require('../../src/engine/paperTrading');

const BASE_TIME = Date.UTC(2024, 0, 1);

function config() {
  return { get(key) { return key === 'MAX_HISTORY' ? 500 : undefined; } };
}

function logger() {
  return { info() {}, warn() {}, error() {} };
}

function historicalCandle(index, overrides = {}) {
  const openTime = BASE_TIME + index * 3600000;
  return {
    open: 99,
    high: 102,
    low: 98,
    close: 100,
    volume: 100 + index,
    openTime,
    timestamp: new Date(openTime).toISOString(),
    ...overrides,
  };
}

function makeEngine(maxHistory = 500) {
  return new CandleEngine({ get(key) { return key === 'MAX_HISTORY' ? maxHistory : undefined; } }, logger(), 'BTCUSDT');
}

test('historical OHLCV is preserved as a finalized candle', () => {
  const engine = makeEngine();
  const input = historicalCandle(0);

  const stored = engine.ingestHistoricalCandle('1h', input);

  assert.deepEqual(stored, input);
  assert.deepEqual(engine.getCandles('1h'), [input]);
  assert.equal(engine.getActive('1h'), null);
  assert.ok(Object.isFrozen(engine.getCandles('1h')[0]));
});

test('caller mutation cannot change the copied frozen candle', () => {
  const engine = makeEngine();
  const input = historicalCandle(0);
  const stored = engine.ingestHistoricalCandle('1h', input);

  input.open = -1;
  input.high = -1;
  input.close = -1;
  input.volume = -1;
  input.timestamp = 'changed';

  assert.deepEqual(stored, historicalCandle(0));
  assert.ok(Object.isFrozen(stored));
});

test('timestamp-only historical input derives the existing openTime identity', () => {
  const engine = makeEngine();
  const input = historicalCandle(0);
  delete input.openTime;

  engine.ingestHistoricalCandle('1h', input);

  assert.equal(engine.getCandles('1h')[0].timestamp, input.timestamp);
  assert.equal(engine.getCandles('1h')[0].openTime, BASE_TIME);
});

test('openTime-only input accepts integer milliseconds and generates the matching timestamp', () => {
  const engine = makeEngine();
  const input = historicalCandle(0);
  delete input.timestamp;

  engine.ingestHistoricalCandle('1h', input);

  assert.equal(engine.getCandles('1h')[0].openTime, BASE_TIME);
  assert.equal(engine.getCandles('1h')[0].timestamp, new Date(BASE_TIME).toISOString());
});

test('matching timestamp and openTime are accepted exactly', () => {
  const engine = makeEngine();
  const input = historicalCandle(0);

  engine.ingestHistoricalCandle('1h', input);

  assert.equal(engine.getCandles('1h')[0].openTime, input.openTime);
  assert.equal(engine.getCandles('1h')[0].timestamp, input.timestamp);
});

test('mismatched timestamp and openTime are rejected without mutation', () => {
  const engine = makeEngine();
  const input = historicalCandle(0, { openTime: BASE_TIME + 1 });

  assert.throws(() => engine.ingestHistoricalCandle('1h', input), /must match/);
  assert.deepEqual(engine.getCandles('1h'), []);
  assert.equal(engine.getActive('1h'), null);
});

test('historical candles retain order, identity, volume, and timestamps', () => {
  const engine = makeEngine();
  const first = historicalCandle(0, { volume: 11 });
  const second = historicalCandle(1, { open: 100, high: 104, low: 97, close: 103, volume: 22 });

  engine.ingestHistoricalCandle('4h', first);
  engine.ingestHistoricalCandle('4h', second);

  assert.deepEqual(engine.getCandles('4h'), [first, second]);
  assert.deepEqual(engine.getCandles('4h').map(candle => candle.openTime), [first.openTime, second.openTime]);
  assert.deepEqual(engine.getCandles('4h').map(candle => candle.volume), [11, 22]);
});

test('historical seed bars use their explicit timeframe and stay finalized', () => {
  const engine = makeEngine();

  engine.ingestHistoricalCandle('4h', historicalCandle(0));

  assert.equal(engine.getCandles('4h').length, 1);
  assert.equal(engine.getCandles('1h').length, 0);
  assert.equal(engine.getActive('4h'), null);

  engine.ingest({ price: 105, high: 999, low: 1, volume: 1, timestamp: new Date(BASE_TIME + 4 * 3600000).toISOString() });

  assert.deepEqual(engine.getCandles('4h')[0], historicalCandle(0));
  assert.equal(engine.getActive('4h').close, 105);
});

test('server seed ordering sorts rows stably without mutating the upstream array', () => {
  const engine = makeEngine();
  const rows = [
    [BASE_TIME + 7200000, 119, 122, 118, 120],
    [BASE_TIME, 99, 102, 98, 100],
    [BASE_TIME + 7200000, 129, 132, 128, 130],
    [BASE_TIME + 3600000, 109, 112, 108, 110],
  ];
  const original = structuredClone(rows);
  const sorted = sortHistoricalOhlcRows(rows);

  for (const [timestamp, open, high, low, close] of sorted) {
    engine.ingestHistoricalCandle('4h', {
      open,
      high,
      low,
      close,
      volume: 0,
      timestamp: new Date(timestamp).toISOString(),
    });
  }

  assert.deepEqual(rows, original);
  assert.deepEqual(engine.getCandles('4h').map(candle => candle.openTime), [
    BASE_TIME,
    BASE_TIME + 3600000,
    BASE_TIME + 7200000,
    BASE_TIME + 7200000,
  ]);
  assert.deepEqual(engine.getCandles('4h').map(candle => candle.close), [100, 110, 120, 130]);
});

test('server seed sorting rejects a non-array OHLC response', () => {
  assert.throws(() => sortHistoricalOhlcRows(null), /must be an array/);
});

test('server seed sorting normalizes mixed numeric timestamp values without mutation', () => {
  const rows = [
    [String(BASE_TIME + 7200000), 119, 122, 118, 120],
    [BASE_TIME, 99, 102, 98, 100],
    [String(BASE_TIME + 7200000), 129, 132, 128, 130],
  ];
  const original = structuredClone(rows);
  const sorted = sortHistoricalOhlcRows(rows);

  assert.equal(sorted[0][0], BASE_TIME);
  assert.equal(typeof sorted[0][0], 'number');
  assert.equal(sorted[1][0], BASE_TIME + 7200000);
  assert.equal(sorted[2][0], BASE_TIME + 7200000);
  assert.equal(new Date(sorted[0][0]).toISOString(), '2024-01-01T00:00:00.000Z');
  assert.deepEqual(rows, original);
  assert.notStrictEqual(sorted[0], rows[1]);
  assert.notStrictEqual(sorted[1], rows[0]);
});

test('server seed sorting rejects invalid timestamp units and values', () => {
  const invalidRows = [
    [[['not-a-number', 99, 102, 98, 100]], /must be numeric/],
    [[[NaN, 99, 102, 98, 100]], /must be finite/],
    [[[Infinity, 99, 102, 98, 100]], /must be finite/],
    [[[BASE_TIME + 0.5, 99, 102, 98, 100]], /integer millisecond/],
    [[[1704067200, 99, 102, 98, 100]], /milliseconds, not seconds/],
  ];

  for (const [rows, message] of invalidRows) {
    assert.throws(() => sortHistoricalOhlcRows(rows), message);
  }
});

test('historical ranged candles produce the expected ATR and valid risk plan', () => {
  const engine = makeEngine();
  for (let index = 0; index < 16; index++) {
    engine.ingestHistoricalCandle('1h', historicalCandle(index));
  }

  const atr = new ATREngine({ candleEngine: engine, logger: logger(), symbol: 'BTCUSDT' }).calculate('1h', 500);
  assert.equal(atr.ready, true);
  assert.equal(atr.atr, 4);
  assert.equal(atr.atrPercentage, 4);

  const risk = new AdvanceRiskEngine({ logger: logger(), symbol: 'BTCUSDT', paperTradeEngine: null, config: { get() {} } });
  const result = risk.evaluate({
    symbol: 'BTCUSDT',
    timeframe: '1h',
    entryPrice: 100,
    direction: 'BUY',
    atr,
    trend: {},
    structure: {},
    confluence: { confidence: 80 },
    regime: 'TRENDING_BULL',
  });

  assert.equal(result.tradeAllowed, true);
  assert.notEqual(result.rejectionReason, 'ATR not ready or invalid');
});

test('preserved historical extremes remain usable by paper-trade lifecycle checks', () => {
  const engine = makeEngine();
  engine.ingestHistoricalCandle('1h', historicalCandle(0));
  const candle = engine.getCandles('1h')[0];
  const paper = new PaperTradingEngine({ logger: logger(), symbol: 'BTCUSDT' });

  const trade = paper.signal({}, 100, '1h', 'BUY', {
    stopLoss: 99,
    takeProfit: 101,
    positionSize: 1,
    riskReward: 2,
  });
  const result = paper.onCandle(candle);

  assert.ok(trade);
  assert.equal(result.closed.length, 1);
  assert.equal(result.closed[0].exitReason, 'Take Profit');
});

test('live tick aggregation remains price-driven despite unrelated snapshot extremes', () => {
  const engine = makeEngine();
  const firstTimestamp = BASE_TIME + 5 * 60000;

  engine.ingest({ price: 100, high: 1000, low: 1, volume: 1, timestamp: new Date(firstTimestamp).toISOString() });
  engine.ingest({ price: 105, high: 2000, low: -100, volume: 1, timestamp: new Date(firstTimestamp + 30000).toISOString() });

  assert.deepEqual(engine.getActive('1m'), {
    open: 100,
    high: 105,
    low: 100,
    close: 105,
    volume: 2,
    openTime: BASE_TIME + 5 * 60000,
    timestamp: new Date(firstTimestamp).toISOString(),
  });
});

test('invalid historical OHLCV is rejected without partial mutation', () => {
  const invalidCandles = [
    historicalCandle(0, { high: NaN }),
    historicalCandle(0, { low: Infinity }),
    historicalCandle(0, { high: 97 }),
    historicalCandle(0, { open: 103 }),
    historicalCandle(0, { close: 97 }),
    historicalCandle(0, { volume: -1 }),
    historicalCandle(0, { volume: NaN }),
    historicalCandle(0, { timestamp: 'not-a-timestamp' }),
    historicalCandle(0, { openTime: NaN }),
    historicalCandle(0, { openTime: Infinity }),
    historicalCandle(0, { openTime: BASE_TIME + 0.5 }),
    historicalCandle(0, { openTime: 1704067200 }),
  ];

  for (const invalid of invalidCandles) {
    const engine = makeEngine();
    assert.throws(() => engine.ingestHistoricalCandle('1h', invalid), TypeError);
    assert.deepEqual(engine.getCandles('1h'), []);
    assert.equal(engine.getActive('1h'), null);
  }
});

test('invalid historical insertion preserves populated finalized and active state', () => {
  const engine = makeEngine();
  const valid = historicalCandle(0);
  engine.ingestHistoricalCandle('1h', valid);
  engine.ingest({ price: 105, volume: 1, timestamp: new Date(BASE_TIME + 3600000).toISOString() });
  const before = engine.getCandles('1h');
  const activeBefore = engine.getActive('1h');

  assert.throws(() => engine.ingestHistoricalCandle('1h', { ...valid, high: 97 }), TypeError);

  assert.deepEqual(engine.getCandles('1h'), before);
  assert.strictEqual(engine.getActive('1h'), activeBefore);
});

test('unsupported timeframe is rejected without state mutation', () => {
  const engine = makeEngine();

  assert.throws(() => engine.ingestHistoricalCandle('2h', historicalCandle(0)), /Invalid historical candle timeframe/);
  assert.deepEqual(engine.getCandles('1h'), []);
  assert.deepEqual(engine.getCandles('4h'), []);
  assert.equal(engine.getActive('1h'), null);
  assert.equal(engine.getActive('4h'), null);
});

test('historical duplicates preserve existing append behavior', () => {
  const engine = makeEngine();
  const first = historicalCandle(0, { close: 100 });
  const duplicate = historicalCandle(0, { close: 101 });

  engine.ingestHistoricalCandle('1h', first);
  engine.ingestHistoricalCandle('1h', duplicate);

  assert.deepEqual(engine.getCandles('1h').map(candle => candle.close), [100, 101]);
});

test('historical out-of-order bars preserve existing arrival-order behavior', () => {
  const engine = makeEngine();
  const first = historicalCandle(0);
  const later = historicalCandle(2);
  const middle = historicalCandle(1);

  engine.ingestHistoricalCandle('1h', first);
  engine.ingestHistoricalCandle('1h', later);
  engine.ingestHistoricalCandle('1h', middle);

  assert.deepEqual(engine.getCandles('1h').map(candle => candle.openTime), [first.openTime, later.openTime, middle.openTime]);
});

test('historical retention keeps the existing storage bound', () => {
  const engine = makeEngine(2);
  engine.ingestHistoricalCandle('1h', historicalCandle(0));
  engine.ingestHistoricalCandle('1h', historicalCandle(1));
  engine.ingestHistoricalCandle('1h', historicalCandle(2));

  assert.deepEqual(engine.getCandles('1h').map(candle => candle.openTime), [historicalCandle(1).openTime, historicalCandle(2).openTime]);
});
