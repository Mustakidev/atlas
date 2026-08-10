const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeReplayAnalyzerInput,
  ReplayAnalyzerInputError,
  REPLAY_ANALYZER_SCHEMA_VERSION,
} = require('../../src/engine/replayAnalyzerInput');

const SNAPSHOT_KEYS = ['timestamp', 'price', 'volume', 'change24h'];

function snapshot(timestamp = '2024-01-01T00:00:00.000Z', overrides = {}) {
  return {
    timestamp,
    price: 100,
    volume: 12345,
    change24h: 1.25,
    ...overrides,
  };
}

function input(snapshots = [snapshot()]) {
  return {
    schemaVersion: REPLAY_ANALYZER_SCHEMA_VERSION,
    symbol: 'BTCUSDT',
    snapshots,
  };
}

function assertInputError(callback, { code, path, index, field }) {
  assert.throws(callback, error => {
    assert.ok(error instanceof ReplayAnalyzerInputError);
    assert.equal(error.name, 'ReplayAnalyzerInputError');
    assert.equal(error.code, code);
    assert.equal(error.path, path);
    assert.equal(error.index, index);
    assert.equal(error.field, field);
    assert.match(error.message, new RegExp(`${path.replace(/[()[\].]/g, '\\$&')}$`));
    return true;
  });
}

test('exports only the approved A1 API', () => {
  assert.deepEqual(Object.keys(require('../../src/engine/replayAnalyzerInput')), [
    'normalizeReplayAnalyzerInput',
    'ReplayAnalyzerInputError',
    'REPLAY_ANALYZER_SCHEMA_VERSION',
  ]);
});

test('normalizes the minimal valid input with exact key order', () => {
  const result = normalizeReplayAnalyzerInput(input());

  assert.deepEqual(Object.keys(result), ['schemaVersion', 'symbol', 'snapshots']);
  assert.deepEqual(Object.keys(result.snapshots[0]), SNAPSHOT_KEYS);
  assert.deepEqual(result, input());
});

test('normalizes multiple snapshots without capping or filtering', () => {
  const source = input([
    snapshot('1970-01-01T00:00:00.000Z'),
    snapshot('2024-01-01T00:00:00.000Z', { price: 101 }),
  ]);

  const result = normalizeReplayAnalyzerInput(source);

  assert.equal(result.snapshots.length, 2);
  assert.equal(result.snapshots[1].price, 101);
});

test('canonicalizes UTC, offsets, and one-to-three fractional seconds', () => {
  const result = normalizeReplayAnalyzerInput(input([
    snapshot('1970-01-01T00:00:00Z'),
    snapshot('1970-01-01T00:00:00.1Z'),
    snapshot('1970-01-01T00:00:00.12Z'),
    snapshot('1970-01-01T00:00:00.123Z'),
  ]));

  assert.deepEqual(result.snapshots.map(value => value.timestamp), [
    '1970-01-01T00:00:00.000Z',
    '1970-01-01T00:00:00.100Z',
    '1970-01-01T00:00:00.120Z',
    '1970-01-01T00:00:00.123Z',
  ]);

  assert.equal(
    normalizeReplayAnalyzerInput(input([snapshot('2024-01-01T01:00:00+01:00')])).snapshots[0].timestamp,
    '2024-01-01T00:00:00.000Z',
  );
  assert.equal(
    normalizeReplayAnalyzerInput(input([snapshot('2023-12-31T19:00:00-05:00')])).snapshots[0].timestamp,
    '2024-01-01T00:00:00.000Z',
  );
});

test('preserves epoch zero and exact symbol spelling', () => {
  const result = normalizeReplayAnalyzerInput({
    schemaVersion: 1,
    symbol: 'btc-usdt',
    snapshots: [snapshot('1970-01-01T00:00:00.000Z')],
  });

  assert.equal(result.symbol, 'btc-usdt');
  assert.equal(result.snapshots[0].timestamp, '1970-01-01T00:00:00.000Z');
});

test('deep-freezes output and keeps fresh snapshot identity', () => {
  const sourceSnapshot = snapshot();
  const source = input([sourceSnapshot]);
  const result = normalizeReplayAnalyzerInput(source);

  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.snapshots), true);
  assert.equal(Object.isFrozen(result.snapshots[0]), true);
  assert.notStrictEqual(result.snapshots[0], sourceSnapshot);

  assert.throws(() => {
    'use strict';
    result.symbol = 'MUTATED';
  }, TypeError);
  assert.throws(() => {
    'use strict';
    result.snapshots[0].price = 999;
  }, TypeError);
  assert.throws(() => {
    'use strict';
    result.snapshots.push(snapshot('2024-01-01T00:01:00.000Z'));
  }, TypeError);
  assert.equal(result.symbol, 'BTCUSDT');
  assert.equal(result.snapshots[0].price, 100);
});

test('preserves symbols exactly and accepts pre-epoch timestamps', () => {
  const result = normalizeReplayAnalyzerInput({
    schemaVersion: 1,
    symbol: ' BTCUSDT ',
    snapshots: [snapshot('1969-12-31T23:59:59.999Z')],
  });

  assert.equal(result.symbol, ' BTCUSDT ');
  assert.equal(result.snapshots[0].timestamp, '1969-12-31T23:59:59.999Z');
});

test('does not mutate input and repeated normalization is deterministic', () => {
  const source = input([snapshot('2024-01-01T00:00:00+00:00')]);
  const before = structuredClone(source);
  const first = normalizeReplayAnalyzerInput(source);
  const second = normalizeReplayAnalyzerInput(source);

  assert.deepEqual(source, before);
  assert.deepEqual(first, second);
  assert.notStrictEqual(first, second);
  assert.notStrictEqual(first.snapshots, second.snapshots);
  assert.notStrictEqual(first.snapshots[0], second.snapshots[0]);
});

test('rejects invalid top-level shapes and schema values', () => {
  for (const value of [null, [], 'input', 1, new Date(), new class Input {}()]) {
    assertInputError(() => normalizeReplayAnalyzerInput(value), {
      code: 'INVALID_INPUT',
      path: 'input',
      index: undefined,
      field: undefined,
    });
  }

  assertInputError(() => normalizeReplayAnalyzerInput({ ...input(), extra: true }), {
    code: 'UNKNOWN_PROPERTY',
    path: 'input.extra',
    index: undefined,
    field: undefined,
  });
  assertInputError(() => normalizeReplayAnalyzerInput({ ...input(), schemaVersion: 2 }), {
    code: 'UNSUPPORTED_SCHEMA_VERSION',
    path: 'schemaVersion',
    index: undefined,
    field: undefined,
  });
  assertInputError(() => normalizeReplayAnalyzerInput({ ...input(), schemaVersion: undefined }), {
    code: 'UNSUPPORTED_SCHEMA_VERSION',
    path: 'schemaVersion',
    index: undefined,
    field: undefined,
  });
});

test('rejects invalid symbol and snapshots containers', () => {
  for (const symbol of [undefined, 1]) {
    assertInputError(() => normalizeReplayAnalyzerInput({ ...input(), symbol }), {
      code: 'INVALID_SYMBOL',
      path: 'symbol',
      index: undefined,
      field: undefined,
    });
  }
  assertInputError(() => normalizeReplayAnalyzerInput({ ...input(), symbol: '' }), {
    code: 'INVALID_SYMBOL',
    path: 'symbol',
    index: undefined,
    field: undefined,
  });
  assertInputError(() => normalizeReplayAnalyzerInput({ ...input(), snapshots: undefined }), {
    code: 'INVALID_SNAPSHOTS',
    path: 'snapshots',
    index: undefined,
    field: undefined,
  });
  assertInputError(() => normalizeReplayAnalyzerInput({ ...input(), snapshots: {} }), {
    code: 'INVALID_SNAPSHOTS',
    path: 'snapshots',
    index: undefined,
    field: undefined,
  });
  assertInputError(() => normalizeReplayAnalyzerInput({ ...input(), snapshots: [] }), {
    code: 'INVALID_SNAPSHOTS',
    path: 'snapshots',
    index: undefined,
    field: undefined,
  });

  assertInputError(() => normalizeReplayAnalyzerInput({ ...input(), snapshots: new Array(1) }), {
    code: 'INVALID_SNAPSHOTS',
    path: 'snapshots[0]',
    index: 0,
    field: undefined,
  });
});

test('rejects all sparse arrays, including inherited numeric properties', () => {
  const valuesWithTrailingHole = [];
  valuesWithTrailingHole[1] = snapshot();
  assertInputError(() => normalizeReplayAnalyzerInput(input(valuesWithTrailingHole)), {
    code: 'INVALID_SNAPSHOTS',
    path: 'snapshots[0]',
    index: 0,
    field: undefined,
  });

  const valuesWithMiddleHole = [snapshot(), snapshot(), snapshot()];
  delete valuesWithMiddleHole[1];
  assertInputError(() => normalizeReplayAnalyzerInput(input(valuesWithMiddleHole)), {
    code: 'INVALID_SNAPSHOTS',
    path: 'snapshots[1]',
    index: 1,
    field: undefined,
  });

  const inheritedValues = new Array(1);
  const prototype = Object.create(Array.prototype);
  prototype[0] = snapshot();
  Object.setPrototypeOf(inheritedValues, prototype);
  assert.equal(0 in inheritedValues, true);
  assert.equal(Object.hasOwn(inheritedValues, 0), false);
  assertInputError(() => normalizeReplayAnalyzerInput(input(inheritedValues)), {
    code: 'INVALID_SNAPSHOTS',
    path: 'snapshots[0]',
    index: 0,
    field: undefined,
  });
});

test('rejects malformed snapshot objects and unknown properties', () => {
  for (const value of [null, [], new Date(), new class Snapshot {}()]) {
    assertInputError(() => normalizeReplayAnalyzerInput(input([value])), {
      code: 'INVALID_SNAPSHOTS',
      path: 'snapshots[0]',
      index: 0,
      field: undefined,
    });
  }

  assertInputError(() => normalizeReplayAnalyzerInput(input([{ ...snapshot(), extra: true }])), {
    code: 'UNKNOWN_PROPERTY',
    path: 'snapshots[0].extra',
    index: 0,
    field: undefined,
  });
});

test('rejects missing snapshot fields with field-specific codes', () => {
  for (const [field, code] of [
    ['timestamp', 'INVALID_TIMESTAMP'],
    ['price', 'INVALID_PRICE'],
    ['volume', 'INVALID_VOLUME'],
    ['change24h', 'INVALID_CHANGE24H'],
  ]) {
    const value = snapshot();
    delete value[field];
    assertInputError(() => normalizeReplayAnalyzerInput(input([value])), {
      code,
      path: `snapshots[0].${field}`,
      index: 0,
      field,
    });
  }
});

test('rejects shared snapshot object identity', () => {
  const shared = snapshot();

  assertInputError(() => normalizeReplayAnalyzerInput(input([shared, shared])), {
    code: 'SHARED_SNAPSHOT_REFERENCE',
    path: 'snapshots[1]',
    index: 1,
    field: undefined,
  });
});

test('rejects invalid timestamps', () => {
  for (const timestamp of [
    1704067200000,
    '2024-01-01T00:00:00',
    '2024-02-30T00:00:00.000Z',
    '2024-11-31T00:00:00.000Z',
    '2024-04-31T00:00:00.000Z',
    '2023-02-29T00:00:00.000Z',
    '2024-01-01T24:00:00.000Z',
    '2024-01-01T00:00:00.000+24:00',
    '275760-09-13T00:00:00.000Z',
  ]) {
    assertInputError(() => normalizeReplayAnalyzerInput(input([snapshot(timestamp)])), {
      code: 'INVALID_TIMESTAMP',
      path: 'snapshots[0].timestamp',
      index: 0,
      field: 'timestamp',
    });
  }
});

test('accepts valid Gregorian month ends and leap day', () => {
  for (const timestamp of [
    '2024-10-31T23:59:59.999Z',
    '2024-11-30T23:59:59.999Z',
    '2024-12-31T23:59:59.999Z',
    '2024-02-29T00:00:00.000Z',
  ]) {
    assert.equal(
      normalizeReplayAnalyzerInput(input([snapshot(timestamp)])).snapshots[0].timestamp,
      timestamp,
    );
  }
});

test('rejects duplicate, equal, and reverse timestamp ordering', () => {
  const first = '2024-01-01T00:00:00.000Z';
  const second = '2024-01-01T00:01:00.000Z';

  for (const timestamps of [[first, first], [first, second, second]]) {
    assertInputError(() => normalizeReplayAnalyzerInput(input(timestamps.map(value => snapshot(value)))), {
      code: 'DUPLICATE_TIMESTAMP',
      path: `snapshots[${timestamps.lastIndexOf(timestamps[timestamps.length - 1])}].timestamp`,
      index: timestamps.lastIndexOf(timestamps[timestamps.length - 1]),
      field: 'timestamp',
    });
  }

  assertInputError(() => normalizeReplayAnalyzerInput(input([
    snapshot(second),
    snapshot(first),
  ])), {
    code: 'NON_MONOTONIC_TIMESTAMP',
    path: 'snapshots[1].timestamp',
    index: 1,
    field: 'timestamp',
  });

  assertInputError(() => normalizeReplayAnalyzerInput(input([
    snapshot(first),
    snapshot(second),
    snapshot('2024-01-01T00:00:00+00:00'),
  ])), {
    code: 'DUPLICATE_TIMESTAMP',
    path: 'snapshots[2].timestamp',
    index: 2,
    field: 'timestamp',
  });
});

test('rejects invalid price values', () => {
  for (const price of ['100', 0, -1, NaN, Infinity]) {
    assertInputError(() => normalizeReplayAnalyzerInput(input([snapshot(undefined, { price })])), {
      code: 'INVALID_PRICE',
      path: 'snapshots[0].price',
      index: 0,
      field: 'price',
    });
  }
});

test('rejects invalid volume values', () => {
  for (const volume of ['12345', -1, NaN, Infinity]) {
    assertInputError(() => normalizeReplayAnalyzerInput(input([snapshot(undefined, { volume })])), {
      code: 'INVALID_VOLUME',
      path: 'snapshots[0].volume',
      index: 0,
      field: 'volume',
    });
  }
});

test('rejects invalid change24h values', () => {
  for (const change24h of ['1.25', NaN, Infinity]) {
    assertInputError(() => normalizeReplayAnalyzerInput(input([snapshot(undefined, { change24h })])), {
      code: 'INVALID_CHANGE24H',
      path: 'snapshots[0].change24h',
      index: 0,
      field: 'change24h',
    });
  }
});
