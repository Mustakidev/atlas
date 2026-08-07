const test = require('node:test');
const assert = require('node:assert/strict');

const { CandleEngine } = require('../../src/engine/candles');
const { MIN_REPLAY_CANDLES, normalizeReplayInput } = require('../../src/engine/replayInput');
const { ReplayCandleEngine, ReplayCandleError } = require('../../src/engine/replayCandleEngine');

const BASE_TIME = Date.parse('2024-01-01T00:00:00.000Z');
const HOUR = 3600000;

function normalizedInput(count = MIN_REPLAY_CANDLES, timeframe = '1h') {
  const source = Array.from({ length: Math.max(count, MIN_REPLAY_CANDLES) }, (_, index) => {
    const openTime = BASE_TIME + index * HOUR;
    return {
      open: 100 + index,
      high: 102 + index,
      low: 98 + index,
      close: 101 + index,
      volume: 1000 + index,
      openTime,
      timestamp: new Date(openTime).toISOString(),
    };
  });
  const normalized = normalizeReplayInput(source, timeframe);
  const candles = count === MIN_REPLAY_CANDLES
    ? normalized.candles
    : Object.freeze(normalized.candles.slice(0, count));
  return { timeframe: normalized.timeframe, candles };
}

function adapter(count = MIN_REPLAY_CANDLES, timeframe = '1h') {
  return new ReplayCandleEngine(normalizedInput(count, timeframe));
}

function boundaryInput(openTimes, timeframe = '1h') {
  return {
    timeframe,
    candles: Object.freeze(openTimes.map((openTime, index) => Object.freeze({
      open: 100 + index,
      high: 102 + index,
      low: 98 + index,
      close: 101 + index,
      volume: 1000 + index,
      openTime,
      timestamp: new Date(openTime).toISOString(),
    }))),
  };
}

function assertReplayError(callback, code) {
  assert.throws(callback, error => {
    assert.ok(error instanceof ReplayCandleError);
    assert.equal(error.code, code);
    return true;
  });
}

function publicState(replay, timeframe = '1h') {
  return {
    active: replay.getActive(timeframe),
    finalized: replay.getCandles(timeframe),
    hasNext: replay.hasNext(),
  };
}

function assertPublicStateUnchanged(replay, before, timeframe = '1h') {
  const after = publicState(replay, timeframe);
  assert.strictEqual(after.active, before.active);
  assert.equal(after.hasNext, before.hasNext);
  assert.equal(after.finalized.length, before.finalized.length);
  for (let index = 0; index < before.finalized.length; index++) {
    assert.strictEqual(after.finalized[index], before.finalized[index]);
  }
}

test('starts with no active or finalized candles', () => {
  const replay = adapter();

  assert.equal(replay.getActive('1h'), null);
  assert.deepEqual(replay.getCandles('1h'), []);
  assert.equal(replay.hasNext(), true);
  assert.deepEqual(replay.getAllTimeframes(), ['1h']);
});

test('prepares and commits a causal boundary without leaking future OHLCV', () => {
  const input = normalizedInput(3);
  const replay = new ReplayCandleEngine(input);
  const sourceArray = input.candles;
  const sourceSnapshots = input.candles.map(candle => ({ ...candle }));
  const beforePrepare = publicState(replay);
  const plan = replay.prepareBoundary({ boundaryTime: BASE_TIME + HOUR });
  const repeatedPlan = replay.prepareBoundary({ boundaryTime: BASE_TIME + HOUR });

  assert.ok(Object.isFrozen(plan));
  assert.strictEqual(plan.lifecycleCandle, input.candles[0]);
  assert.equal(plan.boundaryTime, BASE_TIME + HOUR);
  assert.equal(plan.revision, 0);
  assert.equal(repeatedPlan.revision, 0);
  assertPublicStateUnchanged(replay, beforePrepare);

  const projection = plan.active;
  assert.ok(Object.isFrozen(projection));
  assert.notStrictEqual(projection, input.candles[1]);
  assert.equal(projection.open, input.candles[1].open);
  assert.equal(projection.high, input.candles[1].open);
  assert.equal(projection.low, input.candles[1].open);
  assert.equal(projection.close, input.candles[1].open);
  assert.equal(projection.volume, 0);
  assert.equal(projection.openTime, input.candles[1].openTime);
  assert.equal(projection.timestamp, new Date(input.candles[1].openTime).toISOString());

  const transition = replay.commitBoundary(plan);
  assert.deepEqual(Object.keys(transition).sort(), [
    'active',
    'boundaryTime',
    'finalized',
    'lifecycleCandle',
    'revision',
    'sourceIndex',
  ]);
  assert.ok(Object.isFrozen(transition));
  assert.ok(Object.isFrozen(transition.finalized));
  assert.equal(transition.revision, 1);
  assert.strictEqual(transition.lifecycleCandle, input.candles[0]);
  assert.strictEqual(transition.finalized['1h'], input.candles[0]);
  assert.strictEqual(replay.getActive('1h'), projection);
  assert.deepEqual(replay.getCandles('1h'), [input.candles[0]]);
  assert.strictEqual(input.candles, sourceArray);
  assert.ok(Object.isFrozen(input.candles));
  input.candles.forEach((candle, index) => {
    assert.ok(Object.isFrozen(candle));
    assert.strictEqual(candle, sourceArray[index]);
    assert.deepEqual(candle, sourceSnapshots[index]);
  });
});

test('replaces a projection with the exact source candle at its close', () => {
  const input = normalizedInput(3);
  const replay = new ReplayCandleEngine(input);

  const first = replay.commitBoundary(
    replay.prepareBoundary({ boundaryTime: BASE_TIME + HOUR }),
  );
  const projection = first.active;
  assert.equal(first.revision, 1);
  assert.notStrictEqual(projection, input.candles[1]);

  const transition1 = replay.commitBoundary(
    replay.prepareBoundary({ boundaryTime: BASE_TIME + 2 * HOUR }),
  );
  assert.equal(transition1.revision, 2);
  assert.strictEqual(transition1.lifecycleCandle, input.candles[1]);
  assert.strictEqual(transition1.finalized['1h'], input.candles[1]);
  assert.strictEqual(replay.getCandles('1h').at(-1), input.candles[1]);
  assert.notStrictEqual(replay.getCandles('1h').at(-1), projection);

  const finalPlan = replay.prepareBoundary({ boundaryTime: BASE_TIME + 3 * HOUR });
  const transition = replay.commitBoundary(finalPlan);

  assert.equal(transition.revision, 3);
  assert.strictEqual(transition.lifecycleCandle, input.candles[2]);
  assert.strictEqual(transition.finalized['1h'], input.candles[2]);
  assert.equal(transition.active, null);
  assert.equal(replay.getActive('1h'), null);
  assert.strictEqual(replay.getCandles('1h')[2], input.candles[2]);
  assert.equal(replay.hasNext(), false);
  assert.deepEqual(replay.getCandles('1h'), [...input.candles]);

  const afterTerminal = publicState(replay);
  assertReplayError(() => replay.commitBoundary(finalPlan), 'INVALID_PLAN');
  assertPublicStateUnchanged(replay, afterTerminal);
});

test('accepts a source gap and leaves active null until the next exact source boundary', () => {
  const input = boundaryInput([BASE_TIME, BASE_TIME + HOUR, BASE_TIME + 3 * HOUR]);
  const replay = new ReplayCandleEngine(input);

  replay.commitBoundary(replay.prepareBoundary({ boundaryTime: BASE_TIME + HOUR }));
  const transition = replay.commitBoundary(
    replay.prepareBoundary({ boundaryTime: BASE_TIME + 2 * HOUR }),
  );

  assert.equal(transition.active, null);
  assert.equal(replay.getActive('1h'), null);
  assert.deepEqual(replay.getCandles('1h'), [input.candles[0], input.candles[1]]);
  assert.equal(replay.hasNext(), true);

  replay.commitBoundary(replay.prepareBoundary({ boundaryTime: BASE_TIME + 4 * HOUR }));
  assert.equal(replay.getActive('1h'), null);
  assert.deepEqual(replay.getCandles('1h'), [...input.candles]);
  assert.equal(replay.hasNext(), false);
});

test('rejects a source candle that begins before the requested boundary', () => {
  const replay = new ReplayCandleEngine(boundaryInput([BASE_TIME, BASE_TIME + HOUR / 2]));

  assertReplayError(
    () => replay.prepareBoundary({ boundaryTime: BASE_TIME + HOUR }),
    'INVALID_SOURCE_ORDER',
  );
  assert.equal(replay.getActive('1h'), null);
  assert.deepEqual(replay.getCandles('1h'), []);
});

test('authenticates boundary plans and rejects stale or reused plans', () => {
  const first = new ReplayCandleEngine(normalizedInput(3));
  const second = new ReplayCandleEngine(normalizedInput(3));
  const firstPlan = first.prepareBoundary({ boundaryTime: BASE_TIME + HOUR });
  const secondPlan = second.prepareBoundary({ boundaryTime: BASE_TIME + HOUR });

  const secondBeforeForeign = publicState(second);
  assertReplayError(() => second.commitBoundary(firstPlan), 'INVALID_PLAN');
  assertPublicStateUnchanged(second, secondBeforeForeign);

  const fabricated = Object.freeze({ ...firstPlan });
  const firstBeforeFabricated = publicState(first);
  assertReplayError(() => first.commitBoundary(fabricated), 'INVALID_PLAN');
  assertPublicStateUnchanged(first, firstBeforeFabricated);

  first.commitBoundary(firstPlan);
  const firstAfterCommit = publicState(first);
  assertReplayError(() => first.commitBoundary(firstPlan), 'INVALID_PLAN');
  assertPublicStateUnchanged(first, firstAfterCommit);
  const firstBeforeForeign = publicState(first);
  assertReplayError(() => first.commitBoundary(secondPlan), 'INVALID_PLAN');
  assertPublicStateUnchanged(first, firstBeforeForeign);

  const stale = first.prepareBoundary({ boundaryTime: BASE_TIME + 2 * HOUR });
  const replacement = first.prepareBoundary({ boundaryTime: BASE_TIME + 2 * HOUR });
  first.commitBoundary(stale);
  const firstBeforeStale = publicState(first);
  assertReplayError(() => first.commitBoundary(replacement), 'STALE_PLAN');
  assertPublicStateUnchanged(first, firstBeforeStale);
});

test('returns immutable transition metadata and rejects invalid boundaries', () => {
  const input = normalizedInput(2);
  const replay = new ReplayCandleEngine(input);

  for (const boundaryTime of [undefined, BASE_TIME, BASE_TIME + 1.5 * HOUR, -1, Infinity]) {
    assertReplayError(() => replay.prepareBoundary({ boundaryTime }), 'INVALID_BOUNDARY');
  }

  const transition = replay.commitBoundary(
    replay.prepareBoundary({ boundaryTime: BASE_TIME + HOUR }),
  );
  assert.ok(Object.isFrozen(transition));
  assert.ok(Object.isFrozen(transition.finalized));
  assert.strictEqual(transition.finalized['1h'], input.candles[0]);
  assert.notStrictEqual(transition.active, input.candles[1]);
  assert.equal(transition.active.open, input.candles[1].open);
  assert.equal(transition.active.volume, 0);
  assert.equal(transition.revision, 1);
  assert.deepEqual(replay.getCandles('1h'), [input.candles[0]]);
});

test('does not allow legacy and transactional protocols to be mixed', () => {
  const legacy = adapter(2);
  legacy.nextActive();
  assertReplayError(
    () => legacy.prepareBoundary({ boundaryTime: BASE_TIME + HOUR }),
    'MIXED_PROTOCOL',
  );

  const boundary = new ReplayCandleEngine(normalizedInput(2));
  const plan = boundary.prepareBoundary({ boundaryTime: BASE_TIME + HOUR });
  const beforeLegacyAttempt = publicState(boundary);
  assertReplayError(() => boundary.nextActive(), 'MIXED_PROTOCOL');
  assertReplayError(() => boundary.finalizeActive(), 'MIXED_PROTOCOL');
  assertPublicStateUnchanged(boundary, beforeLegacyAttempt);
  assert.equal(boundary.commitBoundary(plan).revision, 1);
});

test('uses the configured 5m timeframe boundary and transition key', () => {
  const FIVE_MINUTES = 5 * 60 * 1000;
  const input = boundaryInput(
    [BASE_TIME, BASE_TIME + FIVE_MINUTES],
    '5m',
  );
  const replay = new ReplayCandleEngine(input);

  assertReplayError(
    () => replay.prepareBoundary({ boundaryTime: BASE_TIME + HOUR }),
    'INVALID_BOUNDARY',
  );
  const plan = replay.prepareBoundary({ boundaryTime: BASE_TIME + FIVE_MINUTES });
  const transition = replay.commitBoundary(plan);

  assert.deepEqual(replay.getAllTimeframes(), ['5m']);
  assert.deepEqual(Object.keys(transition.finalized), ['5m']);
  assert.equal(Object.hasOwn(transition.finalized, '1h'), false);
  assert.strictEqual(transition.lifecycleCandle, input.candles[0]);
  assert.equal(transition.active.open, input.candles[1].open);
  assert.equal(transition.active.high, input.candles[1].open);
  assert.equal(transition.active.low, input.candles[1].open);
  assert.equal(transition.active.close, input.candles[1].open);
  assert.equal(transition.active.volume, 0);
  assert.equal(
    transition.active.timestamp,
    new Date(input.candles[1].openTime).toISOString(),
  );
});

test('activates exactly one source candle and excludes it from finalized reads', () => {
  const input = normalizedInput();
  const replay = new ReplayCandleEngine(input);

  const active = replay.nextActive();
  assert.strictEqual(active, input.candles[0]);
  assert.strictEqual(replay.getActive('1h'), active);
  assert.deepEqual(replay.getCandles('1h'), []);
  assert.equal(replay.hasNext(), true);
});

test('finalize promotes the active candle exactly once', () => {
  const replay = adapter();
  const active = replay.nextActive();

  assert.strictEqual(replay.finalizeActive(), active);
  assert.equal(replay.getActive('1h'), null);
  assert.deepEqual(replay.getCandles('1h'), [active]);
  assertReplayError(() => replay.finalizeActive(), 'NO_ACTIVE_CANDLE');
});

test('promotes multiple candles in chronological order', () => {
  const input = normalizedInput();
  const replay = new ReplayCandleEngine(input);
  const promoted = [];

  for (let index = 0; index < 3; index++) {
    promoted.push(replay.nextActive());
    replay.finalizeActive();
  }

  assert.deepEqual(replay.getCandles('1h'), promoted);
  assert.deepEqual(promoted.map(candle => candle.openTime), [BASE_TIME, BASE_TIME + HOUR, BASE_TIME + 2 * HOUR]);
  assert.equal(replay.getActive('1h'), null);
});

test('rejects double activation and exhaustion without skipping a candle', () => {
  const input = normalizedInput(2);
  const replay = new ReplayCandleEngine(input);
  const first = replay.nextActive();

  assertReplayError(() => replay.nextActive(), 'ACTIVE_CANDLE_PRESENT');
  replay.finalizeActive();
  assert.strictEqual(replay.nextActive(), input.candles[1]);
  assert.notStrictEqual(replay.getActive('1h'), first);
  replay.finalizeActive();
  assert.equal(replay.hasNext(), false);
  assertReplayError(() => replay.nextActive(), 'NO_REMAINING_CANDLES');
});

test('supports an independent finalized tail limit', () => {
  const replay = new ReplayCandleEngine(normalizedInput(4));
  const finalized = [];
  for (let index = 0; index < 4; index++) {
    finalized.push(replay.nextActive());
    replay.finalizeActive();
  }

  assert.deepEqual(replay.getCandles('1h', 2), finalized.slice(-2));
  assert.deepEqual(replay.getCandles('1h', 99), finalized);
  const returned = replay.getCandles('1h');
  returned.pop();
  assert.deepEqual(replay.getCandles('1h'), finalized);
  assert.notStrictEqual(returned, replay.getCandles('1h'));
});

test('rejects invalid limits and malformed timeframe arguments', () => {
  const replay = adapter();

  for (const limit of [0, -1, 1.5, NaN, Infinity, '2', null]) {
    assertReplayError(() => replay.getCandles('1h', limit), 'INVALID_LIMIT');
  }
  for (const timeframe of ['', '   ', null, 1, undefined]) {
    assertReplayError(() => replay.getCandles(timeframe), 'INVALID_TIMEFRAME');
    assertReplayError(() => replay.getActive(timeframe), 'INVALID_TIMEFRAME');
  }
});

test('uses deterministic empty and null reads for another timeframe without fabrication', () => {
  const replay = adapter();

  replay.nextActive();
  assert.deepEqual(replay.getCandles('24h'), []);
  assert.equal(replay.getActive('24h'), null);
  assert.deepEqual(replay.getAllTimeframes(), ['1h']);
});

test('keeps timeframe ownership immutable after an assignment attempt', () => {
  const replay = adapter(2);
  let assignmentError = null;

  try {
    replay.timeframe = '24h';
  } catch (error) {
    assignmentError = error;
  }

  assert.ok(assignmentError === null || assignmentError instanceof TypeError);
  assert.equal(replay.timeframe, '1h');
  assert.deepEqual(replay.getAllTimeframes(), ['1h']);

  const active = replay.nextActive();
  assert.strictEqual(replay.getActive('1h'), active);
  assert.equal(replay.getActive('24h'), null);
  assert.deepEqual(replay.getCandles('24h'), []);
  assert.deepEqual(replay.getCandles('1h'), []);

  replay.finalizeActive();
  assert.deepEqual(replay.getCandles('1h'), [active]);
  assert.deepEqual(replay.getCandles('24h'), []);
  assert.equal(replay.getActive('1h'), null);
});

test('preserves frozen source candles and does not mutate normalized input', () => {
  const input = normalizedInput();
  const before = structuredClone(input.candles);
  const replay = new ReplayCandleEngine(input);
  const active = replay.nextActive();
  replay.finalizeActive();

  assert.ok(Object.isFrozen(input.candles));
  assert.ok(Object.isFrozen(active));
  assert.strictEqual(replay.getCandles('1h')[0], input.candles[0]);
  assert.deepEqual(input.candles, before);
});

test('repeated adapters over the same normalized input are deterministic', () => {
  const input = normalizedInput();
  const first = new ReplayCandleEngine(input);
  const second = new ReplayCandleEngine(input);
  const firstSequence = [];
  const secondSequence = [];

  while (first.hasNext()) {
    firstSequence.push(first.nextActive());
    first.finalizeActive();
    secondSequence.push(second.nextActive());
    second.finalizeActive();
  }

  assert.deepEqual(firstSequence, secondSequence);
  assert.deepEqual(first.getCandles('1h'), second.getCandles('1h'));
});

test('does not mutate or depend on a live CandleEngine', () => {
  const live = new CandleEngine({ get: key => (key === 'MAX_HISTORY' ? 2 : undefined) }, {});
  const replay = new ReplayCandleEngine(normalizedInput(2));
  const liveBefore = {
    candles: live.getCandles('1h'),
    active: live.getActive('1h'),
    timeframes: live.getAllTimeframes(),
  };

  replay.nextActive();
  replay.finalizeActive();

  assert.deepEqual(live.getCandles('1h'), liveBefore.candles);
  assert.equal(live.getActive('1h'), liveBefore.active);
  assert.deepEqual(live.getAllTimeframes(), liveBefore.timeframes);
});

test('rejects constructor inputs that violate adapter invariants', () => {
  const input = normalizedInput(2);

  assertReplayError(() => new ReplayCandleEngine(), 'INVALID_TIMEFRAME');
  assertReplayError(() => new ReplayCandleEngine(null), 'INVALID_INPUT');
  assertReplayError(() => new ReplayCandleEngine({ timeframe: '', candles: input.candles }), 'INVALID_TIMEFRAME');
  assertReplayError(() => new ReplayCandleEngine({ timeframe: '1h', candles: [] }), 'INVALID_CANDLES');
  assertReplayError(() => new ReplayCandleEngine({ timeframe: '1h', candles: input.candles.slice() }), 'INVALID_CANDLES');

  const mutableCandle = { ...input.candles[0] };
  const mutableCandles = Object.freeze([mutableCandle, input.candles[1]]);
  assertReplayError(() => new ReplayCandleEngine({ timeframe: '1h', candles: mutableCandles }), 'INVALID_CANDLES');

  const duplicate = Object.freeze([input.candles[0], input.candles[0]]);
  assertReplayError(() => new ReplayCandleEngine({ timeframe: '1h', candles: duplicate }), 'INVALID_CANDLES');

  const outOfOrder = Object.freeze([input.candles[1], input.candles[0]]);
  assertReplayError(() => new ReplayCandleEngine({ timeframe: '1h', candles: outOfOrder }), 'INVALID_CANDLES');
});
