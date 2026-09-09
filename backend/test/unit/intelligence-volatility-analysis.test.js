const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { analyzeVolatility } = require('../../src/intelligence/volatilityAnalysis');
const { computeRawAtr } = require('../../src/engine/atrCore');

const HOUR_MS = 60 * 60 * 1000;
const START_TIME = Date.UTC(2024, 0, 1);
const POLICY = {
  schemaVersion: 1,
  period: 2,
  timeframe: { id: '1h', expectedIntervalMs: HOUR_MS },
  level: { method: 'FIXED', lowMaxAtrPercent: 1, highMinAtrPercent: 3 },
  trend: { comparisonWindow: 2, compressingRatio: 0.95, expandingRatio: 1.05 },
};

function candle(range, index, close = 100, overrides = {}) {
  const openTime = START_TIME + index * HOUR_MS;
  return {
    open: close,
    high: close + range / 2,
    low: close - range / 2,
    close,
    openTime,
    timestamp: new Date(openTime).toISOString(),
    ...overrides,
  };
}

function candlesFrom(ranges, closes = null, options = {}) {
  return ranges.map((range, index) => candle(
    range,
    index,
    closes ? closes[index] : 100,
    options[index] || {},
  ));
}

function policy(overrides = {}) {
  return {
    ...POLICY,
    timeframe: { ...POLICY.timeframe },
    level: { ...POLICY.level },
    trend: { ...POLICY.trend },
    ...overrides,
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertIssue(result, code, pathName = undefined) {
  assert.equal(result.status, 'INVALID_INPUT');
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].code, code);
  if (pathName !== undefined) assert.equal(result.issues[0].path, pathName);
}

function assertStableVolatilitySchema(result) {
  assert.ok(Object.hasOwn(result, 'schemaVersion'));
  assert.ok(Object.hasOwn(result, 'status'));
  assert.ok(Object.hasOwn(result, 'asOf'));
  assert.ok(Object.hasOwn(result, 'timeframe'));
  assert.ok(Object.hasOwn(result.timeframe, 'id'));
  assert.ok(Object.hasOwn(result.timeframe, 'expectedIntervalMs'));
  assert.ok(Object.hasOwn(result, 'volatility'));
  assert.ok(Object.hasOwn(result.volatility, 'atr'));
  assert.ok(Object.hasOwn(result.volatility, 'atrPercent'));
  assert.ok(Object.hasOwn(result.volatility, 'level'));
  assert.ok(Object.hasOwn(result.volatility, 'trend'));
  assert.ok(Object.hasOwn(result.volatility, 'evidence'));
  assert.ok(Object.hasOwn(result.volatility.evidence, 'level'));
  assert.ok(Object.hasOwn(result.volatility.evidence.level, 'method'));
  assert.ok(Object.hasOwn(result.volatility.evidence.level, 'lowMaxAtrPercent'));
  assert.ok(Object.hasOwn(result.volatility.evidence.level, 'highMinAtrPercent'));
  assert.ok(Object.hasOwn(result.volatility.evidence.level, 'observedAtrPercent'));
  assert.ok(Object.hasOwn(result.volatility.evidence, 'trend'));
  assert.ok(Object.hasOwn(result.volatility.evidence.trend, 'comparisonWindow'));
  assert.ok(Object.hasOwn(result.volatility.evidence.trend, 'sampleCount'));
  assert.ok(Object.hasOwn(result.volatility.evidence.trend, 'baselineAtrPercent'));
  assert.ok(Object.hasOwn(result.volatility.evidence.trend, 'ratio'));
  assert.ok(Object.hasOwn(result.volatility.evidence.trend, 'compressingRatio'));
  assert.ok(Object.hasOwn(result.volatility.evidence.trend, 'expandingRatio'));
  assert.ok(Object.hasOwn(result, 'issues'));

  function assertNoUndefined(value, valuePath) {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        assert.notEqual(value[index], undefined, `${valuePath}[${index}]`);
        assertNoUndefined(value[index], `${valuePath}[${index}]`);
      }
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const key of Object.keys(value)) {
      assert.notEqual(value[key], undefined, `${valuePath}.${key}`);
      assertNoUndefined(value[key], `${valuePath}.${key}`);
    }
  }

  assertNoUndefined(result, 'result');
}

test('accepts constant, low-range, and high-range candles', () => {
  const constant = analyzeVolatility(candlesFrom([1, 1, 1]), policy({
    trend: { ...POLICY.trend, comparisonWindow: 1 },
  }));
  const low = analyzeVolatility(candlesFrom([0.5, 0.5, 0.5]), policy({
    trend: { ...POLICY.trend, comparisonWindow: 1 },
  }));
  const high = analyzeVolatility(candlesFrom([4, 4, 4]), policy({
    trend: { ...POLICY.trend, comparisonWindow: 1 },
  }));

  assert.equal(constant.status, 'READY');
  assert.equal(constant.volatility.level, 'LOW');
  assert.equal(low.volatility.level, 'LOW');
  assert.equal(high.volatility.level, 'HIGH');
});

test('delegates gap-aware raw ATR and preserves normalized precision', () => {
  const candles = candlesFrom([2, 4, 6], [100, 110, 120]);
  const result = analyzeVolatility(candles, policy({
    timeframe: { id: 'gap-aware', expectedIntervalMs: null },
    trend: { ...POLICY.trend, comparisonWindow: 1 },
  }));
  const expected = computeRawAtr(candles, 2);

  assert.equal(result.status, 'READY');
  assert.equal(result.volatility.atr, expected.atr);
  assert.equal(result.volatility.atrPercent, expected.atrPercent);
  assert.equal(result.volatility.atrPercent, (expected.atr / 120) * 100);

  const precise = analyzeVolatility(candlesFrom([1, 2, 3, 4]), policy({
    period: 3,
    level: { method: 'FIXED', lowMaxAtrPercent: 2.66, highMinAtrPercent: 2.67 },
    trend: { ...POLICY.trend, comparisonWindow: 1 },
  }));
  assert.equal(precise.volatility.atrPercent, 8 / 3);
  assert.equal(precise.volatility.level, 'NORMAL');
});

test('classifies exact LOW, NORMAL, and HIGH fixed boundaries', () => {
  const low = analyzeVolatility(candlesFrom([1, 1, 1]), policy({
    trend: { ...POLICY.trend, comparisonWindow: 1 },
  }));
  const normal = analyzeVolatility(candlesFrom([2, 2, 2]), policy({
    trend: { ...POLICY.trend, comparisonWindow: 1 },
  }));
  const high = analyzeVolatility(candlesFrom([3, 3, 3]), policy({
    trend: { ...POLICY.trend, comparisonWindow: 1 },
  }));

  assert.equal(low.volatility.level, 'LOW');
  assert.equal(normal.volatility.level, 'NORMAL');
  assert.equal(high.volatility.level, 'HIGH');
  assert.equal(low.volatility.evidence.level.observedAtrPercent, 1);
  assert.equal(high.volatility.evidence.level.observedAtrPercent, 3);
});

test('rejects unsupported and malformed policies without defaults', () => {
  const cases = [
    [{ ...POLICY, schemaVersion: 2 }, 'policy.schemaVersion'],
    [{ ...POLICY, period: undefined }, 'policy.period'],
    [{ ...POLICY, period: 0 }, 'policy.period'],
    [{ ...POLICY, period: -1 }, 'policy.period'],
    [{ ...POLICY, period: 1.5 }, 'policy.period'],
    [{ ...POLICY, timeframe: { id: '', expectedIntervalMs: null } }, 'policy.timeframe.id'],
    [{ ...POLICY, timeframe: { id: '1h', expectedIntervalMs: 0 } }, 'policy.timeframe.expectedIntervalMs'],
    [{ ...POLICY, timeframe: { id: '1h', expectedIntervalMs: Infinity } }, 'policy.timeframe.expectedIntervalMs'],
    [{ ...POLICY, level: { ...POLICY.level, method: 'PERCENTILE' } }, 'policy.level.method'],
    [{ ...POLICY, level: { ...POLICY.level, method: 'OTHER' } }, 'policy.level.method'],
    [{ ...POLICY, level: { ...POLICY.level, lowMaxAtrPercent: -1 } }, 'policy.level.lowMaxAtrPercent'],
    [{ ...POLICY, level: { ...POLICY.level, lowMaxAtrPercent: Infinity } }, 'policy.level.lowMaxAtrPercent'],
    [{ ...POLICY, level: { ...POLICY.level, highMinAtrPercent: 1 } }, 'policy.level.highMinAtrPercent'],
    [{ ...POLICY, trend: { ...POLICY.trend, comparisonWindow: 0 } }, 'policy.trend.comparisonWindow'],
    [{ ...POLICY, trend: { ...POLICY.trend, compressingRatio: 0 } }, 'policy.trend.compressingRatio'],
    [{ ...POLICY, trend: { ...POLICY.trend, compressingRatio: 1 } }, 'policy.trend.compressingRatio'],
    [{ ...POLICY, trend: { ...POLICY.trend, expandingRatio: 1 } }, 'policy.trend.expandingRatio'],
    [{ ...POLICY, trend: { ...POLICY.trend, expandingRatio: Infinity } }, 'policy.trend.expandingRatio'],
  ];

  for (const [invalidPolicy, expectedPath] of cases) {
    const result = analyzeVolatility(candlesFrom([1, 1, 1]), invalidPolicy);
    assertStableVolatilitySchema(result);
    assert.equal(result.issues[0].path, expectedPath);
    assert.equal(result.volatility.atr, null);
    assert.equal(result.volatility.level, 'UNKNOWN');
  }
  assertIssue(
    analyzeVolatility(candlesFrom([1, 1, 1]), { ...POLICY, level: { ...POLICY.level, method: 'PERCENTILE' } }),
    'UNSUPPORTED_LEVEL_METHOD',
  );
});

test('rejects malformed OHLC, non-finite values, and non-positive closes', () => {
  const invalidCases = [
    [candle(1, 0, 100, { open: NaN }), 'candles[0].open'],
    [candle(1, 0, 100, { high: Infinity }), 'candles[0].high'],
    [candle(1, 0, 100, { high: 99 }), 'candles[0].high'],
    [candle(1, 0, 100, { high: 102, low: 101 }), 'candles[0].low'],
    [candle(1, 0, 0), 'candles[0].close'],
    [candle(1, 0, -1), 'candles[0].close'],
  ];

  for (const [badCandle, expectedPath] of invalidCases) {
    const result = analyzeVolatility([badCandle], POLICY);
    assertStableVolatilitySchema(result);
    assertIssue(result, 'INVALID_CANDLE', expectedPath);
  }
  assertIssue(analyzeVolatility(null, POLICY), 'INVALID_CANDLE', 'candles');
});

test('rejects timestamp identity, ordering, cadence, and active-candle violations', () => {
  const mismatch = candle(1, 0, 100, { timestamp: new Date(START_TIME + 1).toISOString() });
  assertIssue(analyzeVolatility([mismatch], POLICY), 'INVALID_TIMESTAMP', 'candles[0].timestamp');

  const duplicate = candlesFrom([1, 1], null, [{}, { openTime: START_TIME, timestamp: new Date(START_TIME).toISOString() }]);
  assertIssue(analyzeVolatility(duplicate, POLICY), 'DUPLICATE_TIMESTAMP', 'candles[1].openTime');

  const outOfOrder = candlesFrom([1, 1], null, [{}, { openTime: START_TIME - HOUR_MS, timestamp: new Date(START_TIME - HOUR_MS).toISOString() }]);
  assertIssue(analyzeVolatility(outOfOrder, POLICY), 'OUT_OF_ORDER_TIMESTAMP', 'candles[1].openTime');

  const gap = candlesFrom([1, 1, 1], null, [
    {},
    { openTime: START_TIME + 2 * HOUR_MS, timestamp: new Date(START_TIME + 2 * HOUR_MS).toISOString() },
    { openTime: START_TIME + 3 * HOUR_MS, timestamp: new Date(START_TIME + 3 * HOUR_MS).toISOString() },
  ]);
  assertIssue(analyzeVolatility(gap, POLICY), 'CADENCE_MISMATCH', 'candles[1].openTime');
  assert.equal(analyzeVolatility(gap, policy({ timeframe: { id: '1h', expectedIntervalMs: null } })).status, 'READY');

  for (const marker of [{ isFinalized: false }, { active: true }, { closed: false }]) {
    assertIssue(
      analyzeVolatility(candlesFrom([1, 1, 1], null, [marker, {}, {}]), POLICY),
      'ACTIVE_CANDLE',
      'candles[0]',
    );
  }
  assert.equal(analyzeVolatility(candlesFrom([1, 1, 1]), POLICY).status, 'READY');
});

test('preserves stable schema for insufficient history and exact current readiness', () => {
  const insufficient = analyzeVolatility(candlesFrom([1, 1]), POLICY);
  assert.equal(insufficient.status, 'INSUFFICIENT_DATA');
  assert.equal(insufficient.asOf, new Date(START_TIME + HOUR_MS).toISOString());
  assert.equal(insufficient.volatility.atr, null);
  assert.equal(insufficient.volatility.level, 'UNKNOWN');
  assert.equal(insufficient.volatility.evidence.trend.comparisonWindow, 2);
  assert.equal(insufficient.issues[0].code, 'INSUFFICIENT_ATR_HISTORY');
  assertStableVolatilitySchema(insufficient);

  const exactCurrent = analyzeVolatility(candlesFrom([1, 1, 1]), POLICY);
  assert.equal(exactCurrent.status, 'READY');
  assert.equal(exactCurrent.volatility.atr, 1);
  assert.equal(exactCurrent.volatility.trend, 'UNKNOWN');
  assert.equal(exactCurrent.volatility.evidence.trend.sampleCount, 0);
  assert.equal(exactCurrent.issues[0].code, 'INSUFFICIENT_TREND_BASELINE');
  assert.notEqual(exactCurrent.volatility.atr, null);
  assert.notEqual(exactCurrent.volatility.atrPercent, null);
  assert.notEqual(exactCurrent.volatility.level, 'UNKNOWN');
  assertStableVolatilitySchema(exactCurrent);
});

test('classifies full causal trend baselines and independent combinations', () => {
  const expanding = analyzeVolatility(candlesFrom([1, 1, 1, 1, 4]), POLICY);
  const compressing = analyzeVolatility(candlesFrom([4, 4, 4, 4, 1]), POLICY);
  const stable = analyzeVolatility(candlesFrom([2, 2, 2, 2, 2]), POLICY);
  const highCompressing = analyzeVolatility(candlesFrom([4, 4, 4, 4, 1]), policy({
    level: { method: 'FIXED', lowMaxAtrPercent: 1, highMinAtrPercent: 2 },
  }));
  const lowExpanding = analyzeVolatility(candlesFrom([0.1, 0.1, 0.1, 0.1, 0.4]), POLICY);

  assert.equal(expanding.volatility.trend, 'EXPANDING');
  assert.equal(compressing.volatility.trend, 'COMPRESSING');
  assert.equal(stable.volatility.trend, 'STABLE');
  assert.equal(highCompressing.volatility.level, 'HIGH');
  assert.equal(highCompressing.volatility.trend, 'COMPRESSING');
  assert.equal(lowExpanding.volatility.level, 'LOW');
  assert.equal(lowExpanding.volatility.trend, 'EXPANDING');
  assert.equal(stable.volatility.evidence.trend.sampleCount, 2);
  assertStableVolatilitySchema(stable);
});

test('excludes current ATR and uses each prior prefix causally', () => {
  const exclusionPolicy = policy({
    trend: { comparisonWindow: 2, compressingRatio: 0.5, expandingRatio: 2 },
  });
  const exclusion = analyzeVolatility(candlesFrom([1, 1, 1, 1, 4]), exclusionPolicy);
  assert.equal(exclusion.volatility.trend, 'EXPANDING');
  assert.equal(exclusion.volatility.evidence.trend.baselineAtrPercent, 1);

  const ownPrefix = analyzeVolatility(candlesFrom([1, 1, 1, 1, 4, 8]), POLICY);
  assert.equal(ownPrefix.volatility.evidence.trend.sampleCount, 2);
  assert.equal(ownPrefix.volatility.evidence.trend.baselineAtrPercent, 1.75);

  const partial = analyzeVolatility(candlesFrom([1, 1, 1, 4]), policy({
    trend: { ...POLICY.trend, comparisonWindow: 3 },
  }));
  assert.equal(partial.status, 'READY');
  assert.equal(partial.volatility.evidence.trend.sampleCount, 1);
  assert.equal(partial.volatility.evidence.trend.baselineAtrPercent, null);
  assert.equal(partial.issues[0].code, 'INSUFFICIENT_TREND_BASELINE');
  assertStableVolatilitySchema(partial);
});

test('rejects safe-integer timestamps outside the Date TimeClip range without throwing', () => {
  const openTime = 8640000000000001;
  assert.equal(Number.isSafeInteger(openTime), true);
  const invalidCandle = candle(1, 0, 100, { openTime, timestamp: 'not-canonical' });
  let result;

  assert.doesNotThrow(() => {
    result = analyzeVolatility([invalidCandle], POLICY);
  });
  assertIssue(result, 'INVALID_TIMESTAMP', 'candles[0].openTime');
  assert.equal(result.asOf, null);
  assertStableVolatilitySchema(result);
});

test('keeps a zero ATR baseline UNKNOWN without ratio leakage or fallback', () => {
  const result = analyzeVolatility(candlesFrom([0, 0, 0, 0, 0]), POLICY);

  assert.equal(result.status, 'READY');
  assert.equal(result.volatility.atr, 0);
  assert.equal(result.volatility.atrPercent, 0);
  assert.equal(result.volatility.level, 'LOW');
  assert.equal(result.volatility.trend, 'UNKNOWN');
  assert.equal(result.volatility.evidence.trend.baselineAtrPercent, 0);
  assert.equal(result.volatility.evidence.trend.ratio, null);
  assert.deepEqual(result.issues, []);
  assertStableVolatilitySchema(result);
});

test('handles a naturally non-finite prior ATR percentage defensively', () => {
  const result = analyzeVolatility(candlesFrom([1, 1, 1, 1], [100, 100, Number.MIN_VALUE, 100]), POLICY);

  assert.equal(result.status, 'READY');
  assert.equal(Number.isFinite(result.volatility.atr), true);
  assert.equal(Number.isFinite(result.volatility.atrPercent), true);
  assert.equal(result.volatility.trend, 'UNKNOWN');
  assert.equal(result.volatility.evidence.trend.sampleCount, 0);
  assert.equal(result.volatility.evidence.trend.baselineAtrPercent, null);
  assert.equal(result.volatility.evidence.trend.ratio, null);
  assert.equal(result.issues[0].code, 'NON_FINITE_ATR');
  assertStableVolatilitySchema(result);
});

test('guards non-finite ATR results and keeps invalid output fail-closed', () => {
  const extreme = Array.from({ length: 3 }, (_, index) => candle(1, index, 1, {
    high: Number.MAX_VALUE,
    low: -Number.MAX_VALUE,
  }));
  const result = analyzeVolatility(extreme, POLICY);

  assertIssue(result, 'NON_FINITE_ATR', 'volatility');
  assert.equal(result.volatility.atr, null);
  assert.equal(result.volatility.atrPercent, null);
  assert.equal(Number.isFinite(result.volatility.evidence.level.observedAtrPercent), false);
});

test('is deterministic, causal, immutable, and independent of metadata', () => {
  const candles = candlesFrom([1, 1, 1, 4, 4], null, [{ nested: { source: 'fixture' } }, {}, {}, {}, {}]);
  const candlesBefore = clone(candles);
  const configured = policy();
  const policyBefore = clone(configured);
  const first = analyzeVolatility(candles, configured);
  const second = analyzeVolatility(candles, configured);
  assert.deepEqual(first, second);
  assert.deepEqual(candles, candlesBefore);
  assert.deepEqual(configured, policyBefore);

  const prefix = candles.slice(0, 3);
  const prefixResult = analyzeVolatility(prefix, configured);
  const futureA = prefix.concat(candlesFrom([20, 30]).map((value, index) => ({
    ...value,
    openTime: START_TIME + (index + 3) * HOUR_MS,
    timestamp: new Date(START_TIME + (index + 3) * HOUR_MS).toISOString(),
  })));
  const futureB = prefix.concat(candlesFrom([50, 60]).map((value, index) => ({
    ...value,
    openTime: START_TIME + (index + 3) * HOUR_MS,
    timestamp: new Date(START_TIME + (index + 3) * HOUR_MS).toISOString(),
  })));
  assert.deepEqual(analyzeVolatility(prefix, configured), prefixResult);
  assert.deepEqual(analyzeVolatility(futureA.slice(0, prefix.length), configured), prefixResult);
  assert.deepEqual(analyzeVolatility(futureB.slice(0, prefix.length), configured), prefixResult);

  const metadataA = analyzeVolatility(prefix, policy({ timeframe: { id: 'A', expectedIntervalMs: null } }));
  const metadataB = analyzeVolatility(prefix, policy({ timeframe: { id: 'B', expectedIntervalMs: null } }));
  assert.equal(metadataA.volatility.atr, metadataB.volatility.atr);
  assert.equal(metadataA.volatility.trend, metadataB.volatility.trend);

  const originalNow = Date.now;
  try {
    Date.now = () => 1;
    const firstAtOldClock = analyzeVolatility(prefix, configured);
    Date.now = () => 9999999999999;
    assert.deepEqual(analyzeVolatility(prefix, configured), firstAtOldClock);
  } finally {
    Date.now = originalNow;
  }
});

test('maintains deterministic issue ordering and stable fail-closed schema', () => {
  const malformed = candle(1, 0, 100, { high: 99, active: true });
  const result = analyzeVolatility([malformed], POLICY);
  assertIssue(result, 'INVALID_CANDLE', 'candles[0].high');

  const duplicate = candlesFrom([1, 1], null, [{}, {
    openTime: START_TIME,
    timestamp: new Date(START_TIME).toISOString(),
  }]);
  const duplicateResult = analyzeVolatility(duplicate, POLICY);
  assertIssue(duplicateResult, 'DUPLICATE_TIMESTAMP', 'candles[1].openTime');
  assert.deepEqual(Object.keys(result), [
    'schemaVersion', 'status', 'asOf', 'timeframe', 'volatility', 'issues',
  ]);
  assert.deepEqual(Object.keys(result.volatility), [
    'atr', 'atrPercent', 'level', 'trend', 'evidence',
  ]);
  assertStableVolatilitySchema(result);
});

test('does not import legacy volatility runtime components', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../../src/intelligence/volatilityAnalysis.js'),
    'utf8',
  );
  assert.match(source, /atrCore/);
  assert.doesNotMatch(source, /require\(['"]\.\.\/engine\/atr['"]\)/);
  assert.doesNotMatch(source, /VolatilityClassifier/);
  assert.doesNotMatch(source, /Date\.now/);
  assert.doesNotMatch(source, /Math\.random/);
});
