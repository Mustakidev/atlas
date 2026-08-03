const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MIN_REPLAY_CANDLES,
  ReplayInputError,
  SUPPORTED_TIMEFRAMES,
  normalizeReplayInput,
} = require('../../src/engine/replayInput');

const BASE_TIME = Date.parse('2024-01-01T00:00:00.000Z');
const HOUR = 3600000;

function candle(index, overrides = {}) {
  const openTime = BASE_TIME + index * HOUR;
  return {
    open: 100 + index,
    high: 102 + index,
    low: 98 + index,
    close: 101 + index,
    volume: 1000 + index,
    openTime,
    timestamp: new Date(openTime).toISOString(),
    ...overrides,
  };
}

function candles(count = MIN_REPLAY_CANDLES, overrides = {}) {
  return Array.from({ length: count }, (_, index) => candle(index, overrides));
}

function errorFor(input, timeframe) {
  try {
    normalizeReplayInput(input, timeframe);
  } catch (error) {
    assert.ok(error instanceof ReplayInputError);
    return error;
  }
  assert.fail('Expected normalizeReplayInput to reject');
}

test('normalizes valid candles into the frozen internal contract', () => {
  const input = candles();
  const result = normalizeReplayInput(input, '1H');

  assert.deepEqual(Object.keys(result), ['schemaVersion', 'timeframe', 'candles']);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.timeframe, '1h');
  assert.deepEqual(result.candles[0], {
    openTime: BASE_TIME,
    timestamp: '2024-01-01T00:00:00.000Z',
    open: 100,
    high: 102,
    low: 98,
    close: 101,
    volume: 1000,
  });
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.candles));
  assert.ok(Object.isFrozen(result.candles[0]));
  assert.throws(() => result.candles.push(candle(99)), TypeError);
  result.candles[0].open = -1;
  assert.equal(result.candles[0].open, 100);
});

test('accepts timestamp-only UTC input and derives canonical timestamp', () => {
  const input = candles();
  input[0].timestamp = '2024-01-01T00:00:00.000Z';
  delete input[0].openTime;
  const result = normalizeReplayInput(input);

  assert.equal(result.candles[0].openTime, BASE_TIME);
  assert.equal(result.candles[0].timestamp, '2024-01-01T00:00:00.000Z');
});

test('accepts explicit positive offsets and normalizes them to UTC', () => {
  const timestampOnly = candles();
  timestampOnly[0].timestamp = '2024-01-01T05:30:00.000+05:30';
  delete timestampOnly[0].openTime;
  const normalizedTimestamp = normalizeReplayInput(timestampOnly);

  assert.equal(normalizedTimestamp.candles[0].openTime, BASE_TIME);
  assert.equal(normalizedTimestamp.candles[0].timestamp, '2024-01-01T00:00:00.000Z');

  const matching = candles();
  matching[0].timestamp = '2024-01-01T05:30:00.000+05:30';
  const normalizedMatching = normalizeReplayInput(matching);

  assert.equal(normalizedMatching.candles[0].openTime, BASE_TIME);
  assert.equal(normalizedMatching.candles[0].timestamp, '2024-01-01T00:00:00.000Z');
});

test('accepts explicit negative offsets and normalizes them to UTC', () => {
  const input = candles();
  input[0].timestamp = '2023-12-31T19:00:00.000-05:00';
  delete input[0].openTime;
  const result = normalizeReplayInput(input);

  assert.equal(result.candles[0].openTime, BASE_TIME);
  assert.equal(result.candles[0].timestamp, '2024-01-01T00:00:00.000Z');
});

test('requires matching openTime and timestamp when both are supplied', () => {
  const input = candles();
  const result = normalizeReplayInput(input);
  assert.equal(result.candles[0].openTime, BASE_TIME);

  input[0].timestamp = new Date(BASE_TIME + 1).toISOString();
  const error = errorFor(input);
  assert.equal(error.code, 'INVALID_TIMESTAMP');
  assert.equal(error.index, 0);
  assert.equal(error.path, 'candles[0].timestamp');
});

test('does not mutate input and removes extra fields', () => {
  const input = candles();
  input[0].extra = { ignored: true };
  const before = structuredClone(input);
  const result = normalizeReplayInput(input);

  assert.deepEqual(input, before);
  assert.equal('extra' in result.candles[0], false);
});

test('repeated normalization is deterministic', () => {
  const input = candles();
  assert.deepEqual(normalizeReplayInput(input), normalizeReplayInput(input));
});

test('defaults timeframe and accepts every supported timeframe', () => {
  assert.equal(normalizeReplayInput(candles()).timeframe, '1h');
  for (const timeframe of SUPPORTED_TIMEFRAMES) {
    assert.equal(normalizeReplayInput(candles(), timeframe.toUpperCase()).timeframe, timeframe);
  }
});

test('rejects blank, non-string, alias, and unsupported timeframes', () => {
  for (const timeframe of ['', '   ', null, 1, '1d', '2h']) {
    const error = errorFor(candles(), timeframe);
    assert.equal(error.code, 'INVALID_TIMEFRAME');
    assert.equal(error.name, 'ReplayInputError');
    assert.equal(typeof error.message, 'string');
  }
});

test('rejects non-array, empty, and insufficient input', () => {
  assert.equal(errorFor({ candles: candles() }).code, 'INPUT_MUST_BE_ARRAY');
  assert.equal(errorFor([]).code, 'EMPTY_CANDLES');
  assert.equal(errorFor(candles(MIN_REPLAY_CANDLES - 1)).code, 'INSUFFICIENT_CANDLES');
});

test('rejects missing and non-finite OHLC fields', () => {
  for (const field of ['open', 'high', 'low', 'close']) {
    const input = candles();
    delete input[0][field];
    const error = errorFor(input);
    assert.equal(error.code, 'MISSING_OHLC');
    assert.equal(error.field, field);
    assert.equal(error.index, 0);
  }

  for (const value of [NaN, Infinity, -Infinity, '100']) {
    const input = candles();
    input[0].open = value;
    assert.equal(errorFor(input).code, 'INVALID_CANDLE');
  }
});

test('rejects inconsistent OHLC values', () => {
  for (const overrides of [
    { high: 97 },
    { low: 101 },
    { open: 103 },
    { close: 97 },
  ]) {
    assert.equal(errorFor(candles(MIN_REPLAY_CANDLES, overrides)).code, 'INCONSISTENT_OHLC');
  }
});

test('rejects missing, negative, non-finite, and string volume', () => {
  for (const value of [undefined, null, -1, NaN, Infinity, '100']) {
    const input = candles();
    if (value === undefined) delete input[0].volume;
    else input[0].volume = value;
    const error = errorFor(input);
    assert.equal(error.code, 'INVALID_VOLUME');
    assert.equal(error.field, 'volume');
  }
});

test('rejects missing and invalid timestamp identity', () => {
  const missing = candles();
  delete missing[0].openTime;
  delete missing[0].timestamp;
  assert.equal(errorFor(missing).code, 'MISSING_TIMESTAMP');

  const invalidString = candles();
  invalidString[0].timestamp = 'not-a-date';
  delete invalidString[0].openTime;
  assert.equal(errorFor(invalidString).code, 'INVALID_TIMESTAMP');

  for (const timestamp of [
    '2024-01-01T00:00:00',
    '2024-01-01',
    '01/01/2024',
    '2024-02-30T00:00:00.000Z',
    '2024-01-01T25:00:00.000Z',
    '2024-01-01T00:00:00.000+25:00',
  ]) {
    const input = candles();
    input[0].timestamp = timestamp;
    delete input[0].openTime;
    assert.equal(errorFor(input).code, 'INVALID_TIMESTAMP');
  }

  const numericTimestamp = candles();
  numericTimestamp[0].timestamp = BASE_TIME;
  delete numericTimestamp[0].openTime;
  assert.equal(errorFor(numericTimestamp).code, 'INVALID_TIMESTAMP');
});

test('rejects negative, fractional, seconds-like, and out-of-range timestamps', () => {
  for (const [value, code] of [
    [-1, 'INVALID_TIMESTAMP'],
    [BASE_TIME + 0.5, 'INVALID_TIMESTAMP'],
    [1704067200, 'INVALID_TIMESTAMP_UNIT'],
    [8640000000000001, 'INVALID_TIMESTAMP'],
  ]) {
    const input = candles();
    input[0].openTime = value;
    delete input[0].timestamp;
    const error = errorFor(input);
    assert.equal(error.name, 'ReplayInputError');
    assert.equal(error.index, 0);
    assert.equal(error.code, code);
  }
});

test('rejects duplicate and out-of-order timestamps without sorting', () => {
  const duplicate = candles();
  duplicate[1].openTime = duplicate[0].openTime;
  delete duplicate[1].timestamp;
  const duplicateError = errorFor(duplicate);
  assert.equal(duplicateError.code, 'DUPLICATE_TIMESTAMP');
  assert.equal(duplicateError.index, 1);
  assert.equal(duplicateError.path, 'candles[1].openTime');

  const outOfOrder = candles();
  outOfOrder[2].openTime = outOfOrder[1].openTime - HOUR / 2;
  delete outOfOrder[2].timestamp;
  const orderError = errorFor(outOfOrder);
  assert.equal(orderError.code, 'NON_CHRONOLOGICAL_INPUT');
  assert.equal(orderError.index, 2);
  assert.equal(orderError.path, 'candles[2].openTime');
});

test('duplicate precedence wins over chronological order for non-consecutive repeats', () => {
  const input = candles();
  input[2].openTime = input[0].openTime;
  delete input[2].timestamp;
  const error = errorFor(input);

  assert.equal(error.code, 'DUPLICATE_TIMESTAMP');
  assert.equal(error.index, 2);
  assert.equal(error.field, 'openTime');
  assert.equal(error.path, 'candles[2].openTime');
});

test('exposes structured errors for malformed candle input', () => {
  const input = candles();
  input[7] = null;
  const error = errorFor(input);

  assert.equal(error.name, 'ReplayInputError');
  assert.equal(error.code, 'INVALID_CANDLE');
  assert.equal(error.index, 7);
  assert.equal(error.path, 'candles[7]');
  assert.equal(typeof error.message, 'string');
});
