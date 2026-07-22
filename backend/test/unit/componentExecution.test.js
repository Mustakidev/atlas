const test = require('node:test');
const assert = require('node:assert/strict');

const { executeComponents } = require('../../src/engine/componentExecution');

const candles = [{ timestamp: 1 }, { timestamp: 2 }];
const context = { analysis: { momentum: { '1H': 50 } }, analyzerTf: '1H', tf: '1h' };

function definition(weight, calculate) {
  return { weight, calculate };
}

function run(components) {
  return executeComponents({ components, candles, tf: '1h', context });
}

function available(score = 80) {
  return { score, direction: 'bullish', available: true, confidence: 80, reason: null };
}

test('handles an empty iterable with fresh result collections', () => {
  const result = run([]);

  assert.deepEqual(result, { componentResults: {}, missing: [], diagnostics: [] });
  assert.notEqual(result.componentResults, {});
  assert.notEqual(result.missing, []);
  assert.notEqual(result.diagnostics, []);
});

test('executes one available component with exact arguments and normalized output', () => {
  const calls = [];
  const component = definition(0.3, (...args) => {
    calls.push(args);
    return available();
  });
  const result = run([['one', component]]);

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], candles);
  assert.equal(calls[0][1], '1h');
  assert.equal(calls[0][2], context);
  assert.deepEqual(result.componentResults, {
    one: { score: 80, direction: 'bullish', weight: 0.3, available: true, confidence: 80, reason: null },
  });
  assert.deepEqual(result.missing, []);
});

test('preserves supplied iterable order for results, missing entries, and diagnostics', () => {
  const components = new Map([
    ['first', [0.3, () => ({ score: null, available: false, reason: 'first missing' })]],
    ['second', [0.2, () => ({ score: null, available: false, reason: 'second missing' })]],
  ].map(([name, [weight, calculate]]) => [name, definition(weight, calculate)]));
  const result = run(components);

  assert.deepEqual(Object.keys(result.componentResults), ['first', 'second']);
  assert.deepEqual(result.missing, [
    { name: 'first', reason: 'first missing' },
    { name: 'second', reason: 'second missing' },
  ]);
  assert.deepEqual([...new Set(result.diagnostics.map(({ name }) => name))], ['first', 'second']);
});

test('preserves unavailable, null-score, explicit-reason, and default-reason raw semantics', () => {
  const result = run([
    ['unavailable', definition(1, () => ({ score: 40, available: false, reason: 'blocked' }))],
    ['null-score', definition(1, () => ({ score: null, available: true, reason: 'not ready' }))],
    ['default-reason', definition(1, () => ({ score: null, available: true }))],
  ]);

  assert.deepEqual(result.missing, [
    { name: 'unavailable', reason: 'blocked' },
    { name: 'null-score', reason: 'not ready' },
    { name: 'default-reason', reason: 'Insufficient data' },
  ]);
  assert.equal(result.componentResults.unavailable.available, false);
  assert.equal(result.componentResults['null-score'].score, null);
});

test('preserves exact thrown-error mapping for Error, string, and plain object values', () => {
  const result = run([
    ['error', definition(0.1, () => { throw new Error('failed'); })],
    ['string', definition(0.2, () => { throw 'string failure'; })],
    ['object', definition(0.3, () => { throw { failure: true }; })],
  ]);

  assert.deepEqual(result.componentResults, {
    error: { score: null, direction: null, weight: 0.1, available: false, confidence: null, reason: 'failed' },
    string: { score: null, direction: null, weight: 0.2, available: false, confidence: null, reason: undefined },
    object: { score: null, direction: null, weight: 0.3, available: false, confidence: null, reason: undefined },
  });
  assert.deepEqual(result.missing, [
    { name: 'error', reason: 'failed' },
    { name: 'string', reason: undefined },
    { name: 'object', reason: undefined },
  ]);
});

test('preserves the legacy null-throw behavior without adding fallback text', () => {
  assert.throws(() => run([['null', definition(1, () => { throw null; })]]), {
    name: 'TypeError',
  });
});

test('continues execution after an Error and executes later components in order', () => {
  const calls = [];
  const result = run([
    ['first', definition(1, () => { calls.push('first'); throw new Error('first failed'); })],
    ['second', definition(1, () => { calls.push('second'); return available(60); })],
    ['third', definition(1, () => { calls.push('third'); return available(40); })],
  ]);

  assert.deepEqual(calls, ['first', 'second', 'third']);
  assert.deepEqual(Object.keys(result.componentResults), ['first', 'second', 'third']);
  assert.equal(result.componentResults.second.score, 60);
  assert.equal(result.componentResults.third.score, 40);
});

test('collects validator diagnostics before normalization and preserves their order', () => {
  const result = run([
    ['first', definition(1, () => ({ score: 101, direction: 'wrong', available: true, confidence: 80, reason: null }))],
    ['second', definition(1, () => ({ score: NaN, direction: 'neutral', available: false, confidence: 80, reason: 'bad' }))],
  ]);

  assert.deepEqual(result.diagnostics.map(({ name, code }) => [name, code]), [
    ['first', 'RESULT_SCORE_OUT_OF_RANGE'],
    ['first', 'RESULT_DIRECTION_INVALID'],
    ['second', 'RESULT_SCORE_NAN'],
  ]);
  assert.equal(result.componentResults.first.score, 101);
  assert.ok(Number.isNaN(result.componentResults.second.score));
});

test('missing logic uses raw result values rather than normalized values', () => {
  const result = run([
    ['raw-null', definition(1, () => ({ score: null, available: undefined, reason: 'raw null score' }))],
    ['raw-undefined', definition(1, () => ({ score: undefined, available: 0, reason: 'raw available value' }))],
  ]);

  assert.deepEqual(result.missing, [{ name: 'raw-null', reason: 'raw null score' }]);
  assert.equal(result.componentResults['raw-null'].available, true);
  assert.equal(result.componentResults['raw-undefined'].available, true);
});

test('preserves undefined-score and NaN-score legacy behavior', () => {
  const result = run([
    ['undefined-score', definition(0.5, () => ({ score: undefined, available: true }))],
    ['nan-score', definition(0.5, () => ({ score: NaN, available: false }))],
  ]);

  assert.ok(Object.hasOwn(result.componentResults['undefined-score'], 'score'));
  assert.equal(result.componentResults['undefined-score'].score, undefined);
  assert.ok(Number.isNaN(result.componentResults['nan-score'].score));
  assert.deepEqual(result.missing, [{ name: 'nan-score', reason: 'Insufficient data' }]);
});

test('does not mutate the iterable, component definitions, or context', () => {
  const first = definition(0.3, () => available());
  const second = definition(0.7, () => available(60));
  const entries = [['first', first], ['second', second]];
  const beforeContext = { ...context };
  const beforeEntries = [...entries];
  const beforeFirst = { ...first };
  const beforeSecond = { ...second };

  run(entries);

  assert.deepEqual(entries, beforeEntries);
  assert.deepEqual(first, beforeFirst);
  assert.deepEqual(second, beforeSecond);
  assert.deepEqual(context, beforeContext);
});

test('repeated calls do not leak results or diagnostics and return fresh collections', () => {
  const components = [
    ['first', definition(1, () => ({ score: null, available: false, reason: 'missing' }))],
  ];
  const first = run(components);
  const second = run(components);

  assert.notEqual(first, second);
  assert.notEqual(first.componentResults, second.componentResults);
  assert.notEqual(first.missing, second.missing);
  assert.notEqual(first.diagnostics, second.diagnostics);
  assert.deepEqual(first, second);
});

test('uses an explicitly supplied diagnostics sink without replacing it', () => {
  const sink = [];
  const result = executeComponents({
    components: [['one', definition(1, () => available())]],
    candles,
    tf: '1h',
    context,
    diagnostics: sink,
  });

  assert.equal(result.diagnostics, sink);
  assert.deepEqual(sink, []);
});
