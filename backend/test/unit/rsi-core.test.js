const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { computeRawRsiFromCloses } = require('../../src/engine/rsiCore');
const legacyExports = require('../../src/engine/indicators/rsi');
const { RSIIndicator, RSI_PERIOD, MIN_CANDLES } = legacyExports;

const FIXED_TIMESTAMP = '2024-01-01T00:00:00.000Z';
const FIXED_OPEN_TIME = Date.parse(FIXED_TIMESTAMP);
const INVESTOPEDIA_CLOSES = [
  44, 44.34, 44.09, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08,
  45.89, 46.03, 45.61, 46.28, 46.28, 46.00, 46.03, 46.41, 46.22, 45.64,
];
const OPERATION_ORDER_CLOSES = [
  100, 101, 100.5, 102, 101.25, 103.5, 102.75, 104, 103.25, 105.5,
  104.75, 106, 105.25, 107.5, 106.75, 108.25, 107.5, 109, 108.125, 110,
];
const SEED_ORDER_CLOSES = [0, 9007199254740992, 4503599627370496, 4503599627370497, 4503599627370498];
const SEED_ORDER_FORWARD_RAW = 66.66666666666666;
const SEED_ORDER_REVERSED_RAW = 66.66666666666667;
const EXACT_30_CLOSES = [100, 103, 96, 96, 96, 96, 96, 96, 96, 96, 96, 96, 96, 96, 96];
const RAW_69_995_CLOSES = [
  100000, 113999, 107998, 107998, 107998, 107998, 107998, 107998,
  107998, 107998, 107998, 107998, 107998, 107998, 107998,
];
const RAW_70_005_CLOSES = [
  100000, 114001, 108002, 108002, 108002, 108002, 108002, 108002,
  108002, 108002, 108002, 108002, 108002, 108002, 108002,
];
const RAW_30_005_CLOSES = [
  100000, 106001, 92002, 92002, 92002, 92002, 92002, 92002,
  92002, 92002, 92002, 92002, 92002, 92002, 92002,
];
const RAW_29_99_CLOSES = [
  100000, 105998, 91996, 91996, 91996, 91996, 91996, 91996,
  91996, 91996, 91996, 91996, 91996, 91996, 91996,
];

function candlesFromCloses(closes, { timestamp = FIXED_TIMESTAMP, openTime = FIXED_OPEN_TIME } = {}) {
  return closes.map(close => ({ close, timestamp, openTime }));
}

function legacyResult(closes, symbol = 'BTCUSDT') {
  return new RSIIndicator(symbol).calculate(candlesFromCloses(closes), '1h');
}

test('rejects non-array closes', () => {
  for (const closes of [null, undefined, {}, 'closes']) {
    assert.throws(
      () => computeRawRsiFromCloses(closes, 14),
      { name: 'TypeError', message: 'RSI closes must be an array' },
    );
  }
});

test('rejects invalid periods', () => {
  for (const period of [undefined, null, 0, -1, 0.5, NaN, Infinity, -Infinity, '14']) {
    assert.throws(
      () => computeRawRsiFromCloses(Array(15).fill(100), period),
      { name: 'TypeError', message: 'RSI period must be a finite positive integer' },
      String(period),
    );
  }
});

test('requires exactly period plus one closes and accepts the boundary', () => {
  assert.throws(
    () => computeRawRsiFromCloses(Array(14).fill(100), 14),
    { name: 'RangeError', message: 'Insufficient close data (14/15)' },
  );
  assert.equal(computeRawRsiFromCloses(Array(15).fill(100), 14), 50);
});

test('returns 100 for monotonic gains', () => {
  assert.equal(computeRawRsiFromCloses(Array.from({ length: 15 }, (_, index) => 100 + index), 14), 100);
});

test('returns 0 for monotonic losses', () => {
  assert.equal(computeRawRsiFromCloses(Array.from({ length: 15 }, (_, index) => 200 - index), 14), 0);
});

test('returns 50 for flat closes', () => {
  assert.equal(computeRawRsiFromCloses(Array(15).fill(100), 14), 50);
});

test('preserves the known Wilder seed calculation', () => {
  assert.equal(computeRawRsiFromCloses([100, 102, 101, 104], 3), 83.33333333333334);
});

test('preserves the known Wilder continuation calculation', () => {
  assert.equal(computeRawRsiFromCloses([100, 102, 101, 104, 103], 3), 66.66666666666667);
});

test('supports a custom period without a hidden period-14 assumption', () => {
  assert.equal(computeRawRsiFromCloses([100, 103, 102, 106], 2), 91.66666666666667);
});

test('preserves the internally anchored Investopedia-style raw and legacy results', () => {
  const raw = computeRawRsiFromCloses(INVESTOPEDIA_CLOSES, 14);
  const legacy = legacyResult(INVESTOPEDIA_CLOSES);

  assert.equal(raw, 60.13716896582762);
  assert.notEqual(raw, Math.round(raw * 100) / 100);
  assert.equal(legacy.value, 60.14);
  assert.equal(legacy.state, 'Neutral');
  assert.equal(legacy.signal, 'Hold');
  assert.equal(legacy.strength, 20);
  assert.equal(legacy.confidence, 50);
});

test('preserves continuation grouping without premature rounding', () => {
  const raw = computeRawRsiFromCloses(OPERATION_ORDER_CLOSES, 14);
  const legacy = legacyResult(OPERATION_ORDER_CLOSES);

  assert.equal(raw, 71.8147890954918);
  assert.notEqual(raw, Math.round(raw * 100) / 100);
  assert.equal(legacy.value, 71.81);
  assert.equal(legacy.state, 'Overbought');
  assert.equal(legacy.signal, 'Possible Pullback');
  assert.equal(legacy.strength, 44);
  assert.equal(legacy.confidence, 50);
});

test('distinguishes forward chronological seed summation from reversed seed summation', () => {
  const raw = computeRawRsiFromCloses(SEED_ORDER_CLOSES, 4);

  assert.notEqual(SEED_ORDER_FORWARD_RAW, SEED_ORDER_REVERSED_RAW);
  assert.equal(raw, SEED_ORDER_FORWARD_RAW);
  assert.notEqual(raw, SEED_ORDER_REVERSED_RAW);
});

test('does not impose close positivity or finite-value validation', () => {
  assert.equal(computeRawRsiFromCloses([0, 1], 1), 100);
  assert.equal(computeRawRsiFromCloses([0, -1], 1), 0);
});

test('is deterministic across repeated calls', () => {
  const closes = [100, 102, 101, 104, 103, 105, 104, 106];

  assert.equal(computeRawRsiFromCloses(closes, 3), computeRawRsiFromCloses(closes, 3));
});

test('does not mutate close input', () => {
  const closes = [100, 102, 101, 104, 103, 105];
  const before = [...closes];

  computeRawRsiFromCloses(closes, 3);

  assert.deepEqual(closes, before);
});

test('historical prefix result depends only on the supplied prefix', () => {
  const prefix = [100, 102, 101, 104, 103];
  const futureA = [105, 104, 106];
  const futureB = [80, 70, 60];
  const historical = computeRawRsiFromCloses(prefix, 3);
  const fullA = computeRawRsiFromCloses(prefix.concat(futureA), 3);
  const fullB = computeRawRsiFromCloses(prefix.concat(futureB), 3);

  assert.equal(historical, 66.66666666666667);
  assert.equal(computeRawRsiFromCloses(prefix, 3), historical);
  assert.notEqual(fullA, fullB);
});

test('core returns only raw numeric RSI without legacy policy fields', () => {
  const result = computeRawRsiFromCloses(INVESTOPEDIA_CLOSES, 14);

  assert.equal(typeof result, 'number');
  assert.equal(result, 60.13716896582762);
});

test('core source has no wall-clock, rounding, or policy behavior', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/engine/rsiCore.js'), 'utf8');

  assert.doesNotMatch(source, /Date\.now|new Date|performance\.now|Math\.random|process\.env/);
  assert.doesNotMatch(source, /Math\.round|toFixed|state|signal|strength|confidence|timestamp|cache/);
});

test('legacy RSI preserves exact edge result contracts', () => {
  assert.deepEqual(legacyResult(Array.from({ length: 15 }, (_, index) => 100 + index)), {
    implemented: true,
    ready: true,
    symbol: 'BTCUSDT',
    value: 100,
    period: 14,
    state: 'Overbought',
    signal: 'Possible Pullback',
    strength: 100,
    confidence: 50,
    timestamp: FIXED_TIMESTAMP,
  });
  assert.deepEqual(legacyResult(Array.from({ length: 15 }, (_, index) => 200 - index)), {
    implemented: true,
    ready: true,
    symbol: 'BTCUSDT',
    value: 0,
    period: 14,
    state: 'Oversold',
    signal: 'Possible Reversal',
    strength: 100,
    confidence: 50,
    timestamp: FIXED_TIMESTAMP,
  });
  assert.deepEqual(legacyResult(Array(15).fill(100)), {
    implemented: true,
    ready: true,
    symbol: 'BTCUSDT',
    value: 50,
    period: 14,
    state: 'Neutral',
    signal: 'Hold',
    strength: 0,
    confidence: 50,
    timestamp: FIXED_TIMESTAMP,
  });
});

test('rounds raw 69.995 to legacy 70.00 and keeps it neutral', () => {
  const raw = computeRawRsiFromCloses(RAW_69_995_CLOSES, 14);
  const result = legacyResult(RAW_69_995_CLOSES);

  assert.equal(raw, 69.995);
  assert.equal(result.value, 70);
  assert.equal(result.state, 'Neutral');
  assert.equal(result.signal, 'Hold');
});

test('classifies raw 70.005 as overbought after legacy rounding', () => {
  const raw = computeRawRsiFromCloses(RAW_70_005_CLOSES, 14);
  const result = legacyResult(RAW_70_005_CLOSES);

  assert.equal(raw, 70.005);
  assert.equal(result.value, 70.01);
  assert.equal(result.state, 'Overbought');
  assert.equal(result.signal, 'Possible Pullback');
});

test('keeps rounded legacy 30.01 neutral for raw 30.00500000000001', () => {
  const raw = computeRawRsiFromCloses(RAW_30_005_CLOSES, 14);
  const result = legacyResult(RAW_30_005_CLOSES);

  assert.equal(raw, 30.00500000000001);
  assert.equal(result.value, 30.01);
  assert.equal(result.state, 'Neutral');
  assert.equal(result.signal, 'Hold');
});

test('classifies raw 29.99000000000001 as oversold after legacy rounding', () => {
  const raw = computeRawRsiFromCloses(RAW_29_99_CLOSES, 14);
  const result = legacyResult(RAW_29_99_CLOSES);

  assert.equal(raw, 29.99000000000001);
  assert.equal(result.value, 29.99);
  assert.equal(result.state, 'Oversold');
  assert.equal(result.signal, 'Possible Reversal');
});

test('preserves exact legacy 30.00 boundary neutrality', () => {
  assert.equal(computeRawRsiFromCloses(EXACT_30_CLOSES, 14), 30);

  const result = legacyResult(EXACT_30_CLOSES);
  assert.equal(result.value, 30);
  assert.equal(result.state, 'Neutral');
  assert.equal(result.signal, 'Hold');
});

test('legacy RSI preserves not-ready, timestamp, cache, info, and export contracts', () => {
  const indicator = new RSIIndicator();
  const missing = indicator.calculate(undefined, '1h');
  const notReady = indicator.calculate([], '1h');
  const ready = indicator.calculate(candlesFromCloses(Array(15).fill(100)), 'custom-timeframe');

  assert.deepEqual(missing, notReady);
  assert.deepEqual(notReady, {
    implemented: true,
    ready: false,
    reason: 'No candle data',
    symbol: 'BTCUSDT',
    value: null,
    period: 14,
    state: null,
    signal: null,
    strength: null,
    confidence: null,
    timestamp: null,
  });
  assert.equal(indicator.calculate(Array(14).fill({ close: 100 }), '1h').reason, 'Insufficient candle history');
  assert.equal(indicator.calculate(candlesFromCloses(Array(15).fill(100), { timestamp: null }), '1h').timestamp, new Date(FIXED_OPEN_TIME).toISOString());
  assert.equal(indicator._period, RSI_PERIOD);
  assert.equal(MIN_CANDLES, RSI_PERIOD + 1);
  assert.deepEqual(Object.keys(ready), [
    'implemented', 'ready', 'symbol', 'value', 'period', 'state', 'signal',
    'strength', 'confidence', 'timestamp',
  ]);
  assert.deepEqual(indicator.getInfo(), {
    name: 'RSI',
    description: 'Relative Strength Index — Wilder\'s smoothed 14-period momentum oscillator',
    implemented: true,
    period: RSI_PERIOD,
    minCandles: MIN_CANDLES,
    symbol: 'BTCUSDT',
  });
  assert.doesNotThrow(() => indicator.invalidate('1h'));
  assert.doesNotThrow(() => indicator.invalidate());
  assert.deepEqual(Object.keys(legacyExports), ['RSIIndicator', 'RSI_PERIOD', 'MIN_CANDLES']);
  assert.equal(typeof RSIIndicator, 'function');
});

test('legacy private Wilder seam delegates to the shared core', () => {
  const indicator = new RSIIndicator();
  const closes = OPERATION_ORDER_CLOSES;

  assert.equal(indicator._wilderRSI(closes), computeRawRsiFromCloses(closes, RSI_PERIOD));
});

test('legacy RSI candle input remains immutable', () => {
  const candles = candlesFromCloses(OPERATION_ORDER_CLOSES);
  const before = JSON.parse(JSON.stringify(candles));

  new RSIIndicator().calculate(candles, '1h');

  assert.deepEqual(candles, before);
});

test('legacy RSI contains delegation but no duplicate Wilder arithmetic', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/engine/indicators/rsi.js'), 'utf8');
  const method = source.slice(source.indexOf('  _wilderRSI('), source.indexOf('\n  // ---------------------------------------------------------------------------\n  // Result builders'));

  assert.match(source, /computeRawRsiFromCloses/);
  assert.doesNotMatch(method, /for\s*\(|avgGain|avgLoss|const rs|deltas/);
});
