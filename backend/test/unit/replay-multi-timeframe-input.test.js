const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeReplayMultiTimeframeInput,
  REPLAY_MTF_SCHEMA_VERSION,
  REPLAY_MTF_TIMEFRAMES,
  REPLAY_MTF_DURATIONS_MS,
} = require('../../src/engine/replayMultiTimeframeInput');
const { normalizeReplayInput } = require('../../src/engine/replayInput');
const { CandleEngine } = require('../../src/engine/candles');

const BASE_TIME = Date.parse('2024-01-01T00:00:00.000Z');
const SECONDARY_TIMEFRAMES = REPLAY_MTF_TIMEFRAMES.slice(0, -1);

function makeCandle(openTime, index, { equalValues = false } = {}) {
  const value = equalValues ? 100 : 100 + index;
  return {
    openTime,
    timestamp: new Date(openTime).toISOString(),
    open: value,
    high: value + 1,
    low: value - 1,
    close: value,
    volume: 1,
  };
}

function makeStream(timeframe, start, count, options = {}) {
  const durationMs = REPLAY_MTF_DURATIONS_MS[timeframe];
  return Array.from({ length: count }, (_, index) =>
    makeCandle(start + index * durationMs, index, options));
}

function makeRawInput(options = {}) {
  const primaryCount = options.primaryCount ?? 51;
  const primaryStart = options.primaryStart ?? BASE_TIME;
  const primaryEnd = primaryStart + primaryCount * REPLAY_MTF_DURATIONS_MS['1h'];
  const starts = options.secondaryStarts || {};
  const counts = options.secondaryCounts || {};
  const tails = options.secondaryTails || {};
  const equalValues = options.equalValues === true;
  const timeframes = {
    '1m': null,
    '5m': null,
    '15m': null,
    '1h': makeStream('1h', primaryStart, primaryCount, { equalValues }),
  };

  for (const timeframe of SECONDARY_TIMEFRAMES) {
    const start = starts[timeframe] ?? primaryStart;
    const durationMs = REPLAY_MTF_DURATIONS_MS[timeframe];
    const requiredCount = Math.ceil((primaryEnd - start) / durationMs);
    const count = counts[timeframe] ?? requiredCount + (tails[timeframe] || 0);
    timeframes[timeframe] = makeStream(timeframe, start, count, { equalValues });
  }

  return {
    schemaVersion: REPLAY_MTF_SCHEMA_VERSION,
    primaryTimeframe: '1h',
    sourcePolicy: 'independent',
    timeframes,
  };
}

function assertRejects(input, pattern) {
  assert.throws(
    () => normalizeReplayMultiTimeframeInput(input),
    error => error instanceof TypeError && pattern.test(error.message),
  );
}

function isDeeplyFrozen(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return true;
  seen.add(value);
  return Object.isFrozen(value) && Object.values(value).every(nested => isDeeplyFrozen(nested, seen));
}

test('valid four-timeframe input normalizes successfully', () => {
  const normalized = normalizeReplayMultiTimeframeInput(makeRawInput());

  assert.equal(normalized.schemaVersion, 2);
  assert.equal(normalized.primaryTimeframe, '1h');
  assert.equal(normalized.sourcePolicy, 'independent');
  assert.deepEqual(Object.keys(normalized.timeframes), REPLAY_MTF_TIMEFRAMES);
});

test('normalized root shape and timeframe key order are exact', () => {
  const normalized = normalizeReplayMultiTimeframeInput(makeRawInput());

  assert.deepEqual(Object.keys(normalized), [
    'schemaVersion',
    'primaryTimeframe',
    'sourcePolicy',
    'timeframes',
  ]);
  assert.deepEqual(Object.keys(normalized.timeframes), ['1m', '5m', '15m', '1h']);
});

test('root, timeframe map, streams, and candles are deeply frozen', () => {
  const normalized = normalizeReplayMultiTimeframeInput(makeRawInput());

  assert.equal(isDeeplyFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.timeframes), true);
  for (const timeframe of REPLAY_MTF_TIMEFRAMES) {
    assert.equal(Object.isFrozen(normalized.timeframes[timeframe]), true);
    assert.equal(Object.isFrozen(normalized.timeframes[timeframe][0]), true);
  }
});

test('ordinary mutable JSON-compatible input is accepted', () => {
  const input = makeRawInput();

  assert.equal(Object.isFrozen(input), false);
  assert.equal(Object.isFrozen(input.timeframes['1m']), false);
  assert.equal(Object.isFrozen(input.timeframes['1m'][0]), false);
  assert.doesNotThrow(() => normalizeReplayMultiTimeframeInput(input));
});

test('raw input is not mutated', () => {
  const input = makeRawInput();
  const before = structuredClone(input);

  normalizeReplayMultiTimeframeInput(input);

  assert.deepEqual(input, before);
});

test('normalized output shares no arrays or objects with raw input', () => {
  const input = makeRawInput();
  const normalized = normalizeReplayMultiTimeframeInput(input);

  for (const timeframe of REPLAY_MTF_TIMEFRAMES) {
    assert.notStrictEqual(normalized.timeframes[timeframe], input.timeframes[timeframe]);
    assert.notStrictEqual(normalized.timeframes[timeframe][0], input.timeframes[timeframe][0]);
  }
  assert.notStrictEqual(normalized.timeframes['1m'][0], normalized.timeframes['5m'][0]);
});

test('repeated normalization is deterministic', () => {
  const first = normalizeReplayMultiTimeframeInput(makeRawInput());
  const second = normalizeReplayMultiTimeframeInput(makeRawInput());

  assert.deepEqual(first, second);
});

test('wrong schemaVersion rejects', () => {
  const input = makeRawInput();
  input.schemaVersion = 1;

  assertRejects(input, /input\.schemaVersion must be 2/);
});

test('wrong primaryTimeframe rejects', () => {
  const input = makeRawInput();
  input.primaryTimeframe = '4h';

  assertRejects(input, /input\.primaryTimeframe must be exactly 1h/);
});

test('missing or invalid sourcePolicy rejects', () => {
  const missing = makeRawInput();
  delete missing.sourcePolicy;
  assertRejects(missing, /input\.sourcePolicy is required/);

  for (const sourcePolicy of ['aggregated', '', null, 1]) {
    const input = makeRawInput();
    input.sourcePolicy = sourcePolicy;
    assertRejects(input, /input\.sourcePolicy must be exactly independent/);
  }
});

test('unknown root property rejects', () => {
  const input = makeRawInput();
  input.extra = true;

  assertRejects(input, /input\.extra is not supported/);
});

test('missing timeframe rejects', () => {
  const input = makeRawInput();
  delete input.timeframes['15m'];

  assertRejects(input, /timeframes\.15m is required/);
});

test('unknown timeframe rejects', () => {
  const input = makeRawInput();
  input.timeframes['30m'] = makeStream('15m', BASE_TIME, 15);

  assertRejects(input, /timeframes\.30m is not supported/);
});

test('non-array stream rejects', () => {
  const input = makeRawInput();
  input.timeframes['5m'] = {};

  assertRejects(input, /timeframes\.5m must be an array/);
});

test('sparse streams reject with the controlled dense-array error', () => {
  for (const timeframe of REPLAY_MTF_TIMEFRAMES) {
    const input = makeRawInput();
    const stream = input.timeframes[timeframe];
    const holeIndexes = [0, Math.floor(stream.length / 2), stream.length - 1];

    for (const holeIndex of holeIndexes) {
      delete stream[holeIndex];
      assert.throws(
        () => normalizeReplayMultiTimeframeInput(input),
        error => error instanceof TypeError
          && error.name === 'ReplayMultiTimeframeInputError'
          && error.code === 'INVALID_STREAM'
          && error.message === `timeframes.${timeframe} must be dense`,
      );
      stream[holeIndex] = makeCandle(
        BASE_TIME + holeIndex * REPLAY_MTF_DURATIONS_MS[timeframe],
        holeIndex,
      );
    }
  }
});

test('dense streams retain existing normalization semantics', () => {
  const input = makeRawInput({ equalValues: true });
  const before = structuredClone(input);
  const first = normalizeReplayMultiTimeframeInput(input);
  const second = normalizeReplayMultiTimeframeInput(input);

  assert.deepEqual(first, second);
  assert.deepEqual(input, before);
  assert.equal(first.timeframes['1m'][0].closeTime,
    BASE_TIME + REPLAY_MTF_DURATIONS_MS['1m']);
  assert.equal(first.timeframes['1h'].length, 51);
});

test('shared array reference between streams rejects', () => {
  const input = makeRawInput();
  input.timeframes['5m'] = input.timeframes['1m'];

  assertRejects(input, /timeframes\.5m reuses an array/);
});

test('shared candle object across streams rejects', () => {
  const input = makeRawInput();
  input.timeframes['5m'][0] = input.timeframes['1m'][0];

  assertRejects(input, /timeframes\.5m\[0\] reuses a candle object/);
});

test('unknown candle property rejects', () => {
  const input = makeRawInput();
  input.timeframes['1h'][0].closeTime = input.timeframes['1h'][0].openTime + 3600000;

  assertRejects(input, /timeframes\.1h\[0\]\.closeTime is not supported/);
});

test('missing timestamp fields reject', () => {
  const input = makeRawInput();
  delete input.timeframes['1h'][0].openTime;
  delete input.timeframes['1h'][0].timestamp;

  assertRejects(input, /timeframes\.1h\[0\] requires openTime or timestamp/);
});

test('invalid openTime rejects', () => {
  const input = makeRawInput();
  input.timeframes['1h'][0].openTime = 1.5;

  assertRejects(input, /timeframes\.1h\[0\]\.openTime must be a valid integer millisecond timestamp/);
});

test('timestamp without explicit timezone rejects', () => {
  const input = makeRawInput();
  delete input.timeframes['1h'][0].openTime;
  input.timeframes['1h'][0].timestamp = '2024-01-01T00:00:00.000';

  assertRejects(input, /timeframes\.1h\[0\]\.timestamp must be an ISO date-time with an explicit timezone/);
});

test('openTime and timestamp mismatch rejects', () => {
  const input = makeRawInput();
  input.timeframes['1h'][0].timestamp = new Date(BASE_TIME + 1).toISOString();

  assertRejects(input, /timeframes\.1h\[0\]\.timestamp must match openTime/);
});

test('canonical ISO timestamp is produced', () => {
  const input = makeRawInput();
  delete input.timeframes['1h'][0].openTime;
  input.timeframes['1h'][0].timestamp = '2024-01-01T01:00:00.000+01:00';

  const normalized = normalizeReplayMultiTimeframeInput(input);

  assert.equal(normalized.timeframes['1h'][0].openTime, BASE_TIME);
  assert.equal(normalized.timeframes['1h'][0].timestamp, '2024-01-01T00:00:00.000Z');
});

test('Unix epoch input is accepted and normalized across all timeframes', () => {
  const normalized = normalizeReplayMultiTimeframeInput(makeRawInput({ primaryStart: 0 }));

  assert.equal(normalized.timeframes['1h'][0].openTime, 0);
  assert.equal(normalized.timeframes['1h'][0].timestamp, '1970-01-01T00:00:00.000Z');
  assert.equal(normalized.timeframes['1h'][0].closeTime, REPLAY_MTF_DURATIONS_MS['1h']);
  assert.equal(normalized.timeframes['1m'][0].openTime, 0);
  assert.equal(normalized.timeframes['1m'][0].timestamp, '1970-01-01T00:00:00.000Z');
});

test('aligned 1971 input satisfies normal spacing and coverage', () => {
  const normalized = normalizeReplayMultiTimeframeInput(makeRawInput({
    primaryStart: Date.parse('1971-01-01T00:00:00.000Z'),
  }));

  assert.equal(normalized.timeframes['1h'][0].timestamp, '1971-01-01T00:00:00.000Z');
  assert.equal(normalized.timeframes['1h'][0].closeTime,
    Date.parse('1971-01-01T01:00:00.000Z'));
  assert.ok(normalized.timeframes['5m'][0].openTime <= normalized.timeframes['1h'][0].openTime);
  assert.ok(normalized.timeframes['5m'].at(-1).closeTime >= normalized.timeframes['1h'].at(-1).closeTime);
});

test('numeric openTime is treated as milliseconds without unit inference', () => {
  const input = makeRawInput();
  const candle = input.timeframes['1h'][0];
  candle.openTime = Math.floor(BASE_TIME / 1000);
  candle.timestamp = new Date(BASE_TIME).toISOString();

  assertRejects(input, /timeframes\.1h\[0\]\.timestamp must match openTime/);
});

test('closeTime is derived correctly for every timeframe', () => {
  const normalized = normalizeReplayMultiTimeframeInput(makeRawInput());

  for (const timeframe of REPLAY_MTF_TIMEFRAMES) {
    const candle = normalized.timeframes[timeframe][0];
    assert.equal(candle.closeTime, candle.openTime + REPLAY_MTF_DURATIONS_MS[timeframe]);
  }
});

test('caller-supplied closeTime rejects as unknown', () => {
  const input = makeRawInput();
  input.timeframes['15m'][2].closeTime = input.timeframes['15m'][2].openTime + 900000;

  assertRejects(input, /timeframes\.15m\[2\]\.closeTime is not supported/);
});

test('non-finite OHLCV rejects', () => {
  for (const field of ['open', 'high', 'low', 'close', 'volume']) {
    const input = makeRawInput();
    input.timeframes['1h'][0][field] = Number.NaN;
    assertRejects(input, new RegExp(`timeframes\\.1h\\[0\\]\\.${field} must be finite`));
  }
});

test('non-positive prices reject', () => {
  for (const field of ['open', 'high', 'low', 'close']) {
    const input = makeRawInput();
    input.timeframes['1h'][0][field] = 0;
    assertRejects(input, new RegExp(`timeframes\\.1h\\[0\\]\\.${field} must be greater than zero`));
  }
});

test('negative volume rejects', () => {
  const input = makeRawInput();
  input.timeframes['5m'][0].volume = -1;

  assertRejects(input, /timeframes\.5m\[0\]\.volume must be greater than or equal to zero/);
});

test('inconsistent high rejects', () => {
  const input = makeRawInput();
  input.timeframes['15m'][0].high = input.timeframes['15m'][0].open - 1;

  assertRejects(input, /timeframes\.15m\[0\]\.high must be greater than or equal/);
});

test('inconsistent low rejects', () => {
  const input = makeRawInput();
  input.timeframes['15m'][0].low = input.timeframes['15m'][0].close + 1;

  assertRejects(input, /timeframes\.15m\[0\]\.low must be less than or equal/);
});

test('misaligned openTime rejects for every timeframe', () => {
  for (const timeframe of REPLAY_MTF_TIMEFRAMES) {
    const input = makeRawInput();
    const candle = input.timeframes[timeframe][0];
    candle.openTime += 1;
    candle.timestamp = new Date(candle.openTime).toISOString();
    assertRejects(input, new RegExp(`timeframes\\.${timeframe}\\[0\\]\\.openTime is not aligned to ${timeframe}`));
  }
});

test('unsorted stream rejects', () => {
  const input = makeRawInput();
  const stream = input.timeframes['5m'];
  stream[1].openTime = stream[0].openTime - REPLAY_MTF_DURATIONS_MS['5m'];
  stream[1].timestamp = new Date(stream[1].openTime).toISOString();

  assertRejects(input, /timeframes\.5m\[1\]\.openTime must be ordered ascending/);
});

test('duplicate timestamp rejects', () => {
  const input = makeRawInput();
  const stream = input.timeframes['15m'];
  stream[1].openTime = stream[0].openTime;
  stream[1].timestamp = stream[0].timestamp;

  assertRejects(input, /timeframes\.15m\[1\]\.openTime duplicates the previous openTime/);
});

test('gap and misaligned spacing reject', () => {
  const gap = makeRawInput();
  const gapStream = gap.timeframes['1m'];
  gapStream[21].openTime += REPLAY_MTF_DURATIONS_MS['1m'];
  gapStream[21].timestamp = new Date(gapStream[21].openTime).toISOString();
  assertRejects(gap, /timeframes\.1m contains a gap between indexes 20 and 21/);

  const misaligned = makeRawInput();
  const misalignedStream = misaligned.timeframes['1m'];
  misalignedStream[21].openTime -= 1;
  misalignedStream[21].timestamp = new Date(misalignedStream[21].openTime).toISOString();
  assertRejects(misaligned, /timeframes\.1m\[21\]\.openTime is not aligned to 1m/);
});

test('primary stream below 51 candles rejects', () => {
  assertRejects(makeRawInput({ primaryCount: 50 }), /timeframes\.1h must contain at least 51 candles/);
});

test('secondary stream below 15 candles rejects', () => {
  const input = makeRawInput({ secondaryCounts: { '5m': 14 } });

  assertRejects(input, /timeframes\.5m must contain at least 15 candles/);
});

test('secondary start coverage failure rejects', () => {
  const input = makeRawInput({
    secondaryStarts: { '5m': BASE_TIME + REPLAY_MTF_DURATIONS_MS['5m'] },
  });

  assertRejects(input, /timeframes\.5m does not cover the primary replay horizon/);
});

test('secondary end coverage failure rejects', () => {
  const input = makeRawInput();
  input.timeframes['15m'].pop();

  assertRejects(input, /timeframes\.15m does not cover the primary replay horizon/);
});

test('warmup before primary start is accepted', () => {
  const durationMs = REPLAY_MTF_DURATIONS_MS['5m'];
  const normalized = normalizeReplayMultiTimeframeInput(makeRawInput({
    secondaryStarts: { '5m': BASE_TIME - durationMs * 3 },
  }));

  assert.ok(normalized.timeframes['5m'][0].openTime < normalized.timeframes['1h'][0].openTime);
});

test('tail after primary end is accepted', () => {
  const normalized = normalizeReplayMultiTimeframeInput(makeRawInput({
    secondaryTails: { '15m': 2 },
  }));
  const primaryEnd = normalized.timeframes['1h'].at(-1).closeTime;

  assert.ok(normalized.timeframes['15m'].at(-1).closeTime > primaryEnd);
});

test('equal numeric candle values across distinct objects are accepted', () => {
  const normalized = normalizeReplayMultiTimeframeInput(makeRawInput({ equalValues: true }));

  assert.equal(normalized.timeframes['1m'][0].open, normalized.timeframes['5m'][0].open);
  assert.notStrictEqual(normalized.timeframes['1m'][0], normalized.timeframes['5m'][0]);
});

test('normalization does not aggregate or fabricate candles', () => {
  const input = makeRawInput();
  const normalized = normalizeReplayMultiTimeframeInput(input);

  assert.equal(normalized.timeframes['1m'].length, input.timeframes['1m'].length);
  assert.equal(normalized.timeframes['5m'].length, input.timeframes['5m'].length);
  assert.notEqual(normalized.timeframes['1m'].length, normalized.timeframes['5m'].length);
  assert.equal(normalized.timeframes['5m'][0].openTime, input.timeframes['5m'][0].openTime);
});

test('schemaVersion 1 input is not silently upgraded', () => {
  const input = makeRawInput();
  input.schemaVersion = 1;

  assertRejects(input, /input\.schemaVersion must be 2/);
});

test('Unit 1B normalizer behavior remains unchanged', () => {
  const input = makeRawInput();
  const normalized = normalizeReplayInput(input.timeframes['1h'], '1h');

  assert.equal(normalized.schemaVersion, 1);
  assert.equal(normalized.timeframe, '1h');
  assert.equal(normalized.candles.length, 51);
});

test('live CandleEngine remains untouched', () => {
  const live = new CandleEngine({ get: () => undefined }, {});
  const before = live.getAllTimeframes();

  normalizeReplayMultiTimeframeInput(makeRawInput());

  assert.deepEqual(live.getAllTimeframes(), before);
  assert.deepEqual(live.getCandles('1h'), []);
  assert.equal(live.getActive('1h'), null);
});

test('module exports only the approved API', () => {
  const moduleExports = require('../../src/engine/replayMultiTimeframeInput');

  assert.deepEqual(Object.keys(moduleExports).sort(), [
    'REPLAY_MTF_DURATIONS_MS',
    'REPLAY_MTF_SCHEMA_VERSION',
    'REPLAY_MTF_TIMEFRAMES',
    'normalizeReplayMultiTimeframeInput',
  ]);
});
