const test = require('node:test');
const assert = require('node:assert/strict');

const { calculateConfidence } = require('../../src/engine/confidenceCalculator');
const { ConfluenceEngine } = require('../../src/engine/confluence');

function availableResults(confidences) {
  return Object.fromEntries(confidences.map((confidence, index) => [`component${index}`, {
    available: true,
    confidence,
  }]));
}

test('calculates 5 of 5 available components at confidence 80 as 80', () => {
  assert.equal(calculateConfidence(availableResults([80, 80, 80, 80, 80]), 5), 80);
});

test('calculates 4 of 5 available components at confidence 80 as 64', () => {
  assert.equal(calculateConfidence(availableResults([80, 80, 80, 80]), 5), 64);
});

test('calculates 3 of 5 available components at confidence 80 as 48', () => {
  assert.equal(calculateConfidence(availableResults([80, 80, 80]), 5), 48);
});

test('returns 0 when no components are available', () => {
  assert.equal(calculateConfidence({
    trend: { available: false, confidence: 80 },
    structure: { available: true, confidence: null },
  }, 5), 0);
});

test('calculates mixed confidence values with coverage penalty', () => {
  assert.equal(calculateConfidence(availableResults([100, 50, 0]), 5), 30);
});

test('preserves zero confidence as an available value', () => {
  assert.equal(calculateConfidence(availableResults([0]), 5), 0);
});

test('preserves null confidence handling and ignores undefined confidence', () => {
  assert.equal(calculateConfidence({
    missing: { available: true, confidence: null },
    available: { available: true, confidence: 80 },
  }, 2), 40);
  assert.equal(calculateConfidence({
    missing: { available: true, confidence: undefined },
  }, 1), 0);
});

test('ignores non-finite and nonnumeric confidence values', () => {
  const result = calculateConfidence({
    valid: { available: true, confidence: 80 },
    nan: { available: true, confidence: NaN },
    positiveInfinity: { available: true, confidence: Infinity },
    negativeInfinity: { available: true, confidence: -Infinity },
    string: { available: true, confidence: '80' },
  }, 5);

  assert.equal(result, 16);
  assert.ok(Number.isFinite(result));
});

test('reduces coverage when a dynamically registered component is unavailable', () => {
  const engine = new ConfluenceEngine({
    analyzer: { getAnalysis: () => null },
    indicatorRegistry: { get: () => null },
    structureEngine: { calculate: () => ({ ready: false }) },
    candleEngine: null,
    logger: { info() {}, warn() {}, error() {} },
    config: { get: () => 0 },
    symbol: 'BTCUSDT',
  });
  engine.registerComponent('unavailable', {
    weight: 0,
    calculate: () => ({ available: false, score: null, confidence: null }),
  });

  assert.equal(engine._computeConfidence(availableResults([80, 80, 80, 80, 80])), 67);
});

test('returns identical output for repeated identical input', () => {
  const results = availableResults([90, 60, 30]);
  assert.equal(calculateConfidence(results, 5), calculateConfidence(results, 5));
});
