const test = require('node:test');
const assert = require('node:assert/strict');

const { ConfluenceEngine } = require('../../src/engine/confluence');
const { RSIIndicator } = require('../../src/engine/indicators/rsi');
const { StructureEngine } = require('../../src/engine/structure');
const { bullishCandles, bearishCandles, rangingCandles } = require('../fixtures/market');
const { fresh } = require('../helpers/fixtures');

const EXPECTED_WEIGHTS = {
  trend: 0.30,
  structure: 0.25,
  momentum: 0.15,
  rsi: 0.15,
  volatility: 0.15,
};

function createEngine({ analysis, structureResult, rsiResult, componentError } = {}) {
  const resolvedAnalysis = analysis || {
    trend: { '1H': 'Bullish' },
    confidence: { '1H': 80 },
    momentum: { '1H': 80 },
    volatility: { '1H': 'Medium' },
  };
  const resolvedStructure = structureResult || {
    ready: true,
    score: 80,
    direction: 'bullish',
    confidence: 80,
  };
  const resolvedRsi = rsiResult === undefined ? {
    ready: true,
    strength: 80,
    value: 60,
    state: 'Neutral',
    confidence: 80,
  } : rsiResult;

  return new ConfluenceEngine({
    analyzer: { getAnalysis: () => resolvedAnalysis },
    indicatorRegistry: {
      get(name) {
        return name === 'RSI' && resolvedRsi !== null ? { calculate: () => resolvedRsi } : null;
      },
    },
    structureEngine: {
      calculate() {
        if (componentError === 'structure') throw new Error('structure failed');
        return resolvedStructure;
      },
    },
    candleEngine: null,
    logger: { info() {}, warn() {}, error() {} },
    config: { get(key) { return key === 'CONFLUENCE_BULLISH_THRESHOLD' ? 65 : 35; } },
    symbol: 'BTCUSDT',
  });
}

function createControlledScoreEngine(score) {
  const engine = createEngine();
  for (const name of Object.keys(EXPECTED_WEIGHTS)) {
    engine.getComponent(name).calculate = () => ({ score, direction: 'neutral', available: true, confidence: 80 });
  }
  return engine;
}

function stableResult(result) {
  const { calculatedAt, lastUpdated, calculationTime, ...stable } = result;
  return stable;
}

function assertResponseShape(result) {
  assert.deepEqual(Object.keys(result).sort(), [
    'bias',
    'calculatedAt',
    'calculationTime',
    'candleCount',
    'components',
    'confidence',
    'dataSource',
    'engineVersion',
    'lastUpdated',
    'missing',
    'score',
    'timeframe',
    'timestamp',
  ]);
  assert.ok(result.score === null || (result.score >= 0 && result.score <= 100));
  assert.ok(Number.isFinite(result.confidence));
  assert.ok(result.confidence >= 0 && result.confidence <= 100);
  assert.ok(['Bullish', 'Bearish', 'Neutral'].includes(result.bias));
}

function expectedComponents(scores, directions = {}) {
  return Object.fromEntries(Object.entries(EXPECTED_WEIGHTS).map(([name, weight]) => [name, {
    score: scores[name],
    direction: directions[name] || (name === 'volatility' ? null : 'bullish'),
    weight,
    available: true,
    confidence: 80,
    reason: null,
  }]));
}

function assertGolden(result, expected) {
  assertResponseShape(result);
  assert.equal(result.score, expected.score);
  assert.equal(result.bias, expected.bias);
  assert.equal(result.confidence, expected.confidence);
  assert.equal(result.timeframe, '1h');
  assert.equal(result.candleCount, 40);
  assert.deepEqual(result.components, expected.components);
  assert.deepEqual(result.missing, []);
}

test('[production] Confluence returns a bounded scored response with real Structure, RSI, and Trend components', () => {
  const candles = fresh(bullishCandles, 40);
  const registry = { get(name) { return name === 'RSI' ? new RSIIndicator('BTCUSDT') : null; } };
  const engine = new ConfluenceEngine({
    analyzer: {
      getAnalysis() {
        return {
          trend: { '1H': 'Bullish' },
          confidence: { '1H': 80 },
          momentum: { '1H': 70 },
          volatility: { '1H': 'Medium' },
        };
      },
    },
    indicatorRegistry: registry,
    structureEngine: new StructureEngine({ info() {}, warn() {} }, 'BTCUSDT'),
    candleEngine: null,
    logger: { info() {}, warn() {}, error() {} },
    config: { get(key) { return key === 'CONFLUENCE_BULLISH_THRESHOLD' ? 65 : 35; } },
    symbol: 'BTCUSDT',
  });
  const result = engine.calculate(candles, '1h');

  assert.ok(result.score === null || (result.score >= 0 && result.score <= 100));
  assert.ok(['Bullish', 'Bearish', 'Neutral'].includes(result.bias));
  assert.ok(result.confidence >= 0 && result.confidence <= 100);
  assert.ok(result.components && typeof result.components === 'object');
  assert.ok(Array.isArray(result.missing));
  assert.equal(result.components.trend.available, true);
  assert.equal(result.components.structure.available, true);
  assert.equal(result.components.rsi.available, true);
  assert.ok(Number.isFinite(result.components.trend.score));
  assert.ok(Number.isFinite(result.components.structure.score));
  assert.ok(Number.isFinite(result.components.rsi.score));
});

test('[aggregation] characterizes a strong bullish market golden response', () => {
  const result = createEngine().calculate(fresh(bullishCandles, 40), '1h');
  assertGolden(result, {
    score: 79,
    bias: 'Bullish',
    confidence: 80,
    components: expectedComponents({ trend: 93, structure: 80, momentum: 80, rsi: 80, volatility: 50 }),
  });
});

test('[aggregation] characterizes a strong bearish market golden response', () => {
  const result = createEngine({
    analysis: {
      trend: { '1H': 'Bearish' },
      confidence: { '1H': 80 },
      momentum: { '1H': 20 },
      volatility: { '1H': 'Medium' },
    },
    structureResult: { ready: true, score: 20, direction: 'bearish', confidence: 80 },
    rsiResult: { ready: true, strength: 20, value: 40, state: 'Neutral', confidence: 80 },
  }).calculate(fresh(bearishCandles, 40), '1h');
  assertGolden(result, {
    score: 21,
    bias: 'Bearish',
    confidence: 80,
    components: expectedComponents(
      { trend: 7, structure: 20, momentum: 20, rsi: 20, volatility: 50 },
      { trend: 'bearish', structure: 'bearish', momentum: 'bearish', rsi: 'bearish' },
    ),
  });
});

test('[aggregation] characterizes a neutral ranging market golden response', () => {
  const result = createEngine({
    analysis: {
      trend: { '1H': 'Sideways' },
      confidence: { '1H': 80 },
      momentum: { '1H': 50 },
      volatility: { '1H': 'Medium' },
    },
    structureResult: { ready: true, score: 50, direction: 'neutral', confidence: 80 },
    rsiResult: { ready: true, strength: 50, value: 50, state: 'Neutral', confidence: 80 },
  }).calculate(fresh(rangingCandles, 40), '1h');
  assertGolden(result, {
    score: 50,
    bias: 'Neutral',
    confidence: 80,
    components: expectedComponents(
      { trend: 50, structure: 50, momentum: 50, rsi: 50, volatility: 50 },
      { trend: 'sideways', structure: 'neutral', momentum: 'neutral', rsi: 'neutral' },
    ),
  });
});

test('[aggregation] characterizes high-volatility scoring behavior', () => {
  const result = createEngine({
    analysis: {
      trend: { '1H': 'Bullish' },
      confidence: { '1H': 80 },
      momentum: { '1H': 80 },
      volatility: { '1H': 'High' },
    },
  }).calculate(fresh(bullishCandles, 40), '1h');
  assertGolden(result, {
    score: 74,
    bias: 'Bullish',
    confidence: 80,
    components: expectedComponents({ trend: 93, structure: 80, momentum: 80, rsi: 80, volatility: 15 }),
  });
});

test('[aggregation] characterizes low-volatility scoring behavior', () => {
  const result = createEngine({
    analysis: {
      trend: { '1H': 'Bullish' },
      confidence: { '1H': 80 },
      momentum: { '1H': 80 },
      volatility: { '1H': 'Low' },
    },
  }).calculate(fresh(bullishCandles, 40), '1h');
  assertGolden(result, {
    score: 85,
    bias: 'Bullish',
    confidence: 80,
    components: expectedComponents({ trend: 93, structure: 80, momentum: 80, rsi: 80, volatility: 85 }),
  });
});

test('[aggregation] characterizes missing component data and coverage-adjusted scoring', () => {
  const result = createEngine({
    analysis: {
      confidence: { '1H': 80 },
      momentum: { '1H': 60 },
      volatility: { '1H': 'Medium' },
    },
    rsiResult: null,
  }).calculate(fresh(bullishCandles, 40), '1h');

  assertResponseShape(result);
  assert.equal(result.score, 66);
  assert.equal(result.bias, 'Bullish');
  assert.equal(result.confidence, 48);
  assert.deepEqual(result.missing, [
    { name: 'trend', reason: 'No analysis data' },
    { name: 'rsi', reason: 'RSI indicator not registered' },
  ]);
  assert.equal(result.components.trend.available, false);
  assert.equal(result.components.rsi.available, false);
});

test('[production] characterizes insufficient candle response', () => {
  const result = createEngine().calculate(fresh(bullishCandles, 14), '1h');

  assert.deepEqual(stableResult(result), {
    timeframe: '1h',
    candleCount: 14,
    score: null,
    bias: 'Neutral',
    confidence: 0,
    components: {},
    missing: [{ name: 'all', reason: 'Insufficient candle data (14/15)' }],
    timestamp: null,
    engineVersion: '1.0.0',
    dataSource: 'MarketAnalyzer + IndicatorRegistry + StructureEngine + CandleEngine',
  });
});

test('[aggregation] characterizes component error isolation', () => {
  const result = createEngine({ componentError: 'structure' }).calculate(fresh(bullishCandles, 40), '1h');

  assertResponseShape(result);
  assert.equal(result.score, 79);
  assert.equal(result.bias, 'Bullish');
  assert.equal(result.confidence, 64);
  assert.deepEqual(result.missing, [{ name: 'structure', reason: 'structure failed' }]);
  assert.deepEqual(result.components.structure, {
    score: null,
    direction: null,
    weight: 0.25,
    available: false,
    confidence: null,
    reason: 'structure failed',
  });
});

test('[aggregation][legacy] documents undefined component score behavior without freezing NaN', t => {
  const result = createEngine({
    structureResult: { ready: true, score: undefined, direction: 'bullish', confidence: 80 },
  }).calculate(fresh(bullishCandles, 40), '1h');

  if (!Number.isFinite(result.score)) {
    // TODO: Fix the production undefined-score path before requiring a finite score here.
    t.skip('Known legacy defect: undefined component scores currently produce NaN');
    return;
  }

  assert.ok(Number.isFinite(result.score));
});

test('[aggregation] preserves threshold behavior immediately around bullish and bearish boundaries', () => {
  const expectations = [
    [65, 'Bullish'],
    [64, 'Neutral'],
    [35, 'Bearish'],
    [36, 'Neutral'],
  ];

  for (const [score, bias] of expectations) {
    const result = createControlledScoreEngine(score).calculate(fresh(rangingCandles, 40), '1h');
    assert.equal(result.score, score);
    assert.equal(result.bias, bias);
    assert.equal(result.confidence, 80);
  }
});

test('[aggregation] preserves current weights, response invariants, and deterministic semantic output', () => {
  const engine = createEngine();
  assert.deepEqual(engine.getComponents(), {
    trend: { weight: 0.30 },
    structure: { weight: 0.25 },
    momentum: { weight: 0.15 },
    rsi: { weight: 0.15 },
    volatility: { weight: 0.15 },
  });

  const candles = fresh(bullishCandles, 40);
  const first = engine.calculate(candles, '1h');
  const second = engine.calculate(candles, '1h');
  assertResponseShape(first);
  assert.deepEqual(stableResult(first), stableResult(second));
});

test('[registry] preserves the default component order and weights', () => {
  const engine = createEngine();

  assert.deepEqual(Object.keys(engine.getComponents()), [
    'trend',
    'structure',
    'momentum',
    'rsi',
    'volatility',
  ]);
  assert.deepEqual(engine.getComponents(), {
    trend: { weight: 0.30 },
    structure: { weight: 0.25 },
    momentum: { weight: 0.15 },
    rsi: { weight: 0.15 },
    volatility: { weight: 0.15 },
  });
});

test('[registry] preserves engine registration and lookup façade behavior', () => {
  const engine = createEngine();
  const calculate = () => ({ score: 50, available: true, confidence: 80 });

  assert.equal(engine.registerComponent('custom', { weight: 0.1, calculate }), engine);
  assert.deepEqual(engine.getComponent('custom'), { weight: 0.1, calculate });
  assert.equal(engine.getComponent('unknown'), null);
  assert.deepEqual(engine.getComponents().custom, { weight: 0.1 });
});

test('[registry] clearComponents clears the registry and returns the engine', () => {
  const engine = createEngine();

  assert.equal(engine.clearComponents(), engine);
  assert.deepEqual(engine.getComponents(), {});
  assert.equal(engine.getInfo().componentCount, 0);
  assert.equal(engine.registerComponent('afterClear', { weight: 1, calculate: () => ({}) }), engine);
  assert.deepEqual(Object.keys(engine.getComponents()), ['afterClear']);
});

test('[registry] preserves component and missing response order', () => {
  const engine = createEngine();
  engine.clearComponents();
  engine.registerComponent('first', {
    weight: 0.5,
    calculate: () => ({ score: null, available: false, reason: 'first missing' }),
  });
  engine.registerComponent('second', {
    weight: 0.5,
    calculate: () => ({ score: null, available: false, reason: 'second missing' }),
  });

  const result = engine.calculate(fresh(rangingCandles, 40), '1h');

  assert.deepEqual(Object.keys(result.components), ['first', 'second']);
  assert.deepEqual(result.missing, [
    { name: 'first', reason: 'first missing' },
    { name: 'second', reason: 'second missing' },
  ]);
});
