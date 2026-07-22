const test = require('node:test');
const assert = require('node:assert/strict');

const { inspectDefinition, inspectResult } = require('../../src/engine/componentValidator');

function codes(diagnostics) {
  return diagnostics.map(({ code, severity, field, name }) => ({ code, severity, field, name }));
}

test('valid definitions and results produce no diagnostics', () => {
  assert.deepEqual(inspectDefinition('trend', { weight: 0.3, calculate() {} }), []);
  assert.deepEqual(inspectResult('trend', {
    score: 80,
    direction: 'bullish',
    available: true,
    confidence: 80,
    reason: null,
  }), []);
});

test('reports unusual names, weights, calculators, and extra fields', () => {
  assert.deepEqual(codes(inspectDefinition(undefined, { weight: undefined })), [
    { code: 'COMPONENT_NAME_UNDEFINED', severity: 'WARNING', field: 'name', name: undefined },
    { code: 'COMPONENT_WEIGHT_MISSING', severity: 'WARNING', field: 'weight', name: undefined },
    { code: 'COMPONENT_CALCULATE_MISSING', severity: 'ERROR', field: 'calculate', name: undefined },
  ]);
  assert.deepEqual(codes(inspectDefinition(null, { weight: null, calculate: null, extra: true })), [
    { code: 'COMPONENT_NAME_NULL', severity: 'WARNING', field: 'name', name: null },
    { code: 'COMPONENT_WEIGHT_NULL', severity: 'WARNING', field: 'weight', name: null },
    { code: 'COMPONENT_CALCULATE_INVALID', severity: 'ERROR', field: 'calculate', name: null },
    { code: 'COMPONENT_EXTRA_FIELDS', severity: 'INFO', field: 'component', name: null },
  ]);
  assert.deepEqual(codes(inspectDefinition('', { weight: -1, calculate: 1 })), [
    { code: 'COMPONENT_NAME_EMPTY', severity: 'WARNING', field: 'name', name: '' },
    { code: 'COMPONENT_WEIGHT_NEGATIVE', severity: 'WARNING', field: 'weight', name: '' },
    { code: 'COMPONENT_CALCULATE_INVALID', severity: 'ERROR', field: 'calculate', name: '' },
  ]);
  assert.deepEqual(codes(inspectDefinition(42, { weight: 0, calculate() {}, extra: true })), [
    { code: 'COMPONENT_NAME_NON_STRING', severity: 'INFO', field: 'name', name: 42 },
    { code: 'COMPONENT_WEIGHT_ZERO', severity: 'INFO', field: 'weight', name: 42 },
    { code: 'COMPONENT_EXTRA_FIELDS', severity: 'INFO', field: 'component', name: 42 },
  ]);
});

test('reports all numeric and non-numeric weight cases', () => {
  assert.deepEqual(codes(inspectDefinition('nan', { weight: NaN, calculate() {} })), [
    { code: 'COMPONENT_WEIGHT_NAN', severity: 'ERROR', field: 'weight', name: 'nan' },
  ]);
  assert.deepEqual(codes(inspectDefinition('infinite', { weight: Infinity, calculate() {} })), [
    { code: 'COMPONENT_WEIGHT_INFINITE', severity: 'ERROR', field: 'weight', name: 'infinite' },
  ]);
  assert.deepEqual(codes(inspectDefinition('text', { weight: '0.3', calculate() {} })), [
    { code: 'COMPONENT_WEIGHT_NON_NUMERIC', severity: 'WARNING', field: 'weight', name: 'text' },
  ]);
});

test('reports malformed results without changing inputs', () => {
  assert.deepEqual(codes(inspectResult('x', null)), [
    { code: 'RESULT_NOT_OBJECT', severity: 'ERROR', field: 'result', name: 'x' },
  ]);
  assert.deepEqual(codes(inspectResult('x', 1)), [
    { code: 'RESULT_NOT_OBJECT', severity: 'ERROR', field: 'result', name: 'x' },
  ]);

  const result = {
    score: NaN,
    direction: 'BULLISH',
    available: 1,
    confidence: Infinity,
    reason: { internal: true },
    extra: true,
  };
  const before = { ...result };
  assert.deepEqual(codes(inspectResult('x', result)), [
    { code: 'RESULT_SCORE_NAN', severity: 'ERROR', field: 'score', name: 'x' },
    { code: 'RESULT_DIRECTION_INVALID', severity: 'WARNING', field: 'direction', name: 'x' },
    { code: 'RESULT_AVAILABLE_NON_BOOLEAN', severity: 'WARNING', field: 'available', name: 'x' },
    { code: 'RESULT_CONFIDENCE_INFINITE', severity: 'ERROR', field: 'confidence', name: 'x' },
    { code: 'RESULT_REASON_NON_STRING', severity: 'INFO', field: 'reason', name: 'x' },
    { code: 'RESULT_EXTRA_FIELDS', severity: 'INFO', field: 'result', name: 'x' },
  ]);
  assert.deepEqual(result, before);
});

test('reports missing, null, range, promise-like, array, and extra result values', () => {
  assert.deepEqual(codes(inspectResult('missing', {})), [
    { code: 'RESULT_SCORE_MISSING', severity: 'WARNING', field: 'score', name: 'missing' },
    { code: 'RESULT_DIRECTION_MISSING', severity: 'INFO', field: 'direction', name: 'missing' },
    { code: 'RESULT_AVAILABLE_MISSING', severity: 'INFO', field: 'available', name: 'missing' },
    { code: 'RESULT_CONFIDENCE_MISSING', severity: 'INFO', field: 'confidence', name: 'missing' },
  ]);
  assert.deepEqual(codes(inspectResult('range', {
    score: 101,
    direction: 'sideways',
    available: true,
    confidence: -1,
    reason: 0,
  })), [
    { code: 'RESULT_SCORE_OUT_OF_RANGE', severity: 'WARNING', field: 'score', name: 'range' },
    { code: 'RESULT_DIRECTION_INVALID', severity: 'WARNING', field: 'direction', name: 'range' },
    { code: 'RESULT_CONFIDENCE_OUT_OF_RANGE', severity: 'WARNING', field: 'confidence', name: 'range' },
    { code: 'RESULT_REASON_NON_STRING', severity: 'INFO', field: 'reason', name: 'range' },
  ]);
  assert.deepEqual(codes(inspectResult('array', [])), [
    { code: 'RESULT_ARRAY', severity: 'WARNING', field: 'result', name: 'array' },
    { code: 'RESULT_SCORE_MISSING', severity: 'WARNING', field: 'score', name: 'array' },
    { code: 'RESULT_DIRECTION_MISSING', severity: 'INFO', field: 'direction', name: 'array' },
    { code: 'RESULT_AVAILABLE_MISSING', severity: 'INFO', field: 'available', name: 'array' },
    { code: 'RESULT_CONFIDENCE_MISSING', severity: 'INFO', field: 'confidence', name: 'array' },
  ]);
  assert.deepEqual(codes(inspectResult('promise', { then() {} })), [
    { code: 'RESULT_PROMISE_LIKE', severity: 'ERROR', field: 'result', name: 'promise' },
    { code: 'RESULT_SCORE_MISSING', severity: 'WARNING', field: 'score', name: 'promise' },
    { code: 'RESULT_DIRECTION_MISSING', severity: 'INFO', field: 'direction', name: 'promise' },
    { code: 'RESULT_AVAILABLE_MISSING', severity: 'INFO', field: 'available', name: 'promise' },
    { code: 'RESULT_CONFIDENCE_MISSING', severity: 'INFO', field: 'confidence', name: 'promise' },
    { code: 'RESULT_EXTRA_FIELDS', severity: 'INFO', field: 'result', name: 'promise' },
  ]);
});

test('reports all requested score, direction, availability, confidence, and reason cases', () => {
  const values = {
    score: null,
    direction: null,
    available: 'true',
    confidence: null,
    reason: [],
  };
  assert.deepEqual(codes(inspectResult('values', values)), [
    { code: 'RESULT_SCORE_NULL', severity: 'INFO', field: 'score', name: 'values' },
    { code: 'RESULT_DIRECTION_NULL', severity: 'INFO', field: 'direction', name: 'values' },
    { code: 'RESULT_AVAILABLE_NON_BOOLEAN', severity: 'WARNING', field: 'available', name: 'values' },
    { code: 'RESULT_CONFIDENCE_NULL', severity: 'INFO', field: 'confidence', name: 'values' },
    { code: 'RESULT_REASON_NON_STRING', severity: 'INFO', field: 'reason', name: 'values' },
  ]);
  assert.deepEqual(codes(inspectResult('nonNumeric', {
    score: '80', direction: 'bullish', available: false, confidence: {}, reason: 'ok',
  })), [
    { code: 'RESULT_SCORE_NON_NUMERIC', severity: 'WARNING', field: 'score', name: 'nonNumeric' },
    { code: 'RESULT_CONFIDENCE_NON_NUMERIC', severity: 'WARNING', field: 'confidence', name: 'nonNumeric' },
  ]);
  assert.deepEqual(codes(inspectResult('infinite', {
    score: -Infinity, direction: 'neutral', available: true, confidence: NaN, reason: 'ok',
  })), [
    { code: 'RESULT_SCORE_INFINITE', severity: 'ERROR', field: 'score', name: 'infinite' },
    { code: 'RESULT_CONFIDENCE_NAN', severity: 'ERROR', field: 'confidence', name: 'infinite' },
  ]);
});

test('repeated inspection is deterministic and malformed input never throws', () => {
  const values = [undefined, null, 1, 'result', [], {}, Promise.resolve(1)];
  for (const value of values) {
    assert.doesNotThrow(() => inspectResult('x', value));
    assert.deepEqual(inspectResult('x', value), inspectResult('x', value));
  }

  const definition = { weight: 0.3, calculate() {}, extra: true };
  assert.deepEqual(inspectDefinition('x', definition), inspectDefinition('x', definition));
  assert.deepEqual(definition, { weight: 0.3, calculate: definition.calculate, extra: true });
});
