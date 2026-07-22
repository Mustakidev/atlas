const test = require('node:test');
const assert = require('node:assert/strict');

const { buildConfluenceResponse } = require('../../src/engine/confluenceResponseBuilder');

const components = { trend: { score: 80 } };
const missing = [{ name: 'rsi', reason: 'missing' }];

function values(overrides = {}) {
  return {
    timeframe: '1h',
    candleCount: 40,
    score: 80,
    bias: 'Bullish',
    confidence: 75,
    components,
    missing,
    timestamp: 123,
    calculatedAt: '2026-07-22T00:00:00.000Z',
    engineVersion: '1.0.0',
    lastUpdated: '2026-07-22T00:00:00.000Z',
    calculationTime: 4,
    dataSource: 'test',
    ...overrides,
  };
}

test('returns the exact response keys in the required order', () => {
  assert.deepEqual(Object.keys(buildConfluenceResponse(values())), [
    'timeframe',
    'candleCount',
    'score',
    'bias',
    'confidence',
    'components',
    'missing',
    'timestamp',
    'calculatedAt',
    'engineVersion',
    'lastUpdated',
    'calculationTime',
    'dataSource',
  ]);
});

test('passes every value through unchanged and preserves object references', () => {
  const input = values();
  const result = buildConfluenceResponse(input);

  for (const key of Object.keys(input)) assert.equal(result[key], input[key]);
  assert.equal(result.components, components);
  assert.equal(result.missing, missing);
});

test('preserves null, NaN, undefined, zero, false, and empty string values', () => {
  const result = buildConfluenceResponse(values({
    timeframe: undefined,
    candleCount: 0,
    score: NaN,
    bias: false,
    confidence: null,
    timestamp: '',
    calculatedAt: undefined,
    engineVersion: null,
    lastUpdated: false,
    calculationTime: 0,
    dataSource: '',
  }));

  assert.ok(Object.hasOwn(result, 'timeframe'));
  assert.equal(result.timeframe, undefined);
  assert.equal(result.candleCount, 0);
  assert.ok(Number.isNaN(result.score));
  assert.equal(result.bias, false);
  assert.equal(result.confidence, null);
  assert.equal(result.timestamp, '');
  assert.equal(result.calculatedAt, undefined);
  assert.equal(result.engineVersion, null);
  assert.equal(result.lastUpdated, false);
  assert.equal(result.calculationTime, 0);
  assert.equal(result.dataSource, '');
});

test('does not mutate inputs or nested components and missing values', () => {
  const input = values();
  const inputKeys = Object.keys(input);
  const componentsBefore = JSON.stringify(components);
  const missingBefore = JSON.stringify(missing);

  buildConfluenceResponse(input);

  assert.deepEqual(Object.keys(input), inputKeys);
  assert.equal(JSON.stringify(components), componentsBefore);
  assert.equal(JSON.stringify(missing), missingBefore);
});

test('returns fresh response objects with semantically equivalent repeated output', () => {
  const first = buildConfluenceResponse(values());
  const second = buildConfluenceResponse(values());

  assert.notEqual(first, second);
  assert.deepEqual(first, second);
});
