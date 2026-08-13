const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createReplayMtfCandleAdapter,
  ReplayMtfCandleAdapterError,
} = require('../../src/engine/replayMtfCandleAdapter');
const {
  normalizeReplayMultiTimeframeInput,
  REPLAY_MTF_DURATIONS_MS,
  REPLAY_MTF_SCHEMA_VERSION,
} = require('../../src/engine/replayMultiTimeframeInput');

const BASE_TIME = Date.parse('2024-01-01T00:00:00.000Z');
const HOUR = REPLAY_MTF_DURATIONS_MS['1h'];
const SUPPORTED_TIMEFRAMES = ['1m', '5m', '15m'];
const INPUT_TIMEFRAMES = [...SUPPORTED_TIMEFRAMES, '1h'];

function makeCandle(timeframe, openTime, index) {
  const value = 100 + index + (SUPPORTED_TIMEFRAMES.indexOf(timeframe) + 1) / 10;
  return {
    openTime,
    timestamp: new Date(openTime).toISOString(),
    open: value,
    high: value + 1,
    low: value - 1,
    close: value + 0.5,
    volume: index + 1,
  };
}

function makeRawInput({ primaryCount = 51, tails = {} } = {}) {
  const primaryEnd = BASE_TIME + primaryCount * HOUR;
  const timeframes = {};

  for (const timeframe of INPUT_TIMEFRAMES) {
    const duration = REPLAY_MTF_DURATIONS_MS[timeframe];
    const count = Math.ceil((primaryEnd - BASE_TIME) / duration) + (tails[timeframe] || 0);
    timeframes[timeframe] = Array.from({ length: count }, (_, index) =>
      makeCandle(timeframe, BASE_TIME + index * duration, index));
  }

  return {
    schemaVersion: REPLAY_MTF_SCHEMA_VERSION,
    primaryTimeframe: '1h',
    sourcePolicy: 'independent',
    timeframes,
  };
}

function normalizedInput(options) {
  return normalizeReplayMultiTimeframeInput(makeRawInput(options));
}

function adapter(options) {
  return createReplayMtfCandleAdapter(normalizedInput(options));
}

function assertError(callback, code, boundaryTime) {
  assert.throws(callback, error => {
    assert.ok(error instanceof ReplayMtfCandleAdapterError);
    assert.equal(error.code, code);
    if (arguments.length >= 3) assert.equal(error.boundaryTime, boundaryTime ?? null);
    return true;
  });
}

function commitAt(replay, boundaryTime) {
  return replay.commitBoundary(replay.prepareBoundary({ boundaryTime }));
}

function frozenInputCopy(input, timeframes = input.timeframes) {
  return Object.freeze({ ...input, timeframes: Object.freeze(timeframes) });
}

test('exports exactly the approved API', () => {
  assert.deepEqual(Object.keys(require('../../src/engine/replayMtfCandleAdapter')).sort(), [
    'ReplayMtfCandleAdapterError',
    'createReplayMtfCandleAdapter',
  ]);
});

test('returns a frozen facade with exactly the approved methods', () => {
  const replay = adapter();

  assert.equal(Object.isFrozen(replay), true);
  assert.deepEqual(Object.keys(replay), [
    'getCandles',
    'getActive',
    'getAllTimeframes',
    'prepareBoundary',
    'commitBoundary',
  ]);
});

test('requires normalized schema-v2 independent input without normalizing it', () => {
  const valid = normalizedInput();
  const invalidCases = [
    [Object.freeze({ ...valid, schemaVersion: 1 }), 'INVALID_INPUT'],
    [Object.freeze({ ...valid, primaryTimeframe: '5m' }), 'INVALID_INPUT'],
    [Object.freeze({ ...valid, sourcePolicy: 'aggregated' }), 'INVALID_INPUT'],
    [frozenInputCopy(valid, { ...valid.timeframes, '1h': undefined }), 'INVALID_INPUT'],
    [frozenInputCopy(valid, { ...valid.timeframes, '30m': valid.timeframes['1m'] }), 'INVALID_INPUT'],
  ];

  for (const [input, code] of invalidCases) assertError(() => createReplayMtfCandleAdapter(input), code);
});

test('rejects unfrozen normalized streams and candles', () => {
  const valid = normalizedInput();
  const mutableStream = [...valid.timeframes['1m']];
  const mutableInput = frozenInputCopy(valid, {
    ...valid.timeframes,
    '1m': mutableStream,
  });
  assertError(() => createReplayMtfCandleAdapter(mutableInput), 'INVALID_INPUT');

  const mutableCandles = valid.timeframes['5m'].map(candle => ({ ...candle }));
  const mutableCandleInput = frozenInputCopy(valid, {
    ...valid.timeframes,
    '5m': Object.freeze(mutableCandles),
  });
  assertError(() => createReplayMtfCandleAdapter(mutableCandleInput), 'INVALID_INPUT');
});

test('requires frozen normalized root and timeframe containers', () => {
  const valid = normalizedInput();

  assertError(() => createReplayMtfCandleAdapter({ ...valid }), 'INVALID_INPUT');
  assertError(() => createReplayMtfCandleAdapter(
    Object.freeze({ ...valid, timeframes: { ...valid.timeframes } }),
  ), 'INVALID_INPUT');
  assert.doesNotThrow(() => createReplayMtfCandleAdapter(valid));
});

test('rejects a Symbol timeframe key with the adapter error type', () => {
  const valid = normalizedInput();
  const symbolTimeframe = Symbol('unsupported');
  const timeframes = { ...valid.timeframes, [symbolTimeframe]: valid.timeframes['1m'] };
  const input = frozenInputCopy(valid, timeframes);

  assert.throws(
    () => createReplayMtfCandleAdapter(input),
    error => error instanceof ReplayMtfCandleAdapterError && error.code === 'INVALID_INPUT',
  );
});

test('exposes only 1m, 5m, and 15m with fresh timeframe arrays', () => {
  const replay = adapter();
  const first = replay.getAllTimeframes();
  const second = replay.getAllTimeframes();

  assert.deepEqual(first, SUPPORTED_TIMEFRAMES);
  assert.deepEqual(second, SUPPORTED_TIMEFRAMES);
  assert.notStrictEqual(first, second);
  for (const timeframe of [
    ' 1m ',
    '5M',
    '15M ',
    '',
    null,
    undefined,
    '1h',
    '30m',
    '4h',
    '12h',
    '24h',
  ]) {
    assertError(() => replay.getCandles(timeframe), 'UNSUPPORTED_TIMEFRAME');
    assertError(() => replay.getActive(timeframe), 'UNSUPPORTED_TIMEFRAME');
  }
});

test('does not inspect primary 1h candle semantics', () => {
  const valid = normalizedInput();
  const primaryStructuralOnly = Object.freeze({
    ...valid,
    timeframes: Object.freeze({
      ...valid.timeframes,
      '1h': Object.freeze([Object.freeze({})]),
    }),
  });

  assert.doesNotThrow(() => createReplayMtfCandleAdapter(primaryStructuralOnly));
});

test('starts with empty finalized reads and null active state', () => {
  const replay = adapter();

  for (const timeframe of SUPPORTED_TIMEFRAMES) {
    assert.deepEqual(replay.getCandles(timeframe), []);
    assert.equal(replay.getActive(timeframe), null);
  }
});

test('first hourly boundary finalizes exact secondary prefixes and activates next projections', () => {
  const input = normalizedInput();
  const replay = createReplayMtfCandleAdapter(input);
  const boundaryTime = BASE_TIME + HOUR;

  commitAt(replay, boundaryTime);

  assert.equal(replay.getCandles('1m').length, 60);
  assert.equal(replay.getCandles('5m').length, 12);
  assert.equal(replay.getCandles('15m').length, 4);
  assert.equal(replay.getCandles('1m').at(-1).closeTime, boundaryTime);
  assert.equal(replay.getCandles('5m').at(-1).closeTime, boundaryTime);
  assert.equal(replay.getCandles('15m').at(-1).closeTime, boundaryTime);
  for (const timeframe of SUPPORTED_TIMEFRAMES) {
    assert.equal(replay.getActive(timeframe).openTime, boundaryTime);
  }
});

test('getCandles returns fresh arrays and preserves finalized source identity', () => {
  const input = normalizedInput();
  const replay = createReplayMtfCandleAdapter(input);
  commitAt(replay, BASE_TIME + HOUR);

  const first = replay.getCandles('5m');
  const second = replay.getCandles('5m');
  assert.notStrictEqual(first, second);
  assert.strictEqual(first[0], input.timeframes['5m'][0]);
  first.pop();
  assert.equal(replay.getCandles('5m').length, 12);
  assert.equal(Object.isFrozen(first[0]), true);
});

test('active projections exactly match ReplayCandleEngine causal shape and hide future OHLCV', () => {
  const input = normalizedInput();
  const replay = createReplayMtfCandleAdapter(input);
  commitAt(replay, BASE_TIME + HOUR);

  for (const timeframe of SUPPORTED_TIMEFRAMES) {
    const source = input.timeframes[timeframe][replay.getCandles(timeframe).length];
    const active = replay.getActive(timeframe);
    assert.deepEqual(active, {
      open: source.open,
      high: source.open,
      low: source.open,
      close: source.open,
      volume: 0,
      openTime: source.openTime,
      timestamp: new Date(source.openTime).toISOString(),
    });
    assert.equal(Object.isFrozen(active), true);
    assert.notStrictEqual(active, source);
    assert.equal(Object.hasOwn(active, 'closeTime'), false);
  }
});

test('prepare is mutation-free and repeated plans share the same revision state', () => {
  const replay = adapter();
  const before = {
    candles: replay.getCandles('1m'),
    active: replay.getActive('1m'),
  };
  const first = replay.prepareBoundary({ boundaryTime: BASE_TIME + HOUR });
  const second = replay.prepareBoundary({ boundaryTime: BASE_TIME + HOUR });

  assert.notStrictEqual(first, second);
  assert.deepEqual(first, { boundaryTime: BASE_TIME + HOUR });
  assert.ok(Object.isFrozen(first));
  assert.deepEqual(replay.getCandles('1m'), before.candles);
  assert.equal(replay.getActive('1m'), before.active);
});

test('one commit advances every stream across many source candles atomically', () => {
  const replay = adapter();
  const boundaryTime = BASE_TIME + 10 * HOUR;
  const transition = commitAt(replay, boundaryTime);

  assert.deepEqual(transition, { boundaryTime });
  assert.ok(Object.isFrozen(transition));
  assert.equal(replay.getCandles('1m').length, 600);
  assert.equal(replay.getCandles('5m').length, 120);
  assert.equal(replay.getCandles('15m').length, 40);
  for (const timeframe of SUPPORTED_TIMEFRAMES) {
    assert.equal(replay.getCandles(timeframe).at(-1).closeTime, boundaryTime);
    assert.equal(replay.getActive(timeframe).openTime, boundaryTime);
  }
});

test('all finalized candles are causal and active state begins exactly at T', () => {
  const replay = adapter();
  const boundaryTime = BASE_TIME + 10 * HOUR;
  commitAt(replay, boundaryTime);

  for (const timeframe of SUPPORTED_TIMEFRAMES) {
    for (const candle of replay.getCandles(timeframe)) {
      assert.ok(candle.closeTime <= boundaryTime);
    }
    assert.equal(replay.getActive(timeframe).openTime, boundaryTime);
    assert.ok(replay.getActive(timeframe).openTime + REPLAY_MTF_DURATIONS_MS[timeframe] > boundaryTime);
  }
});

test('valid limits match ReplayCandleEngine semantics and cannot expose active data', () => {
  const replay = adapter();
  commitAt(replay, BASE_TIME + HOUR);

  assert.equal(replay.getCandles('1m', 1).length, 1);
  assert.equal(replay.getCandles('1m', 500).length, 60);
  assert.equal(replay.getCandles('1m', 1).at(-1).closeTime, BASE_TIME + HOUR);
  for (const limit of [0, -1, 1.5, NaN, Infinity, '2', null]) {
    assertError(() => replay.getCandles('1m', limit), 'INVALID_LIMIT');
  }
});

test('invalid boundaries fail without changing adapter state', () => {
  const replay = adapter();
  const before = replay.getCandles('1m');

  for (const boundaryTime of [undefined, BASE_TIME + 1, BASE_TIME + 30 * 60 * 1000, -1, NaN, Infinity, 'x']) {
    assertError(() => replay.prepareBoundary({ boundaryTime }), 'INVALID_BOUNDARY', boundaryTime);
  }
  assert.deepEqual(replay.getCandles('1m'), before);
  assert.equal(replay.getActive('1m'), null);
});

test('missing stream coverage fails closed without fabrication', () => {
  const input = normalizedInput();
  const replay = createReplayMtfCandleAdapter(input);
  const boundaryTime = input.timeframes['1m'].at(-1).closeTime + HOUR;

  assertError(() => replay.prepareBoundary({ boundaryTime }), 'MISSING_BOUNDARY', boundaryTime);
  for (const timeframe of SUPPORTED_TIMEFRAMES) {
    assert.deepEqual(replay.getCandles(timeframe), []);
    assert.equal(replay.getActive(timeframe), null);
  }
});

test('foreign and malformed plans are rejected without state changes', () => {
  const first = adapter();
  const second = adapter();
  const foreign = first.prepareBoundary({ boundaryTime: BASE_TIME + HOUR });

  assertError(() => second.commitBoundary(foreign), 'INVALID_PLAN', BASE_TIME + HOUR);
  assertError(() => first.commitBoundary({ boundaryTime: BASE_TIME + HOUR }), 'INVALID_PLAN', BASE_TIME + HOUR);
  assert.deepEqual(second.getCandles('1m'), []);
  assert.equal(second.getActive('1m'), null);
});

test('consumed plans, stale plans, and duplicate boundaries fail closed', () => {
  const replay = adapter();
  const first = replay.prepareBoundary({ boundaryTime: BASE_TIME + HOUR });
  const replacement = replay.prepareBoundary({ boundaryTime: BASE_TIME + HOUR });

  replay.commitBoundary(first);
  assertError(() => replay.commitBoundary(first), 'STALE_PLAN', BASE_TIME + HOUR);
  assertError(() => replay.commitBoundary(replacement), 'STALE_PLAN', BASE_TIME + HOUR);
  assertError(() => replay.prepareBoundary({ boundaryTime: BASE_TIME + HOUR }), 'INVALID_BOUNDARY', BASE_TIME + HOUR);
  assertError(() => replay.prepareBoundary({ boundaryTime: BASE_TIME }), 'INVALID_BOUNDARY', BASE_TIME);
});

test('revision advances once per successful commit and later boundaries remain forward-only', () => {
  const replay = adapter();
  const first = replay.prepareBoundary({ boundaryTime: BASE_TIME + HOUR });
  const second = replay.prepareBoundary({ boundaryTime: BASE_TIME + HOUR });
  replay.commitBoundary(first);
  assertError(() => replay.commitBoundary(second), 'STALE_PLAN', BASE_TIME + HOUR);

  const transition = commitAt(replay, BASE_TIME + 2 * HOUR);
  assert.deepEqual(transition, { boundaryTime: BASE_TIME + 2 * HOUR });
  assert.equal(replay.getCandles('1m').length, 120);
});

test('terminal boundary finalizes the horizon and does not fabricate an active candle', () => {
  const input = normalizedInput();
  const replay = createReplayMtfCandleAdapter(input);
  const terminal = input.timeframes['1m'].at(-1).closeTime;
  commitAt(replay, terminal);

  for (const timeframe of SUPPORTED_TIMEFRAMES) {
    const candles = replay.getCandles(timeframe);
    assert.equal(candles.at(-1).closeTime, terminal);
    assert.equal(replay.getActive(timeframe), null);
    assert.ok(candles.every(candle => candle.closeTime <= terminal));
  }
});

test('real schema-v2 input remains frozen and unchanged after adapter use', () => {
  const input = normalizedInput();
  const snapshot = structuredClone(input);
  const replay = createReplayMtfCandleAdapter(input);

  commitAt(replay, BASE_TIME + HOUR);
  commitAt(replay, BASE_TIME + 2 * HOUR);

  assert.deepEqual(input, snapshot);
  assert.equal(Object.isFrozen(input), true);
  assert.equal(Object.isFrozen(input.timeframes), true);
  for (const timeframe of INPUT_TIMEFRAMES) {
    assert.equal(Object.isFrozen(input.timeframes[timeframe]), true);
    assert.equal(Object.isFrozen(input.timeframes[timeframe][0]), true);
  }
});
