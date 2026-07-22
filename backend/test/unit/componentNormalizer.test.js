const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeComponentResult } = require('../../src/engine/componentNormalizer');

test('normalizes an available result with the exact key order', () => {
  const result = normalizeComponentResult({
    score: 80,
    direction: 'bullish',
    available: true,
    confidence: 75,
    reason: 'ready',
  }, 0.3);

  assert.deepEqual(result, {
    score: 80,
    direction: 'bullish',
    weight: 0.3,
    available: true,
    confidence: 75,
    reason: 'ready',
  });
  assert.deepEqual(Object.keys(result), [
    'score',
    'direction',
    'weight',
    'available',
    'confidence',
    'reason',
  ]);
});

test('normalizes false availability and preserves truthy non-false values', () => {
  assert.equal(normalizeComponentResult({ available: false }, 1).available, false);
  for (const available of [undefined, null, 0, '', NaN]) {
    assert.equal(normalizeComponentResult({ available }, 1).available, true);
  }
});

test('preserves score values including null, undefined, zero, false, empty string, and NaN', () => {
  for (const score of [null, undefined, 0, false, '', NaN]) {
    const normalized = normalizeComponentResult({ score }, 1);
    assert.ok(Object.hasOwn(normalized, 'score'));
    if (Number.isNaN(score)) assert.ok(Number.isNaN(normalized.score));
    else assert.equal(normalized.score, score);
  }

  const missingScore = normalizeComponentResult({}, 1);
  assert.ok(Object.hasOwn(missingScore, 'score'));
  assert.equal(missingScore.score, undefined);
});

test('preserves missing and null directions exactly', () => {
  const missing = normalizeComponentResult({}, 1);
  assert.ok(Object.hasOwn(missing, 'direction'));
  assert.equal(missing.direction, undefined);
  assert.equal(normalizeComponentResult({ direction: null }, 1).direction, null);
});

test('converts falsy confidence values to null', () => {
  for (const confidence of [0, -0, null, undefined, false, '', NaN]) {
    assert.equal(normalizeComponentResult({ confidence }, 1).confidence, null);
  }
});

test('preserves truthy confidence values', () => {
  const objectConfidence = { value: 80 };
  for (const confidence of [1, -1, Infinity, '80', objectConfidence, []]) {
    assert.equal(normalizeComponentResult({ confidence }, 1).confidence, confidence);
  }
});

test('converts empty and missing reasons to null and preserves truthy reasons', () => {
  assert.equal(normalizeComponentResult({ reason: '' }, 1).reason, null);
  assert.equal(normalizeComponentResult({}, 1).reason, null);
  assert.equal(normalizeComponentResult({ reason: 'ready' }, 1).reason, 'ready');
});

test('preserves weight values exactly', () => {
  for (const weight of [0, null, undefined, NaN]) {
    const normalized = normalizeComponentResult({}, weight);
    assert.ok(Object.hasOwn(normalized, 'weight'));
    if (Number.isNaN(weight)) assert.ok(Number.isNaN(normalized.weight));
    else assert.equal(normalized.weight, weight);
  }
});

test('does not mutate input and returns deterministic output', () => {
  const result = {
    score: 80,
    direction: 'bullish',
    available: true,
    confidence: 75,
    reason: 'ready',
  };
  const before = { ...result };

  assert.deepEqual(normalizeComponentResult(result, 0.3), normalizeComponentResult(result, 0.3));
  assert.deepEqual(result, before);
});
