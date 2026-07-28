const test = require('node:test');
const assert = require('node:assert/strict');

const { RegimeEngine } = require('../../src/market-regime/RegimeEngine');
const {
  REGIMES,
  REGIME_DESCRIPTIONS,
  REGIME_THRESHOLDS,
} = require('../../src/market-regime/RegimeTypes');

const logger = { info() {}, warn() {}, error() {} };
const config = { get() {} };
const candles = Array.from({ length: 30 }, (_, index) => ({
  open: 100,
  high: 101,
  low: 99,
  close: 100,
  volume: 1,
  timestamp: new Date(index * 60000).toISOString(),
}));

const expectedRegimes = {
  TRENDING_BULL: 'TRENDING_BULL',
  TRENDING_BEAR: 'TRENDING_BEAR',
  RANGING: 'RANGING',
  HIGH_VOLATILITY: 'HIGH_VOLATILITY',
  LOW_VOLATILITY: 'LOW_VOLATILITY',
  UNKNOWN: 'UNKNOWN',
};

const expectedDescriptions = {
  TRENDING_BULL: 'Sustained upward movement with strong bullish structure',
  TRENDING_BEAR: 'Sustained downward movement with strong bearish structure',
  RANGING: 'Sideways price action with no clear direction',
  HIGH_VOLATILITY: 'Elevated price volatility exceeding normal ranges',
  LOW_VOLATILITY: 'Suppressed price volatility indicating consolidation',
  UNKNOWN: 'Insufficient data to determine market regime',
};

const expectedThresholds = {
  TREND_BULL_MIN_SCORE: 60,
  TREND_BEAR_MAX_SCORE: 40,
  RANGE_CONFIDENCE_MIN: 55,
  HIGH_VOL_ATR_PCT: 3.0,
  LOW_VOL_ATR_PCT: 1.0,
};

function attemptMutation(fn) {
  try {
    fn();
  } catch {
    // Frozen objects may throw in strict callers or reject the write silently.
  }
}

function assertFrozenTree(value) {
  assert.equal(Object.isFrozen(value), true);
  if (!value || typeof value !== 'object') return;
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === 'object') assertFrozenTree(nested);
  }
}

function makeEngine({ trendScore, rangeConfidence, volatilityLevel = 'NORMAL', volatilityScore = 50 }) {
  const engine = new RegimeEngine({
    indicatorRegistry: {},
    atrEngine: {},
    candleEngine: {},
    analyzer: { getAnalysis: () => null },
    logger,
    config,
    symbol: 'BTCUSDT',
  });

  engine.trendStrength = {
    evaluate: () => ({ score: trendScore, reason: 'controlled trend', components: {} }),
  };
  engine.rangeDetector = {
    evaluate: () => ({ confidence: rangeConfidence, components: {} }),
  };
  engine.volatilityClassifier = {
    evaluate: () => ({
      level: volatilityLevel,
      score: volatilityScore,
      atrPercentage: 2,
      reason: 'controlled volatility',
    }),
  };

  return engine;
}

function stableResult(result) {
  const stable = {};
  for (const [key, value] of Object.entries(result)) {
    if (!['calculatedAt', 'lastUpdated', 'calculationTime'].includes(key)) stable[key] = value;
  }
  return stable;
}

function evaluateCase(options) {
  return stableResult(makeEngine(options).calculate(candles, '1h'));
}

test('preserves exact regime policy values and freezes every policy tree', () => {
  assert.deepEqual(REGIMES, expectedRegimes);
  assert.deepEqual(REGIME_DESCRIPTIONS, expectedDescriptions);
  assert.deepEqual(REGIME_THRESHOLDS, expectedThresholds);

  assertFrozenTree(REGIMES);
  assertFrozenTree(REGIME_DESCRIPTIONS);
  assertFrozenTree(REGIME_THRESHOLDS);
});

test('threshold replacement, addition, and deletion cannot change policy values', () => {
  attemptMutation(() => { REGIME_THRESHOLDS.RANGE_CONFIDENCE_MIN = 101; });
  attemptMutation(() => { REGIME_THRESHOLDS.NEW_THRESHOLD = 101; });
  attemptMutation(() => { delete REGIME_THRESHOLDS.TREND_BULL_MIN_SCORE; });

  assert.deepEqual(REGIME_THRESHOLDS, expectedThresholds);
  assert.equal(Object.hasOwn(REGIME_THRESHOLDS, 'NEW_THRESHOLD'), false);
});

test('regime replacement, addition, and deletion cannot change exported values', () => {
  attemptMutation(() => { REGIMES.RANGING = 'MUTATED'; });
  attemptMutation(() => { REGIMES.NEW_REGIME = 'NEW'; });
  attemptMutation(() => { delete REGIMES.UNKNOWN; });

  assert.deepEqual(REGIMES, expectedRegimes);
  assert.equal(Object.hasOwn(REGIMES, 'NEW_REGIME'), false);
});

test('all imported consumers share the same immutable policy references', () => {
  const secondImport = require('../../src/market-regime/RegimeTypes');

  assert.strictEqual(secondImport.REGIMES, REGIMES);
  assert.strictEqual(secondImport.REGIME_THRESHOLDS, REGIME_THRESHOLDS);

  attemptMutation(() => { secondImport.REGIME_THRESHOLDS.HIGH_VOL_ATR_PCT = 99; });
  attemptMutation(() => { delete secondImport.REGIMES.TRENDING_BULL; });

  assert.deepEqual(REGIME_THRESHOLDS, expectedThresholds);
  assert.deepEqual(REGIMES, expectedRegimes);
});

test('mutation attempts cannot change a complete regime decision', () => {
  const engine = makeEngine({ trendScore: 64, rangeConfidence: 60 });
  const before = stableResult(engine.calculate(candles, '1h'));

  attemptMutation(() => { REGIME_THRESHOLDS.RANGE_CONFIDENCE_MIN = 101; });
  attemptMutation(() => { REGIME_THRESHOLDS.TREND_BULL_MIN_SCORE = 101; });
  attemptMutation(() => { REGIMES.TRENDING_BULL = 'MUTATED'; });
  attemptMutation(() => { REGIMES.EXTRA = 'MUTATED'; });
  attemptMutation(() => { delete REGIME_THRESHOLDS.RANGE_CONFIDENCE_MIN; });

  const after = stableResult(engine.calculate(candles, '1h'));
  assert.deepEqual(after, before);
  assert.equal(after.regime, 'RANGING');
  assert.equal(after.confidence, 60);
  assert.equal(after.trendScore, 64);
  assert.equal(after.rangeScore, 60);
  assert.equal(after.volatility, 'NORMAL');
  assert.equal(after.rangeReason, 'Market is ranging');
});

test('known classifications and threshold boundaries remain unchanged', () => {
  assert.equal(evaluateCase({ trendScore: 80, rangeConfidence: 40 }).regime, 'TRENDING_BULL');
  assert.equal(evaluateCase({ trendScore: 20, rangeConfidence: 40 }).regime, 'TRENDING_BEAR');
  assert.equal(evaluateCase({ trendScore: 50, rangeConfidence: 55 }).regime, 'RANGING');
  assert.equal(evaluateCase({ trendScore: null, rangeConfidence: null, volatilityLevel: 'HIGH', volatilityScore: 66 }).regime, 'HIGH_VOLATILITY');
  assert.equal(evaluateCase({ trendScore: null, rangeConfidence: null, volatilityLevel: 'LOW', volatilityScore: 34 }).regime, 'LOW_VOLATILITY');

  assert.equal(evaluateCase({ trendScore: 60, rangeConfidence: 40 }).regime, 'TRENDING_BULL');
  assert.equal(evaluateCase({ trendScore: 40, rangeConfidence: 40 }).regime, 'TRENDING_BEAR');
  assert.equal(evaluateCase({ trendScore: 50, rangeConfidence: 54 }).regime, 'RANGING');
});
