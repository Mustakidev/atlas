const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { analyzeRegime } = require('../../src/intelligence/regimeAnalysis');

const HOUR_MS = 60 * 60 * 1000;
const START_TIME = Date.UTC(2024, 0, 1);
const POLICY = {
  schemaVersion: 1,
  timeframe: { id: '1h', expectedIntervalMs: HOUR_MS },
  range: {
    efficiencyWindow: 3,
    rangeMaxEfficiency: 0.2,
    containment: { window: 3, referenceWindow: 2, minContainedFraction: 2 / 3 },
    breakoutLookbackBars: 2,
  },
  trend: { minDirectionalEfficiency: 0.8 },
};

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

function candlesFrom(closes, overrides = {}) {
  return closes.map((close, index) => candle(close, index, overrides[index] || {}));
}

function structureFor(candles, direction = 'BULLISH', overrides = {}) {
  return {
    schemaVersion: 1,
    status: 'READY',
    asOf: {
      index: candles.length - 1,
      timestamp: candles.at(-1).timestamp,
    },
    policy: { expectedIntervalMs: HOUR_MS },
    structure: { direction },
    events: [],
    ...overrides,
  };
}

function volatilityFor(candles, overrides = {}) {
  return {
    schemaVersion: 1,
    status: 'READY',
    asOf: candles.at(-1).timestamp,
    timeframe: { id: '1h', expectedIntervalMs: HOUR_MS },
    volatility: {
      atr: 2,
      atrPercent: 2,
      level: 'NORMAL',
      trend: 'STABLE',
      evidence: { source: 'fixture' },
    },
    ...overrides,
  };
}

function inputFor(closes = [100, 100, 100, 100, 100], options = {}) {
  const candles = options.candles || candlesFrom(closes, options.candleOverrides);
  return {
    candles,
    structure: options.structure || structureFor(candles, options.direction || 'BULLISH'),
    volatility: options.volatility || volatilityFor(candles),
  };
}

function clone(value) {
  return structuredClone(value);
}

function regimePolicy(overrides = {}) {
  const rangeOverrides = overrides.range || {};
  return {
    ...POLICY,
    ...overrides,
    timeframe: { ...POLICY.timeframe, ...(overrides.timeframe || {}) },
    range: {
      ...POLICY.range,
      ...rangeOverrides,
      containment: {
        ...POLICY.range.containment,
        ...(rangeOverrides.containment || {}),
      },
    },
    trend: { ...POLICY.trend, ...(overrides.trend || {}) },
  };
}

function structureEvent(candles, index, kind, classification = 'UNCLASSIFIED') {
  return {
    kind,
    direction: 'BULLISH',
    classification,
    referenceSwing: {
      id: 'HIGH:1',
      type: 'HIGH',
      price: 101,
      pivotIndex: 1,
      pivotTimestamp: candles[1]?.timestamp || new Date(START_TIME + HOUR_MS).toISOString(),
      confirmedAtIndex: 2,
      confirmedAtTimestamp: candles[2]?.timestamp || new Date(START_TIME + 2 * HOUR_MS).toISOString(),
    },
    observedAt: {
      index,
      timestamp: new Date(START_TIME + index * HOUR_MS).toISOString(),
    },
    priceEvidence: {
      referencePrice: 101,
      candleHigh: 102,
      candleLow: 98,
      candleClose: 102,
      priorHigh: 101,
      priorLow: 99,
      priorClose: 100,
      wickCrossed: kind === 'WICK_BREACH' || kind === 'CLOSE_BREAK',
      closeCrossed: kind === 'CLOSE_BREAK',
    },
  };
}

function assertStableRegimeSchema(result) {
  const has = (value, key, valuePath) => {
    assert.ok(value && Object.hasOwn(value, key), valuePath);
  };

  has(result, 'schemaVersion', 'schemaVersion');
  has(result, 'status', 'status');
  has(result, 'asOf', 'asOf');
  has(result, 'timeframe', 'timeframe');
  has(result.timeframe, 'id', 'timeframe.id');
  has(result.timeframe, 'expectedIntervalMs', 'timeframe.expectedIntervalMs');
  has(result, 'direction', 'direction');
  has(result.direction, 'source', 'direction.source');
  has(result.direction, 'value', 'direction.value');
  has(result, 'condition', 'condition');
  has(result, 'volatility', 'volatility');
  for (const field of ['atr', 'atrPercent', 'level', 'trend', 'evidence']) {
    has(result.volatility, field, `volatility.${field}`);
  }
  has(result, 'range', 'range');
  has(result.range, 'state', 'range.state');
  has(result.range, 'evidence', 'range.evidence');
  has(result.range.evidence, 'directionalEfficiency', 'range.evidence.directionalEfficiency');
  for (const field of ['value', 'window', 'state']) {
    has(result.range.evidence.directionalEfficiency, field, `range.evidence.directionalEfficiency.${field}`);
  }
  has(result.range.evidence, 'containment', 'range.evidence.containment');
  for (const field of ['state', 'window', 'referenceWindow', 'sampleCount', 'containedCount', 'containedFraction', 'minContainedFraction']) {
    has(result.range.evidence.containment, field, `range.evidence.containment.${field}`);
  }
  has(result.range.evidence, 'breakout', 'range.evidence.breakout');
  for (const field of ['state', 'lookbackBars', 'recentCloseBreakCount']) {
    has(result.range.evidence.breakout, field, `range.evidence.breakout.${field}`);
  }
  has(result.range.evidence, 'compression', 'range.evidence.compression');
  for (const field of ['level', 'trend', 'supportive']) {
    has(result.range.evidence.compression, field, `range.evidence.compression.${field}`);
  }
  for (const field of ['criteriaMet', 'criteriaMissing']) {
    has(result.range.evidence, field, `range.evidence.${field}`);
  }
  has(result, 'trend', 'trend');
  has(result.trend, 'state', 'trend.state');
  has(result.trend, 'evidence', 'trend.evidence');
  for (const field of ['structureDirection', 'directionalEfficiency', 'minDirectionalEfficiency', 'contradictoryRangeEvidence', 'criteriaMet', 'criteriaMissing']) {
    has(result.trend.evidence, field, `trend.evidence.${field}`);
  }
  has(result, 'evidence', 'evidence');
  has(result.evidence, 'criteriaMet', 'evidence.criteriaMet');
  has(result.evidence, 'criteriaMissing', 'evidence.criteriaMissing');
  has(result, 'issues', 'issues');
  assertNoUndefined(result);
  assertFiniteNumbers(result);
}

function assertFiniteNumbers(value, valuePath = 'result') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertFiniteNumbers(item, `${valuePath}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') {
    if (typeof value === 'number') assert.ok(Number.isFinite(value), valuePath);
    return;
  }
  Object.entries(value).forEach(([key, nested]) => assertFiniteNumbers(nested, `${valuePath}.${key}`));
}

function assertIssue(result, code, pathName = undefined) {
  assert.equal(result.status, 'INVALID_INPUT');
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].code, code);
  if (pathName !== undefined) assert.equal(result.issues[0].path, pathName);
}

function assertNoUndefined(value, valuePath = 'result') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      assert.notEqual(item, undefined, `${valuePath}[${index}]`);
      assertNoUndefined(item, `${valuePath}[${index}]`);
    });
    return;
  }
  if (!value || typeof value !== 'object') return;
  Object.entries(value).forEach(([key, nested]) => {
    assert.notEqual(nested, undefined, `${valuePath}.${key}`);
    assertNoUndefined(nested, `${valuePath}.${key}`);
  });
}

test('classifies low-efficiency contained candles as RANGING', () => {
  const candles = candlesFrom([100, 100, 100, 100, 100]);
  const result = analyzeRegime(inputFor(undefined, { candles }), POLICY);

  assert.equal(result.status, 'READY');
  assert.deepEqual(result.direction, { source: 'STRUCTURE', value: 'BULLISH' });
  assert.equal(result.condition, 'RANGING');
  assert.equal(result.range.state, 'SUPPORTED');
  assert.equal(result.range.evidence.directionalEfficiency.value, 0);
  assert.equal(result.range.evidence.containment.containedFraction, 1);
  assert.equal(result.trend.state, 'NOT_SUPPORTED');
  assert.deepEqual(result.issues, []);
});

test('classifies high-efficiency directional candles as TRENDING', () => {
  const candles = candlesFrom([100, 110, 120, 130, 140]);
  const result = analyzeRegime(inputFor(undefined, { candles }), POLICY);

  assert.equal(result.status, 'READY');
  assert.equal(result.condition, 'TRENDING');
  assert.equal(result.direction.value, 'BULLISH');
  assert.equal(result.trend.state, 'SUPPORTED');
  assert.equal(result.trend.evidence.directionalEfficiency, 1);
  assert.equal(result.range.state, 'NOT_SUPPORTED');
  assert.ok(result.range.evidence.criteriaMissing.includes('LOW_DIRECTIONAL_EFFICIENCY'));
});

test('uses recent CLOSE_BREAK evidence to reject an otherwise range-like regime', () => {
  const candles = candlesFrom([100, 100, 100, 100, 100]);
  const structure = structureFor(candles, 'BULLISH', {
    events: [{
      kind: 'CLOSE_BREAK',
      direction: 'BULLISH',
      observedAt: { index: 4, timestamp: candles[4].timestamp },
    }],
  });
  const result = analyzeRegime(inputFor(undefined, { candles, structure }), POLICY);

  assert.equal(result.condition, 'UNKNOWN');
  assert.equal(result.range.state, 'NOT_SUPPORTED');
  assert.equal(result.range.evidence.breakout.state, 'PRESENT');
  assert.equal(result.range.evidence.breakout.recentCloseBreakCount, 1);
  assert.equal(result.issues[0].code, 'AMBIGUOUS_REGIME');
});

test('treats compression as range support only, not as a standalone decision', () => {
  const candles = candlesFrom([100, 110, 120, 130, 140]);
  const volatility = volatilityFor(candles, {
    volatility: {
      atr: 1,
      atrPercent: 1,
      level: 'LOW',
      trend: 'COMPRESSING',
      evidence: { source: 'fixture' },
    },
  });
  const result = analyzeRegime(inputFor(undefined, { candles, volatility }), POLICY);

  assert.equal(result.range.evidence.compression.supportive, true);
  assert.equal(result.condition, 'TRENDING');
});

test('keeps LOW and COMPRESSING volatility descriptive when range evidence is absent', () => {
  const candles = candlesFrom([100, 110, 120, 130, 140]);
  const cases = [
    { level: 'LOW', trend: 'STABLE' },
    { level: 'NORMAL', trend: 'COMPRESSING' },
  ];

  for (const volatilityShape of cases) {
    const volatility = volatilityFor(candles, {
      volatility: {
        atr: 1,
        atrPercent: 1,
        level: volatilityShape.level,
        trend: volatilityShape.trend,
        evidence: { source: 'fixture' },
      },
    });
    const result = analyzeRegime(inputFor(undefined, { candles, volatility }), POLICY);

    assert.equal(result.range.evidence.compression.supportive, true, volatilityShape.trend);
    assert.notEqual(result.range.state, 'SUPPORTED', volatilityShape.trend);
    assert.notEqual(result.condition, 'RANGING', volatilityShape.trend);
  }
});

test('supports bearish range and trend conditions without changing direction ownership', () => {
  const rangeCandles = candlesFrom([100, 100, 100, 100, 100]);
  const bearishRange = analyzeRegime(inputFor(undefined, {
    candles: rangeCandles,
    direction: 'BEARISH',
  }), POLICY);
  const trendCandles = candlesFrom([100, 90, 80, 70, 60]);
  const bearishTrend = analyzeRegime(inputFor(undefined, {
    candles: trendCandles,
    direction: 'BEARISH',
  }), POLICY);

  assert.equal(bearishRange.direction.source, 'STRUCTURE');
  assert.equal(bearishRange.direction.value, 'BEARISH');
  assert.equal(bearishRange.condition, 'RANGING');
  assert.equal(bearishTrend.direction.value, 'BEARISH');
  assert.equal(bearishTrend.condition, 'TRENDING');
});

test('keeps MIXED UNKNOWN when range evidence is incomplete', () => {
  const candles = candlesFrom([100, 110, 120, 130, 140]);
  const result = analyzeRegime(inputFor(undefined, {
    candles,
    direction: 'MIXED',
  }), POLICY);

  assert.equal(result.direction.value, 'MIXED');
  assert.equal(result.condition, 'UNKNOWN');
  assert.equal(result.issues[0].code, 'AMBIGUOUS_REGIME');
});

test('keeps regime-owned evidence independent of volatility level and trend', () => {
  const rangeCandles = candlesFrom([100, 100, 100, 100, 100]);
  const trendCandles = candlesFrom([100, 110, 120, 130, 140]);
  const cases = [
    [rangeCandles, { level: 'HIGH', trend: 'EXPANDING' }, 'RANGING'],
    [trendCandles, { level: 'LOW', trend: 'STABLE' }, 'TRENDING'],
    [rangeCandles, { level: 'NORMAL', trend: 'UNKNOWN' }, 'RANGING'],
    [trendCandles, { level: 'NORMAL', trend: 'UNKNOWN' }, 'TRENDING'],
  ];

  for (const [candles, volatilityShape, expectedCondition] of cases) {
    const volatility = volatilityFor(candles, {
      volatility: {
        atr: 2,
        atrPercent: 2,
        ...volatilityShape,
        evidence: { source: 'fixture' },
      },
    });
    const result = analyzeRegime(inputFor(undefined, { candles, volatility }), POLICY);

    assert.equal(result.direction.source, 'STRUCTURE');
    assert.equal(result.condition, expectedCondition);
  }
});

test('preserves MIXED direction ownership while allowing range evidence', () => {
  const candles = candlesFrom([100, 100, 100, 100, 100]);
  const result = analyzeRegime(inputFor(undefined, { candles, direction: 'MIXED' }), POLICY);

  assert.equal(result.direction.value, 'MIXED');
  assert.equal(result.condition, 'RANGING');
});

test('returns UNKNOWN for unestablished structure direction', () => {
  const candles = candlesFrom([100, 100, 100, 100, 100]);
  const result = analyzeRegime(inputFor(undefined, { candles, direction: 'UNESTABLISHED' }), POLICY);

  assert.equal(result.status, 'READY');
  assert.equal(result.direction.value, 'UNESTABLISHED');
  assert.equal(result.condition, 'UNKNOWN');
  assert.equal(result.issues[0].code, 'AMBIGUOUS_REGIME');
});

test('propagates upstream insufficiency without inventing evidence', () => {
  const candles = candlesFrom([100, 100, 100, 100, 100]);
  const structure = structureFor(candles);
  structure.status = 'INSUFFICIENT_DATA';
  const result = analyzeRegime(inputFor(undefined, { candles, structure }), POLICY);

  assert.equal(result.status, 'INSUFFICIENT_DATA');
  assert.equal(result.issues[0].code, 'INSUFFICIENT_STRUCTURE');
  assert.equal(result.condition, 'UNKNOWN');
  assert.equal(result.range.state, 'UNKNOWN');
  assert.equal(result.trend.state, 'UNKNOWN');
});

test('rejects malformed policy and upstream status without throwing', () => {
  const input = inputFor();
  assertIssue(analyzeRegime(input, { ...POLICY, schemaVersion: 2 }), 'INVALID_POLICY', 'policy.schemaVersion');
  assertIssue(analyzeRegime(input, { ...POLICY, range: { ...POLICY.range, rangeMaxEfficiency: 0.9 } }), 'INVALID_POLICY', 'policy.range.rangeMaxEfficiency');
  assertIssue(analyzeRegime({ ...input, structure: { status: 'INVALID_INPUT' } }, POLICY), 'INVALID_STRUCTURE', 'structure.status');
  assertIssue(analyzeRegime({ ...input, volatility: { status: 'INVALID_INPUT' } }, POLICY), 'INVALID_VOLATILITY', 'volatility.status');
});

test('rejects every malformed policy field without defaults or coercion', () => {
  const input = inputFor();
  const cases = [
    ['schemaVersion', { ...POLICY, schemaVersion: 2 }, 'policy.schemaVersion'],
    ['timeframe', { ...POLICY, timeframe: null }, 'policy.timeframe'],
    ['timeframe.id', regimePolicy({ timeframe: { id: ' ' } }), 'policy.timeframe.id'],
    ['expectedIntervalMs zero', regimePolicy({ timeframe: { expectedIntervalMs: 0 } }), 'policy.timeframe.expectedIntervalMs'],
    ['expectedIntervalMs negative', regimePolicy({ timeframe: { expectedIntervalMs: -1 } }), 'policy.timeframe.expectedIntervalMs'],
    ['expectedIntervalMs fractional', regimePolicy({ timeframe: { expectedIntervalMs: 1.5 } }), 'policy.timeframe.expectedIntervalMs'],
    ['expectedIntervalMs unsafe', regimePolicy({ timeframe: { expectedIntervalMs: Number.MAX_SAFE_INTEGER + 1 } }), 'policy.timeframe.expectedIntervalMs'],
    ['efficiencyWindow zero', regimePolicy({ range: { efficiencyWindow: 0 } }), 'policy.range.efficiencyWindow'],
    ['efficiencyWindow negative', regimePolicy({ range: { efficiencyWindow: -1 } }), 'policy.range.efficiencyWindow'],
    ['efficiencyWindow fractional', regimePolicy({ range: { efficiencyWindow: 1.5 } }), 'policy.range.efficiencyWindow'],
    ['rangeMaxEfficiency negative', regimePolicy({ range: { rangeMaxEfficiency: -0.01 } }), 'policy.range.rangeMaxEfficiency'],
    ['rangeMaxEfficiency above one', regimePolicy({ range: { rangeMaxEfficiency: 1.01 } }), 'policy.range.rangeMaxEfficiency'],
    ['rangeMaxEfficiency NaN', regimePolicy({ range: { rangeMaxEfficiency: Number.NaN } }), 'policy.range.rangeMaxEfficiency'],
    ['rangeMaxEfficiency Infinity', regimePolicy({ range: { rangeMaxEfficiency: Number.POSITIVE_INFINITY } }), 'policy.range.rangeMaxEfficiency'],
    ['containment.window zero', regimePolicy({ range: { containment: { window: 0 } } }), 'policy.range.containment.window'],
    ['containment.window negative', regimePolicy({ range: { containment: { window: -1 } } }), 'policy.range.containment.window'],
    ['containment.window fractional', regimePolicy({ range: { containment: { window: 1.5 } } }), 'policy.range.containment.window'],
    ['referenceWindow zero', regimePolicy({ range: { containment: { referenceWindow: 0 } } }), 'policy.range.containment.referenceWindow'],
    ['referenceWindow negative', regimePolicy({ range: { containment: { referenceWindow: -1 } } }), 'policy.range.containment.referenceWindow'],
    ['referenceWindow fractional', regimePolicy({ range: { containment: { referenceWindow: 1.5 } } }), 'policy.range.containment.referenceWindow'],
    ['minContainedFraction zero', regimePolicy({ range: { containment: { minContainedFraction: 0 } } }), 'policy.range.containment.minContainedFraction'],
    ['minContainedFraction negative', regimePolicy({ range: { containment: { minContainedFraction: -0.1 } } }), 'policy.range.containment.minContainedFraction'],
    ['minContainedFraction above one', regimePolicy({ range: { containment: { minContainedFraction: 1.1 } } }), 'policy.range.containment.minContainedFraction'],
    ['minContainedFraction NaN', regimePolicy({ range: { containment: { minContainedFraction: Number.NaN } } }), 'policy.range.containment.minContainedFraction'],
    ['minContainedFraction Infinity', regimePolicy({ range: { containment: { minContainedFraction: Number.POSITIVE_INFINITY } } }), 'policy.range.containment.minContainedFraction'],
    ['breakoutLookbackBars zero', regimePolicy({ range: { breakoutLookbackBars: 0 } }), 'policy.range.breakoutLookbackBars'],
    ['breakoutLookbackBars negative', regimePolicy({ range: { breakoutLookbackBars: -1 } }), 'policy.range.breakoutLookbackBars'],
    ['breakoutLookbackBars fractional', regimePolicy({ range: { breakoutLookbackBars: 1.5 } }), 'policy.range.breakoutLookbackBars'],
    ['minDirectionalEfficiency negative', regimePolicy({ trend: { minDirectionalEfficiency: -0.01 } }), 'policy.trend.minDirectionalEfficiency'],
    ['minDirectionalEfficiency above one', regimePolicy({ trend: { minDirectionalEfficiency: 1.01 } }), 'policy.trend.minDirectionalEfficiency'],
    ['minDirectionalEfficiency NaN', regimePolicy({ trend: { minDirectionalEfficiency: Number.NaN } }), 'policy.trend.minDirectionalEfficiency'],
    ['minDirectionalEfficiency Infinity', regimePolicy({ trend: { minDirectionalEfficiency: Number.POSITIVE_INFINITY } }), 'policy.trend.minDirectionalEfficiency'],
    ['equal efficiency thresholds', regimePolicy({ range: { rangeMaxEfficiency: 0.8 }, trend: { minDirectionalEfficiency: 0.8 } }), 'policy.range.rangeMaxEfficiency'],
    ['reversed efficiency thresholds', regimePolicy({ range: { rangeMaxEfficiency: 0.9 }, trend: { minDirectionalEfficiency: 0.8 } }), 'policy.range.rangeMaxEfficiency'],
  ];

  for (const [name, invalidPolicy, expectedPath] of cases) {
    const result = analyzeRegime(input, invalidPolicy);
    assertIssue(result, 'INVALID_POLICY', expectedPath);
    assert.equal(result.condition, 'UNKNOWN', name);
    assertStableRegimeSchema(result);
  }
});

test('propagates volatility insufficiency without inventing regime evidence', () => {
  const input = inputFor();
  input.volatility = { ...input.volatility, status: 'INSUFFICIENT_DATA' };
  const result = analyzeRegime(input, POLICY);

  assert.equal(result.status, 'INSUFFICIENT_DATA');
  assert.equal(result.condition, 'UNKNOWN');
  assert.equal(result.issues[0].code, 'INSUFFICIENT_VOLATILITY');
  assertStableRegimeSchema(result);
});

test('rejects mismatched boundaries, timeframe, cadence, and active candles', () => {
  const input = inputFor();
  const staleStructure = clone(input.structure);
  staleStructure.asOf.index -= 1;
  assertIssue(analyzeRegime({ ...input, structure: staleStructure }, POLICY), 'BOUNDARY_MISMATCH', 'asOf');

  const wrongTimeframe = clone(input.volatility);
  wrongTimeframe.timeframe.id = '4h';
  assertIssue(analyzeRegime({ ...input, volatility: wrongTimeframe }, POLICY), 'BOUNDARY_MISMATCH', 'timeframe.id');

  const gapCandles = clone(input.candles);
  gapCandles[2].openTime += HOUR_MS;
  gapCandles[2].timestamp = new Date(gapCandles[2].openTime).toISOString();
  assertIssue(analyzeRegime({ ...input, candles: gapCandles }, POLICY), 'INVALID_CANDLE_CONTEXT', 'candles[2].openTime');

  const activeCandles = clone(input.candles);
  activeCandles[0].active = true;
  assertIssue(analyzeRegime({ ...input, candles: activeCandles }, POLICY), 'INVALID_CANDLE_CONTEXT', 'candles[0]');
});

test('uses only preceding reference candles for every containment evaluation', () => {
  const candles = candlesFrom([100, 100, 100, 100, 100, 100, 100, 200, 150, 140], {
    0: { high: 105, low: 95 },
    1: { high: 105, low: 95 },
    2: { high: 105, low: 95 },
    3: { high: 105, low: 95 },
    4: { high: 106, low: 94 },
    5: { high: 107, low: 93 },
    6: { high: 108, low: 92 },
    7: { high: 201, low: 199 },
    8: { high: 151, low: 149 },
    9: { high: 141, low: 139 },
  });
  const policy = regimePolicy({
    range: {
      efficiencyWindow: 1,
      containment: { window: 3, referenceWindow: 4, minContainedFraction: 2 / 3 },
    },
  });
  const result = analyzeRegime(inputFor(undefined, { candles }), policy);
  const containment = result.range.evidence.containment;

  assert.equal(containment.window, 3);
  assert.equal(containment.referenceWindow, 4);
  assert.equal(containment.sampleCount, 3);
  assert.equal(containment.containedCount, 2);
  assert.equal(containment.containedFraction, 2 / 3);
  assert.equal(containment.state, 'SUPPORTED');
});

test('accepts exact containment threshold equality', () => {
  const candles = candlesFrom([100, 100, 100, 100, 100, 100, 100, 200, 150, 140], {
    3: { high: 105, low: 95 },
    4: { high: 106, low: 94 },
    5: { high: 107, low: 93 },
    6: { high: 108, low: 92 },
    7: { high: 201, low: 199 },
    8: { high: 151, low: 149 },
    9: { high: 141, low: 139 },
  });
  const result = analyzeRegime(inputFor(undefined, { candles }), regimePolicy({
    range: {
      efficiencyWindow: 1,
      containment: { window: 3, referenceWindow: 4, minContainedFraction: 2 / 3 },
    },
  }));

  assert.equal(result.range.evidence.containment.containedFraction, 2 / 3);
  assert.equal(result.range.evidence.containment.minContainedFraction, 2 / 3);
  assert.equal(result.range.evidence.containment.state, 'SUPPORTED');
});

test('counts the exact close-break recency lower boundary', () => {
  const candles = candlesFrom([100, 100, 100, 100, 100]);
  const structure = structureFor(candles, 'BULLISH', {
    events: [structureEvent(candles, 3, 'CLOSE_BREAK', 'BOS')],
  });
  const result = analyzeRegime(inputFor(undefined, { candles, structure }), POLICY);

  assert.equal(4 - POLICY.range.breakoutLookbackBars + 1, 3);
  assert.equal(result.range.evidence.breakout.recentCloseBreakCount, 1);
  assert.equal(result.range.evidence.breakout.state, 'PRESENT');
  assert.notEqual(result.range.state, 'SUPPORTED');
});

test('excludes an old close break outside the lookback window', () => {
  const candles = candlesFrom([100, 100, 100, 100, 100]);
  const structure = structureFor(candles, 'BULLISH', {
    events: [structureEvent(candles, 2, 'CLOSE_BREAK', 'BOS')],
  });
  const result = analyzeRegime(inputFor(undefined, { candles, structure }), POLICY);

  assert.equal(result.range.evidence.breakout.recentCloseBreakCount, 0);
  assert.equal(result.range.evidence.breakout.state, 'NOT_PRESENT');
  assert.equal(result.range.state, 'SUPPORTED');
  assert.equal(result.condition, 'RANGING');
});

test('counts CLOSE_BREAK but not WICK_BREACH as breakout evidence', () => {
  const candles = candlesFrom([100, 100, 100, 100, 100]);
  const wick = analyzeRegime(inputFor(undefined, {
    candles,
    structure: structureFor(candles, 'BULLISH', {
      events: [structureEvent(candles, 4, 'WICK_BREACH')],
    }),
  }), POLICY);
  const close = analyzeRegime(inputFor(undefined, {
    candles,
    structure: structureFor(candles, 'BULLISH', {
      events: [structureEvent(candles, 4, 'CLOSE_BREAK', 'BOS')],
    }),
  }), POLICY);

  assert.equal(wick.range.evidence.breakout.recentCloseBreakCount, 0);
  assert.equal(wick.range.state, 'SUPPORTED');
  assert.equal(wick.condition, 'RANGING');
  assert.equal(close.range.evidence.breakout.recentCloseBreakCount, 1);
  assert.equal(close.range.state, 'NOT_SUPPORTED');
  assert.equal(close.condition, 'UNKNOWN');
});

test('rejects a future-index structure event before regime computation', () => {
  const candles = candlesFrom([100, 100, 100, 100, 100]);
  const structure = structureFor(candles, 'BULLISH', {
    events: [structureEvent(candles, 5, 'CLOSE_BREAK', 'BOS')],
  });
  const result = analyzeRegime(inputFor(undefined, { candles, structure }), POLICY);

  assertIssue(result, 'INVALID_STRUCTURE', 'structure.events[0]');
  assert.equal(result.condition, 'UNKNOWN');
});

test('does not let BOS or CHOCH metadata rewrite structure direction', () => {
  const candles = candlesFrom([100, 100, 100, 100, 100]);
  for (const classification of ['BOS', 'CHOCH']) {
    const structure = structureFor(candles, 'BULLISH', {
      events: [structureEvent(candles, 4, 'CLOSE_BREAK', classification)],
    });
    const result = analyzeRegime(inputFor(undefined, { candles, structure }), POLICY);

    assert.equal(result.direction.source, 'STRUCTURE', classification);
    assert.equal(result.direction.value, 'BULLISH', classification);
    assert.equal(result.range.evidence.breakout.recentCloseBreakCount, 1, classification);
  }
});

test('returns insufficient range history at the exact minimum boundary', () => {
  const candles = candlesFrom([100, 100, 100, 100]);
  const result = analyzeRegime(inputFor(undefined, { candles }), POLICY);

  assert.equal(result.status, 'INSUFFICIENT_DATA');
  assert.equal(result.asOf, candles.at(-1).timestamp);
  assert.equal(result.issues[0].code, 'INSUFFICIENT_RANGE_HISTORY');
  assert.equal(result.direction.value, 'BULLISH');
});

test('rejects invalid candle timestamps without Date TimeClip exceptions', () => {
  const candles = candlesFrom([100, 100, 100, 100, 100]);
  candles[0].openTime = 8640000000000001;
  candles[0].timestamp = 'not-canonical';

  let result;
  assert.doesNotThrow(() => {
    result = analyzeRegime(inputFor(undefined, { candles }), POLICY);
  });
  assertIssue(result, 'INVALID_CANDLE_CONTEXT', 'candles[0].timestamp');
});

test('calculates a known choppy directional efficiency without rounding', () => {
  const candles = candlesFrom([99, 100, 104, 100, 103, 101]);
  const result = analyzeRegime(inputFor(undefined, { candles }), POLICY);

  assert.equal(result.range.evidence.directionalEfficiency.window, 3);
  assert.equal(result.range.evidence.directionalEfficiency.value, 1 / 3);
  assert.equal(result.condition, 'UNKNOWN');
  assert.equal(result.issues[0].code, 'AMBIGUOUS_REGIME');
});

test('uses inclusive range and trend efficiency thresholds', () => {
  const rangeEquality = analyzeRegime(inputFor(undefined, {
    candles: candlesFrom([99, 100, 102, 100, 101]),
  }), POLICY);
  const trendEquality = analyzeRegime(inputFor(undefined, {
    candles: candlesFrom([99, 100, 104, 103.5, 104]),
  }), POLICY);

  assert.equal(rangeEquality.range.evidence.directionalEfficiency.value, 0.2);
  assert.equal(rangeEquality.range.evidence.directionalEfficiency.state, 'SUPPORTED');
  assert.equal(trendEquality.trend.evidence.directionalEfficiency, 0.8);
  assert.equal(trendEquality.trend.state, 'SUPPORTED');
  assert.equal(trendEquality.condition, 'TRENDING');
});

test('keeps the strict middle efficiency zone UNKNOWN', () => {
  const candles = candlesFrom([99, 100, 104, 100, 103, 101]);
  const result = analyzeRegime(inputFor(undefined, { candles }), POLICY);

  assert.ok(result.range.evidence.directionalEfficiency.value > POLICY.range.rangeMaxEfficiency);
  assert.ok(result.range.evidence.directionalEfficiency.value < POLICY.trend.minDirectionalEfficiency);
  assert.equal(result.status, 'READY');
  assert.equal(result.condition, 'UNKNOWN');
  assert.equal(result.issues[0].code, 'AMBIGUOUS_REGIME');
});

test('is deterministic, causal, immutable, and independent of metadata', () => {
  const candles = candlesFrom([100, 100, 100, 100, 100]);
  candles[0].metadata = { source: 'fixture' };
  const input = inputFor(undefined, { candles });
  const configuredPolicy = clone(POLICY);
  const originalInput = clone(input);
  const originalPolicy = clone(configuredPolicy);

  const first = analyzeRegime(input, configuredPolicy);
  assert.deepEqual(analyzeRegime(input, configuredPolicy), first);
  assert.deepEqual(input, originalInput);
  assert.deepEqual(configuredPolicy, originalPolicy);

  const prefix = input.candles.slice(0, 5);
  const prefixInput = inputFor(undefined, {
    candles: prefix,
    structure: structureFor(prefix),
    volatility: volatilityFor(prefix),
  });
  const prefixResult = analyzeRegime(prefixInput, configuredPolicy);
  assert.deepEqual(
    analyzeRegime({
      candles: prefix,
      structure: structureFor(prefix),
      volatility: volatilityFor(prefix),
    }, configuredPolicy),
      prefixResult,
  );
});

test('never reads a candle index beyond the supplied current boundary', () => {
  const candles = candlesFrom([100, 100, 100, 100, 100]);
  const accessedIndexes = [];
  const proxiedCandles = new Proxy(candles, {
    get(target, property, receiver) {
      if (/^\d+$/.test(String(property))) accessedIndexes.push(Number(property));
      return Reflect.get(target, property, receiver);
    },
  });
  assert.equal(Array.isArray(proxiedCandles), true);

  const result = analyzeRegime({
    ...inputFor(undefined, { candles }),
    candles: proxiedCandles,
  }, POLICY);

  assert.equal(result.status, 'READY');
  assert.ok(accessedIndexes.length > 0);
  assert.ok(Math.max(...accessedIndexes) <= candles.length - 1);
});

test('returns a stable schema with no undefined values', () => {
  const result = analyzeRegime(inputFor(), POLICY);

  assert.deepEqual(Object.keys(result), [
    'schemaVersion', 'status', 'asOf', 'timeframe', 'direction', 'condition',
    'volatility', 'range', 'trend', 'evidence', 'issues',
  ]);
  assert.deepEqual(Object.keys(result.direction), ['source', 'value']);
  assertNoUndefined(result);
});

test('preserves the complete schema across every representative return family', () => {
  const valid = inputFor();
  const invalidStructure = { ...valid, structure: { status: 'INVALID_INPUT' } };
  const insufficientStructure = { ...valid, structure: { status: 'INSUFFICIENT_DATA' } };
  const invalidVolatility = { ...valid, volatility: { status: 'INVALID_INPUT' } };
  const insufficientVolatility = { ...valid, volatility: { status: 'INSUFFICIENT_DATA' } };
  const invalidCandles = clone(valid.candles);
  invalidCandles[0].close = -1;
  const staleStructure = clone(valid.structure);
  staleStructure.asOf.index -= 1;
  const insufficientRangeCandles = candlesFrom([100, 100, 100, 100]);
  const ambiguousCandles = candlesFrom([99, 100, 104, 100, 103, 101]);
  const cases = [
    ['invalid policy', analyzeRegime(valid, { ...POLICY, schemaVersion: 2 })],
    ['invalid structure', analyzeRegime(invalidStructure, POLICY)],
    ['insufficient structure', analyzeRegime(insufficientStructure, POLICY)],
    ['invalid volatility', analyzeRegime(invalidVolatility, POLICY)],
    ['insufficient volatility', analyzeRegime(insufficientVolatility, POLICY)],
    ['invalid candle', analyzeRegime({ ...valid, candles: invalidCandles }, POLICY)],
    ['boundary mismatch', analyzeRegime({ ...valid, structure: staleStructure }, POLICY)],
    ['insufficient range history', analyzeRegime(inputFor(undefined, { candles: insufficientRangeCandles }), POLICY)],
    ['ready trending', analyzeRegime(inputFor([100, 110, 120, 130, 140]), POLICY)],
    ['ready ranging', analyzeRegime(inputFor(), POLICY)],
    ['ready unknown ambiguity', analyzeRegime(inputFor(undefined, { candles: ambiguousCandles }), POLICY)],
    ['ready unknown unestablished', analyzeRegime(inputFor(undefined, { direction: 'UNESTABLISHED' }), POLICY)],
  ];

  for (const [name, result] of cases) {
    assertStableRegimeSchema(result);
    assert.ok(['INVALID_INPUT', 'INSUFFICIENT_DATA', 'READY'].includes(result.status), name);
  }
});

test('applies deterministic first-issue validation precedence', () => {
  const valid = inputFor();
  const malformedCandles = clone(valid.candles);
  malformedCandles[0].close = -1;
  const malformedVolatility = { status: 'INVALID_INPUT' };
  const staleStructure = clone(valid.structure);
  staleStructure.asOf.index -= 1;

  const invalidPolicy = analyzeRegime({ ...valid, candles: malformedCandles }, { ...POLICY, schemaVersion: 2 });
  const invalidStructure = analyzeRegime({
    ...valid,
    candles: malformedCandles,
    structure: { status: 'INVALID_INPUT' },
    volatility: malformedVolatility,
  }, POLICY);
  const invalidVolatility = analyzeRegime({
    ...valid,
    candles: malformedCandles,
    volatility: malformedVolatility,
  }, POLICY);
  const invalidCandle = analyzeRegime({ ...valid, candles: malformedCandles }, POLICY);
  const boundaryMismatch = analyzeRegime({ ...valid, structure: staleStructure }, POLICY);

  assert.equal(invalidPolicy.issues[0].code, 'INVALID_POLICY');
  assert.equal(invalidStructure.issues[0].code, 'INVALID_STRUCTURE');
  assert.equal(invalidVolatility.issues[0].code, 'INVALID_VOLATILITY');
  assert.equal(invalidCandle.issues[0].code, 'INVALID_CANDLE_CONTEXT');
  assert.equal(boundaryMismatch.issues[0].code, 'BOUNDARY_MISMATCH');
});

test('does not import legacy regime authorities or time-dependent behavior', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../../src/intelligence/regimeAnalysis.js'),
    'utf8',
  );

  assert.doesNotMatch(source, /RegimeEngine/);
  assert.doesNotMatch(source, /RangeDetector/);
  assert.doesNotMatch(source, /TrendStrength/);
  assert.doesNotMatch(source, /VolatilityClassifier/);
  assert.doesNotMatch(source, /Date\.now/);
  assert.doesNotMatch(source, /Math\.random/);
});
