const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { analyzeMomentumRsi } = require('../../src/intelligence/momentumAnalysis');

const HOUR_MS = 60 * 60 * 1000;
const START_TIME = Date.UTC(2024, 0, 1);
const POLICY = {
  schemaVersion: 1,
  timeframe: { id: '1h', expectedIntervalMs: HOUR_MS },
  momentum: {
    window: 1,
    neutralBand: 0.02,
    strength: { weakMaxAbs: 0.03, strongMinAbs: 0.08 },
    change: { comparisonWindow: 1, flatTolerance: 0.01 },
  },
  rsi: {
    period: 2,
    bands: { oversoldMax: 30, lowMax: 40, highMin: 60, overboughtMin: 70 },
    slope: { comparisonWindow: 1, flatTolerance: 0.01 },
  },
};

function clone(value) {
  return structuredClone(value);
}

function policy(overrides = {}) {
  const value = clone(POLICY);
  if (overrides.schemaVersion !== undefined) value.schemaVersion = overrides.schemaVersion;
  if (overrides.timeframe) value.timeframe = { ...value.timeframe, ...overrides.timeframe };
  if (overrides.momentum) {
    const momentum = overrides.momentum;
    value.momentum = {
      ...value.momentum,
      ...momentum,
      strength: { ...value.momentum.strength, ...(momentum.strength || {}) },
      change: { ...value.momentum.change, ...(momentum.change || {}) },
    };
  }
  if (overrides.rsi) {
    const rsi = overrides.rsi;
    value.rsi = {
      ...value.rsi,
      ...rsi,
      bands: { ...value.rsi.bands, ...(rsi.bands || {}) },
      slope: { ...value.rsi.slope, ...(rsi.slope || {}) },
    };
  }
  return value;
}

function candle(close, index, overrides = {}) {
  const openTime = START_TIME + index * HOUR_MS;
  return {
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    openTime,
    timestamp: new Date(openTime).toISOString(),
    ...overrides,
  };
}

function candlesFromCloses(closes, overrides = {}) {
  return closes.map((close, index) => candle(close, index, overrides[index] || {}));
}

function analyze(closes, suppliedPolicy = POLICY, overrides = {}) {
  return analyzeMomentumRsi(candlesFromCloses(closes, overrides), clone(suppliedPolicy));
}

function assertNoUndefined(value, valuePath = 'result') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoUndefined(item, `${valuePath}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') {
    assert.notEqual(value, undefined, valuePath);
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    assert.notEqual(nested, undefined, `${valuePath}.${key}`);
    assertNoUndefined(nested, `${valuePath}.${key}`);
  }
}

function assertFiniteNumbersOrNull(value, valuePath = 'result') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertFiniteNumbersOrNull(item, `${valuePath}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') {
    if (typeof value === 'number') assert.ok(Number.isFinite(value), valuePath);
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    assertFiniteNumbersOrNull(nested, `${valuePath}.${key}`);
  }
}

function assertStableSchema(result) {
  assert.deepEqual(Object.keys(result), [
    'schemaVersion', 'status', 'asOf', 'timeframe', 'momentum', 'rsi', 'issues',
  ]);
  assert.deepEqual(Object.keys(result.timeframe), ['id', 'expectedIntervalMs']);
  assert.deepEqual(Object.keys(result.momentum), ['value', 'state', 'strength', 'change', 'evidence']);
  assert.deepEqual(Object.keys(result.momentum.evidence), [
    'method', 'window', 'referenceIndex', 'referenceTimestamp', 'priorValue',
    'comparisonWindow', 'neutralBand', 'weakMaxAbs', 'strongMinAbs', 'flatTolerance',
  ]);
  assert.deepEqual(Object.keys(result.rsi), ['value', 'state', 'slope', 'evidence']);
  assert.deepEqual(Object.keys(result.rsi.evidence), [
    'method', 'period', 'priorValue', 'comparisonWindow', 'bands', 'flatTolerance',
  ]);
  assert.deepEqual(Object.keys(result.rsi.evidence.bands), [
    'oversoldMax', 'lowMax', 'highMin', 'overboughtMin',
  ]);
  assertNoUndefined(result);
  assertFiniteNumbersOrNull(result);
}

function assertIssue(result, code, pathName = undefined) {
  assert.equal(result.status, 'INVALID_INPUT');
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].code, code);
  if (pathName !== undefined) assert.equal(result.issues[0].path, pathName);
}

function assertInvalidPolicy(result) {
  assertIssue(result, 'INVALID_POLICY');
  assert.equal(result.asOf, null);
  assert.deepEqual(result.timeframe, { id: null, expectedIntervalMs: null });
  assert.equal(result.momentum.evidence.method, 'LOG_RETURN');
  assert.equal(result.rsi.evidence.method, 'WILDER');
  assert.equal(result.momentum.value, null);
  assert.equal(result.momentum.state, 'UNKNOWN');
  assert.equal(result.momentum.strength, 'UNKNOWN');
  assert.equal(result.momentum.change, 'UNKNOWN');
  assert.equal(result.rsi.value, null);
  assert.equal(result.rsi.state, 'UNKNOWN');
  assert.equal(result.rsi.slope, 'UNKNOWN');
  assert.deepEqual(result.momentum.evidence, {
    method: 'LOG_RETURN',
    window: null,
    referenceIndex: null,
    referenceTimestamp: null,
    priorValue: null,
    comparisonWindow: null,
    neutralBand: null,
    weakMaxAbs: null,
    strongMinAbs: null,
    flatTolerance: null,
  });
  assert.deepEqual(result.rsi.evidence, {
    method: 'WILDER',
    period: null,
    priorValue: null,
    comparisonWindow: null,
    bands: { oversoldMax: null, lowMax: null, highMin: null, overboughtMin: null },
    flatTolerance: null,
  });
}

function changeResult(priorRaw, currentRaw, suppliedPolicy = POLICY) {
  const first = 100;
  const second = first * Math.exp(priorRaw);
  const third = second * Math.exp(currentRaw);
  return analyze([first, second, third], suppliedPolicy);
}

function rsiBoundaryCloses(raw) {
  if (raw === 0) return [100, 99, 98];
  if (raw === 100) return [100, 101, 102];
  return [100, 100 + raw, 2 * raw];
}

test('returns the stable ready schema and preserves policy metadata', () => {
  const result = analyze([100, 102, 100, 104]);

  assertStableSchema(result);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.status, 'READY');
  assert.deepEqual(result.asOf, { index: 3, timestamp: candlesFromCloses([100, 102, 100, 104])[3].timestamp });
  assert.deepEqual(result.timeframe, { id: '1h', expectedIntervalMs: HOUR_MS });
  assert.equal(result.momentum.evidence.method, 'LOG_RETURN');
  assert.equal(result.rsi.evidence.method, 'WILDER');
  assert.deepEqual(result.issues, []);
});

test('rejects missing, null, unknown, and malformed policies with safe placeholders', () => {
  const cases = [
    undefined,
    null,
    { ...POLICY, extra: true },
    { ...clone(POLICY), momentum: { ...POLICY.momentum, extra: true } },
    policy({ schemaVersion: 2 }),
    policy({ timeframe: { id: '' } }),
    policy({ timeframe: { expectedIntervalMs: 0 } }),
    policy({ momentum: { window: 0 } }),
    policy({ momentum: { neutralBand: Number.NaN } }),
    policy({ momentum: { neutralBand: Number.POSITIVE_INFINITY } }),
    policy({ momentum: { neutralBand: -1 } }),
    policy({ momentum: { strength: { weakMaxAbs: 0.01 } } }),
    policy({ momentum: { strength: { strongMinAbs: 0.03 } } }),
    policy({ momentum: { change: { comparisonWindow: 0 } } }),
    policy({ momentum: { change: { flatTolerance: -1 } } }),
    policy({ momentum: { change: { flatTolerance: Number.NaN } } }),
    policy({ rsi: { period: 0 } }),
    policy({ rsi: { bands: { oversoldMax: -1 } } }),
    policy({ rsi: { bands: { lowMax: 30 } } }),
    policy({ rsi: { bands: { highMin: 40 } } }),
    policy({ rsi: { bands: { overboughtMin: 60 } } }),
    policy({ rsi: { bands: { overboughtMin: Number.POSITIVE_INFINITY } } }),
    policy({ rsi: { slope: { comparisonWindow: 0 } } }),
    policy({ rsi: { slope: { flatTolerance: -1 } } }),
    policy({ rsi: { slope: { flatTolerance: Number.POSITIVE_INFINITY } } }),
  ];

  for (const invalidPolicy of cases) {
    const result = analyzeMomentumRsi([], invalidPolicy);
    assertStableSchema(result);
    assertInvalidPolicy(result);
  }
});

test('rejects invalid candle containers and required candle shape', () => {
  assertIssue(analyzeMomentumRsi(null, POLICY), 'INVALID_CANDLES', 'candles');
  assertIssue(analyzeMomentumRsi([null], POLICY), 'INVALID_CANDLES', 'candles[0]');
  assertIssue(analyzeMomentumRsi([{ close: 100 }], POLICY), 'INVALID_CANDLES', 'candles[0]');
});

test('rejects each non-finite OHLC field before later candle checks', () => {
  for (const field of ['open', 'high', 'low', 'close']) {
    const result = analyzeMomentumRsi(
      candlesFromCloses([100], { 0: { [field]: Number.NaN } }),
      POLICY,
    );
    assertIssue(result, 'NON_FINITE_OHLC', 'candles[0]');
  }
});

test('rejects non-positive closes as INVALID_CANDLES', () => {
  for (const close of [0, -1]) {
    assertIssue(analyzeMomentumRsi(candlesFromCloses([close]), POLICY), 'INVALID_CANDLES', 'candles[0].close');
  }
});

test('rejects inconsistent OHLC and preserves its precedence', () => {
  const highInvalid = candlesFromCloses([100], { 0: { high: 99 } });
  const lowInvalid = candlesFromCloses([100], { 0: { low: 101 } });
  assertIssue(analyzeMomentumRsi(highInvalid, POLICY), 'INCONSISTENT_OHLC', 'candles[0]');
  assertIssue(analyzeMomentumRsi(lowInvalid, POLICY), 'INCONSISTENT_OHLC', 'candles[0]');
  assertIssue(
    analyzeMomentumRsi(candlesFromCloses([100], { 0: { high: Number.NaN, active: true } }), POLICY),
    'NON_FINITE_OHLC',
  );
});

test('rejects explicit active markers but accepts missing markers', () => {
  for (const marker of [{ isFinalized: false }, { active: true }, { closed: false }]) {
    assertIssue(
      analyzeMomentumRsi(candlesFromCloses([100, 101, 100], { 1: marker }), POLICY),
      'ACTIVE_CANDLE',
      'candles[1]',
    );
  }
  assert.equal(analyze([100, 101, 100]).status, 'READY');
});

test('rejects timestamp type, canonical identity, and TimeClip failures safely', () => {
  assertIssue(
    analyzeMomentumRsi(candlesFromCloses([100], { 0: { timestamp: 1 } }), POLICY),
    'INVALID_TIMESTAMP',
    'candles[0].timestamp',
  );
  assertIssue(
    analyzeMomentumRsi(candlesFromCloses([100], { 0: { timestamp: '2024-01-01T00:00:00.001Z' } }), POLICY),
    'INVALID_TIMESTAMP',
    'candles[0].timestamp',
  );
  assertIssue(
    analyzeMomentumRsi(candlesFromCloses([100], { 0: { openTime: 8640000000000001, timestamp: '2024-01-01T00:00:00.000Z' } }), POLICY),
    'INVALID_TIMESTAMP',
    'candles[0].openTime',
  );
  assertIssue(
    analyzeMomentumRsi(candlesFromCloses([100], { 0: { openTime: Number.MAX_SAFE_INTEGER + 1 } }), POLICY),
    'INVALID_TIMESTAMP',
    'candles[0].timestamp',
  );
});

test('checks duplicate timestamps before ordering and cadence', () => {
  const duplicate = candlesFromCloses([100, 101, 100], {
    1: { openTime: START_TIME, timestamp: new Date(START_TIME).toISOString() },
  });
  const outOfOrder = candlesFromCloses([100, 101, 100], {
    1: { openTime: START_TIME - HOUR_MS, timestamp: new Date(START_TIME - HOUR_MS).toISOString() },
  });
  const gap = candlesFromCloses([100, 101, 100], {
    1: { openTime: START_TIME + 2 * HOUR_MS, timestamp: new Date(START_TIME + 2 * HOUR_MS).toISOString() },
    2: { openTime: START_TIME + 3 * HOUR_MS, timestamp: new Date(START_TIME + 3 * HOUR_MS).toISOString() },
  });

  assertIssue(analyzeMomentumRsi(duplicate, POLICY), 'DUPLICATE_TIMESTAMP', 'candles[1].openTime');
  assertIssue(analyzeMomentumRsi(outOfOrder, POLICY), 'OUT_OF_ORDER_TIMESTAMP', 'candles[1].openTime');
  assertIssue(analyzeMomentumRsi(gap, POLICY), 'INVALID_CADENCE', 'candles[1].openTime');
  assert.equal(analyzeMomentumRsi(gap, policy({ timeframe: { expectedIntervalMs: null } })).status, 'READY');
});

test('returns insufficient data with one deterministic history issue and placeholders', () => {
  const both = analyzeMomentumRsi([], POLICY);
  const rsiOnly = analyze([100, 101]);

  for (const result of [both, rsiOnly]) {
    assertStableSchema(result);
    assert.equal(result.status, 'INSUFFICIENT_DATA');
    assert.equal(result.momentum.value, null);
    assert.equal(result.momentum.state, 'UNKNOWN');
    assert.equal(result.momentum.strength, 'UNKNOWN');
    assert.equal(result.momentum.change, 'UNKNOWN');
    assert.equal(result.rsi.value, null);
    assert.equal(result.rsi.state, 'UNKNOWN');
    assert.equal(result.rsi.slope, 'UNKNOWN');
    assert.equal(result.momentum.evidence.window, 1);
    assert.equal(result.rsi.evidence.period, 2);
  }
  assert.equal(both.asOf, null);
  assert.equal(both.issues[0].code, 'INSUFFICIENT_MOMENTUM_HISTORY');
  assert.equal(rsiOnly.issues[0].code, 'INSUFFICIENT_RSI_HISTORY');
  assert.deepEqual(rsiOnly.asOf, { index: 1, timestamp: candlesFromCloses([100, 101])[1].timestamp });
});

test('returns READY at exact base minimum and leaves optional evidence unknown when unavailable', () => {
  const result = analyze([100, 101, 100]);

  assert.equal(result.status, 'READY');
  assert.equal(result.momentum.change, 'STABLE');
  assert.ok(Number.isFinite(result.momentum.evidence.priorValue));
  assert.equal(result.rsi.slope, 'UNKNOWN');
  assert.equal(result.rsi.evidence.priorValue, null);
});

test('leaves both optional evidence families unknown without partial windows', () => {
  const result = analyze([100, 101, 100], policy({
    momentum: { change: { comparisonWindow: 2 } },
    rsi: { slope: { comparisonWindow: 2 } },
  }));

  assert.equal(result.status, 'READY');
  assert.equal(result.momentum.change, 'UNKNOWN');
  assert.equal(result.momentum.evidence.priorValue, null);
  assert.equal(result.rsi.slope, 'UNKNOWN');
  assert.equal(result.rsi.evidence.priorValue, null);
});

test('classifies positive, negative, neutral, and zero-band momentum states', () => {
  const equalityPolicy = policy({ momentum: { neutralBand: 0.0200000000000005 } });
  assert.equal(analyze([100, 100, 100 * Math.exp(0.05)]).momentum.state, 'POSITIVE');
  assert.equal(analyze([100, 100, 100 * Math.exp(-0.05)]).momentum.state, 'NEGATIVE');
  assert.equal(analyze([100, 100, 100 * Math.exp(0.02)], equalityPolicy).momentum.state, 'NEUTRAL');
  assert.equal(analyze([100, 100, 100 * Math.exp(-0.02)], equalityPolicy).momentum.state, 'NEUTRAL');

  const zeroBand = policy({ momentum: { neutralBand: 0 } });
  assert.equal(analyze([100, 100, 100 * Math.exp(0.01)], zeroBand).momentum.state, 'POSITIVE');
  assert.equal(analyze([100, 100, 100 * Math.exp(-0.01)], zeroBand).momentum.state, 'NEGATIVE');
  assert.equal(analyze([100, 100, 100], zeroBand).momentum.state, 'NEUTRAL');
});

test('proves exact positive and negative neutral-band equality', () => {
  const neutralBand = Math.log(2);
  const equalityPolicy = policy({
    momentum: {
      neutralBand,
      strength: { weakMaxAbs: neutralBand, strongMinAbs: neutralBand + 1 },
    },
  });
  const positive = analyze([1, 1, 2], equalityPolicy);
  const negative = analyze([2, 2, 1], equalityPolicy);

  assert.equal(positive.momentum.value, neutralBand);
  assert.equal(positive.momentum.state, 'NEUTRAL');
  assert.equal(negative.momentum.value, -neutralBand);
  assert.equal(negative.momentum.state, 'NEUTRAL');
});

test('classifies weak, moderate, and strong magnitude boundaries', () => {
  const weak = analyze([100, 100, 100 * Math.exp(0.03)], policy({
    momentum: { strength: { weakMaxAbs: 0.029999999999999805 } },
  }));
  const moderate = analyze([100, 100, 100 * Math.exp(0.05)]);
  const strong = analyze([100, 100, 100 * Math.exp(0.08)], policy({
    momentum: { strength: { strongMinAbs: 0.07999999999999918 } },
  }));

  assert.equal(weak.momentum.strength, 'WEAK');
  assert.equal(moderate.momentum.strength, 'MODERATE');
  assert.equal(strong.momentum.strength, 'STRONG');
  assert.equal(analyze([100, 100, 100]).momentum.strength, 'WEAK');
});

test('applies reversal precedence before magnitude comparison', () => {
  const positiveToNegative = changeResult(0.05, -0.05);
  assert.equal(positiveToNegative.momentum.change, 'REVERSING');
  assert.equal(positiveToNegative.rsi.state, 'NEUTRAL');
  assert.equal(changeResult(-0.05, 0.05).momentum.change, 'REVERSING');
});

test('applies tolerance magnitude comparison to every neutral transition', () => {
  assert.equal(changeResult(0.025, 0.020).momentum.change, 'STABLE');
  assert.equal(changeResult(0.10, 0.020).momentum.change, 'DECELERATING');
  assert.equal(changeResult(0.020, 0.025).momentum.change, 'STABLE');
  assert.equal(changeResult(0.020, 0.10).momentum.change, 'ACCELERATING');
  assert.equal(changeResult(0, 0).momentum.change, 'STABLE');
});

test('classifies same-direction acceleration, deceleration, stable, and zero tolerance equality', () => {
  assert.equal(changeResult(0.03, 0.05).momentum.change, 'ACCELERATING');
  assert.equal(changeResult(0.08, 0.04).momentum.change, 'DECELERATING');
  assert.equal(changeResult(0.05, 0.055).momentum.change, 'STABLE');
  assert.equal(changeResult(0.05, 0.05, policy({ momentum: { change: { flatTolerance: 0 } } })).momentum.change, 'STABLE');
});

test('keeps exact positive and negative momentum tolerance deltas stable', () => {
  const tolerance = 0.6931471805599445;
  const exactPolicy = policy({ momentum: { change: { flatTolerance: tolerance } } });

  assert.equal(analyze([100, 100, 200], exactPolicy).momentum.change, 'STABLE');
  assert.equal(analyze([100, 200, 200], exactPolicy).momentum.change, 'STABLE');
});

test('returns raw RSI and applies every exact band boundary without legacy rounding', () => {
  const cases = [
    [0, 'OVERSOLD'],
    [30, 'OVERSOLD'],
    [40, 'LOW'],
    [50, 'NEUTRAL'],
    [60, 'HIGH'],
    [70, 'OVERBOUGHT'],
    [100, 'OVERBOUGHT'],
  ];
  for (const [raw, state] of cases) {
    const result = analyze(rsiBoundaryCloses(raw));
    assert.ok(Math.abs(result.rsi.value - raw) < 1e-12);
    assert.equal(result.rsi.state, state);
  }
  const precise = analyze([100, 103, 100.5]);
  assert.equal(precise.rsi.value, 54.54545454545455);
  assert.notEqual(precise.rsi.value, Math.round(precise.rsi.value * 100) / 100);
});

test('proves exact RSI lowMax equality with a flat positive market', () => {
  const exactPolicy = policy({
    rsi: { bands: { oversoldMax: 30, lowMax: 50, highMin: 60, overboughtMin: 70 } },
  });
  const result = analyze([100, 100, 100], exactPolicy);

  assert.equal(result.rsi.value, 50);
  assert.equal(result.rsi.value, exactPolicy.rsi.bands.lowMax);
  assert.equal(result.rsi.state, 'LOW');
});

test('calculates causal RSI slope with exact history and tolerance boundaries', () => {
  const rising = analyze([100, 100, 99, 101]);
  const falling = analyze([100, 101, 102, 100]);
  const flat = analyze([100, 100, 100, 100]);

  assert.equal(rising.rsi.slope, 'RISING');
  assert.equal(falling.rsi.slope, 'FALLING');
  assert.equal(flat.rsi.slope, 'FLAT');
  assert.equal(analyze([100, 100, 100]).rsi.slope, 'UNKNOWN');
  assert.equal(analyze([100, 100, 100, 100], policy({ rsi: { slope: { flatTolerance: 0 } } })).rsi.slope, 'FLAT');
});

test('keeps exact positive and negative RSI slope tolerance deltas flat', () => {
  const exactPolicy = policy({ rsi: { slope: { flatTolerance: 25 } } });

  assert.equal(analyze([100, 102, 100, 102], exactPolicy).rsi.slope, 'FLAT');
  assert.equal(analyze([100, 98, 100, 98], exactPolicy).rsi.slope, 'FLAT');
});

test('represents flat markets with stable raw evidence', () => {
  const result = analyze([100, 100, 100, 100]);

  assert.equal(result.momentum.value, 0);
  assert.equal(result.momentum.state, 'NEUTRAL');
  assert.equal(result.momentum.strength, 'WEAK');
  assert.equal(result.momentum.change, 'STABLE');
  assert.equal(result.rsi.value, 50);
  assert.equal(result.rsi.state, 'NEUTRAL');
  assert.equal(result.rsi.slope, 'FLAT');
});

test('supports independent momentum and RSI evidence without trade labels', () => {
  const positiveOverbought = analyze([100, 100, 100, 200]);
  const negativeOversold = analyze([100, 100, 100, 50]);
  const positiveNeutral = analyze([100, 100, 96, 98]);
  const negativeNeutral = analyze([100, 100, 105, 102.5]);
  const strongFalling = analyze([100, 110, 120, 100]);
  const weakRising = analyze([100, 100, 99, 100]);

  assert.equal(positiveOverbought.momentum.state, 'POSITIVE');
  assert.equal(positiveOverbought.rsi.state, 'OVERBOUGHT');
  assert.equal(negativeOversold.momentum.state, 'NEGATIVE');
  assert.equal(negativeOversold.rsi.state, 'OVERSOLD');
  assert.equal(positiveNeutral.momentum.state, 'POSITIVE');
  assert.equal(positiveNeutral.rsi.state, 'NEUTRAL');
  assert.equal(negativeNeutral.momentum.state, 'NEGATIVE');
  assert.equal(negativeNeutral.rsi.state, 'NEUTRAL');
  assert.equal(strongFalling.momentum.strength, 'STRONG');
  assert.equal(strongFalling.rsi.slope, 'FALLING');
  assert.equal(weakRising.momentum.strength, 'WEAK');
  assert.equal(weakRising.rsi.slope, 'RISING');
  assert.doesNotMatch(JSON.stringify(positiveOverbought), /BUY|SELL|TRADE|confidence|probability/);
});

test('represents neutral momentum with extreme RSI without trade interpretation', () => {
  const neutralBand = Math.log(2);
  const exactPolicy = policy({
    momentum: {
      neutralBand,
      strength: { weakMaxAbs: neutralBand, strongMinAbs: neutralBand + 1 },
    },
  });
  const result = analyze([1, 1, 2], exactPolicy);

  assert.equal(result.momentum.state, 'NEUTRAL');
  assert.equal(result.rsi.state, 'OVERBOUGHT');
  assert.doesNotMatch(JSON.stringify(result), /BUY|SELL|TRADE|confidence|probability/);
});

test('returns the complete stable schema for valid-policy invalid candles', () => {
  const invalidCandles = candlesFromCloses([100, 101, 100], {
    1: { openTime: START_TIME, timestamp: new Date(START_TIME).toISOString() },
  });
  const result = analyzeMomentumRsi(invalidCandles, clone(POLICY));

  assertStableSchema(result);
  assert.equal(result.status, 'INVALID_INPUT');
  assert.equal(result.asOf, null);
  assert.deepEqual(result.timeframe, {
    id: POLICY.timeframe.id,
    expectedIntervalMs: POLICY.timeframe.expectedIntervalMs,
  });
  assert.deepEqual(result.momentum, {
    value: null,
    state: 'UNKNOWN',
    strength: 'UNKNOWN',
    change: 'UNKNOWN',
    evidence: {
      method: 'LOG_RETURN',
      window: POLICY.momentum.window,
      referenceIndex: null,
      referenceTimestamp: null,
      priorValue: null,
      comparisonWindow: POLICY.momentum.change.comparisonWindow,
      neutralBand: POLICY.momentum.neutralBand,
      weakMaxAbs: POLICY.momentum.strength.weakMaxAbs,
      strongMinAbs: POLICY.momentum.strength.strongMinAbs,
      flatTolerance: POLICY.momentum.change.flatTolerance,
    },
  });
  assert.deepEqual(result.rsi, {
    value: null,
    state: 'UNKNOWN',
    slope: 'UNKNOWN',
    evidence: {
      method: 'WILDER',
      period: POLICY.rsi.period,
      priorValue: null,
      comparisonWindow: POLICY.rsi.slope.comparisonWindow,
      bands: { ...POLICY.rsi.bands },
      flatTolerance: POLICY.rsi.slope.flatTolerance,
    },
  });
  assert.deepEqual(result.issues, [{
    code: 'DUPLICATE_TIMESTAMP',
    message: 'openTime must be unique.',
    path: 'candles[1].openTime',
  }]);
  assertNoUndefined(result);
  assertFiniteNumbersOrNull(result);
});

test('does not mutate candles or policy and is deterministic', () => {
  const candles = candlesFromCloses([100, 102, 100, 104]);
  const suppliedPolicy = policy();
  const originalCandles = clone(candles);
  const originalPolicy = clone(suppliedPolicy);
  const first = analyzeMomentumRsi(candles, suppliedPolicy);
  const second = analyzeMomentumRsi(candles, suppliedPolicy);

  assert.deepEqual(second, first);
  assert.deepEqual(candles, originalCandles);
  assert.deepEqual(suppliedPolicy, originalPolicy);
});

test('preserves supplied-prefix causality without claiming future-data isolation', () => {
  const prefix = [100, 102, 100, 104];
  const futureA = [106, 105];
  const futureB = [80, 70];
  const prefixResult = analyze(prefix);
  const fullA = analyze(prefix.concat(futureA));
  const fullB = analyze(prefix.concat(futureB));

  assert.notDeepEqual(fullA, fullB);
  assert.deepEqual(analyze(prefix), prefixResult);
});

test('source reuses the raw RSI core and remains runtime isolated', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/intelligence/momentumAnalysis.js'), 'utf8');

  assert.match(source, /computeRawRsiFromCloses/);
  assert.doesNotMatch(source, /avgGain|avgLoss|Wilder.*smoothing|RSIIndicator/);
  assert.doesNotMatch(source, /structureEngine|regimeAnalysis|volatilityAnalysis|AdvanceRisk|Confluence|MTF|PaperTrading/);
  assert.doesNotMatch(source, /Date\.now|Math\.random|process\.env|require\(['"](?:fs|node:fs|http|https|node-fetch)/);
  assert.equal(typeof analyzeMomentumRsi, 'function');
});

test('runtime source has no consumer of the isolated analyzer', () => {
  const intelligenceRoot = path.join(__dirname, '../../src/intelligence');
  for (const file of fs.readdirSync(intelligenceRoot)) {
    if (!file.endsWith('.js') || file === 'momentumAnalysis.js') continue;
    const source = fs.readFileSync(path.join(intelligenceRoot, file), 'utf8');
    assert.doesNotMatch(source, /momentumAnalysis/);
  }
});
