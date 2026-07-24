const test = require('node:test');
const assert = require('node:assert/strict');

const { ValidationEngine } = require('../../src/engine/validation');
const { createValidationDependencies } = require('../../src/engine/validationDependencies');

function config() {
  return { get() { return undefined; } };
}

const VALIDATION_METHODS = [
  '_validateTrend', '_validateStructure', '_validateRSI', '_validateEMA',
  '_validateMTF', '_validateConfluence', '_validateMACD', '_validateATR',
  '_validateBollinger', '_validateSignalHistory', '_validateBacktest',
  '_validateAnalytics', '_validatePaperTrading', '_validateRisk',
  '_validateAdvanceRisk', '_validateMarketRegime', '_validateRegimeDecision',
  '_validateMTFConfirmation',
];

function stubResult() {
  return { tests: [{ status: 'PASS' }], executionTime: 0 };
}

function stubValidationGroups(engine) {
  for (const method of VALIDATION_METHODS) {
    engine[method] = stubResult;
  }
}

function createStubbedEngine(factory, initial = createValidationDependencies({ config: config(), symbol: 'BTCUSDT' })) {
  const engine = new ValidationEngine({ ...initial, dependencyFactory: factory });
  stubValidationGroups(engine);
  return engine;
}

test('validation cache skips the factory and forced runs receive a fresh graph', () => {
  const created = [];
  const factory = () => {
    const dependencies = createValidationDependencies({ config: config(), symbol: 'BTCUSDT' });
    created.push(dependencies);
    return dependencies;
  };
  const initial = createValidationDependencies({ config: config(), symbol: 'BTCUSDT' });
  const engine = new ValidationEngine({ ...initial, dependencyFactory: factory });
  stubValidationGroups(engine);

  const first = engine.runAll(false);
  const cached = engine.runAll(false);
  const forced = engine.runAll(true);

  assert.equal(created.length, 2);
  assert.strictEqual(cached, first);
  assert.notStrictEqual(created[0].analyzer, created[1].analyzer);
  assert.notStrictEqual(created[0].indicatorRegistry, created[1].indicatorRegistry);
  assert.strictEqual(engine.analyzer, created[1].analyzer);
  assert.strictEqual(engine.indicatorRegistry, created[1].indicatorRegistry);
  assert.notStrictEqual(forced, first);
  assert.equal(forced.overall, 'PASS');
});

test('validation dependency factory isolates mutable indicator, candle, and MTF state', () => {
  const first = createValidationDependencies({ config: config(), symbol: 'BTCUSDT' });
  const second = createValidationDependencies({ config: config(), symbol: 'BTCUSDT' });
  const candles = [{ open: 100, high: 101, low: 99, close: 100, openTime: 1, timestamp: '1970-01-01T00:00:00.001Z' }];

  first.candleEngine.setValidationCandles('1h', candles);
  first.mtfConfirmationEngine.evaluate({
    direction: 'BUY',
    aggressive: true,
    timeframes: {
      '1m': { confluence: { bias: 'Bullish', score: 70, confidence: 70 } },
      '5m': { confluence: { bias: 'Bullish', score: 70, confidence: 70 } },
      '15m': { confluence: { bias: 'Bullish', score: 70, confidence: 70 } },
    },
  });

  assert.deepEqual(second.candleEngine.getCandles('1h'), []);
  const secondMtf = second.mtfConfirmationEngine.evaluate({ direction: 'BUY' });
  assert.equal(secondMtf.aggressive, false);
  assert.notStrictEqual(first.indicatorRegistry, second.indicatorRegistry);
  assert.notStrictEqual(first.advanceRiskEngine, second.advanceRiskEngine);
  assert.notStrictEqual(first.mtfConfirmationEngine, second.mtfConfirmationEngine);
});

test('failed forced factory execution preserves the previous successful cache', () => {
  const created = [];
  let factoryCalls = 0;
  const factory = () => {
    factoryCalls++;
    if (factoryCalls === 2) throw new Error('factory failure');
    const dependencies = createValidationDependencies({ config: config(), symbol: 'BTCUSDT' });
    created.push(dependencies);
    return dependencies;
  };
  const engine = createStubbedEngine(factory);
  const successful = engine.runAll(false);

  assert.throws(() => engine.runAll(true), /factory failure/);
  assert.strictEqual(engine.runAll(false), successful);

  const retry = engine.runAll(true);
  assert.notStrictEqual(retry, successful);
  assert.equal(factoryCalls, 3);
  assert.equal(created.length, 2);
});

test('failed forced validation execution preserves the previous successful cache', () => {
  let factoryCalls = 0;
  let throwOnValidation = false;
  const factory = () => {
    factoryCalls++;
    return createValidationDependencies({ config: config(), symbol: 'BTCUSDT' });
  };
  const engine = createStubbedEngine(factory);
  const successful = engine.runAll(false);
  engine._validateTrend = () => {
    if (throwOnValidation) throw new Error('validation failure');
    return stubResult();
  };
  throwOnValidation = true;

  assert.throws(() => engine.runAll(true), /validation failure/);
  assert.strictEqual(engine.runAll(false), successful);

  throwOnValidation = false;
  const retry = engine.runAll(true);
  assert.notStrictEqual(retry, successful);
  assert.equal(factoryCalls, 3);
});
