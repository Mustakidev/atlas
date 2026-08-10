const test = require('node:test');
const assert = require('node:assert/strict');

const { HistoryEngine } = require('../../src/engine/history');
const { MarketAnalyzer } = require('../../src/engine/analyzer');
const { normalizeReplayAnalyzerInput } = require('../../src/engine/replayAnalyzerInput');
const {
  createReplayAnalyzerHistory,
  ReplayAnalyzerHistoryError,
} = require('../../src/engine/replayAnalyzerHistory');

const BASE_TIME = Date.parse('2024-01-01T00:00:00.000Z');
const SECOND = 1000;
const SYMBOL = 'BTCUSDT';
const logger = { info() {}, warn() {}, error() {} };

function rawSnapshot(index, timestampMs = BASE_TIME + index * SECOND) {
  return {
    timestamp: new Date(timestampMs).toISOString(),
    price: 100 + index * 0.25,
    volume: 1000 + index,
    change24h: index / 10,
  };
}

function makeInput(count = 3, symbol = SYMBOL, mutate) {
  const snapshots = Array.from({ length: count }, (_, index) => rawSnapshot(index));
  mutate?.(snapshots);
  return normalizeReplayAnalyzerInput({
    schemaVersion: 1,
    symbol,
    snapshots,
  });
}

function options(maxHistory = 500, symbol = SYMBOL) {
  return { symbol, maxHistory };
}

function makeHistory(input, maxHistory = 500, symbol = SYMBOL) {
  return createReplayAnalyzerHistory(input, options(maxHistory, symbol));
}

function makeLiveHistory(maxHistory) {
  return new HistoryEngine({ get: key => key === 'MAX_HISTORY' ? maxHistory : undefined }, logger, SYMBOL);
}

function assertHistoryError(callback, code, eventTimestampMs) {
  assert.throws(callback, error => {
    assert.ok(error instanceof ReplayAnalyzerHistoryError);
    assert.ok(error instanceof TypeError);
    assert.equal(error.name, 'ReplayAnalyzerHistoryError');
    assert.equal(error.code, code);
    assert.equal(error.eventTimestampMs, eventTimestampMs);
    return true;
  });
}

function semanticAnalysis(value) {
  if (value === null) return null;
  const copy = structuredClone(value);
  delete copy.analyzedAt;
  return copy;
}

test('exports exactly the approved A2 API', () => {
  assert.deepEqual(Object.keys(require('../../src/engine/replayAnalyzerHistory')), [
    'createReplayAnalyzerHistory',
    'ReplayAnalyzerHistoryError',
  ]);
});

test('returns only the history facade and starts empty', () => {
  const history = makeHistory(makeInput());

  assert.deepEqual(Object.keys(history), ['advanceThrough', 'all', 'getEventTimestamp']);
  assert.equal(history.getEventTimestamp(), null);
  assert.deepEqual(history.all(), []);
  assert.notStrictEqual(history.all(), history.all());
  for (const key of ['source', 'snapshots', 'cursor', 'queue', 'timestampToIndex', 'maxHistory']) {
    assert.equal(history[key], undefined);
  }
});

test('accepts exact symbol binding and preserves frozen A1 snapshot references', () => {
  const input = makeInput();
  const history = makeHistory(input, 2);
  const timestampMs = Date.parse(input.snapshots[1].timestamp);

  history.advanceThrough(timestampMs);

  assert.equal(history.getEventTimestamp(), timestampMs);
  assert.deepEqual(history.all(), [input.snapshots[0], input.snapshots[1]]);
  assert.strictEqual(history.all()[0], input.snapshots[0]);
  assert.ok(Object.isFrozen(history.all()[0]));
  assert.ok(Object.isFrozen(history.all()[1]));
});

test('consumes pre-roll through a later exact event and hides future source data', () => {
  const input = makeInput(8);
  const history = makeHistory(input, 3);

  history.advanceThrough(Date.parse(input.snapshots[5].timestamp));

  assert.deepEqual(history.all(), input.snapshots.slice(3, 6));
  assert.equal(history.getEventTimestamp(), Date.parse(input.snapshots[5].timestamp));
  assert.equal(history.all().some(snapshot => snapshot === input.snapshots[6]), false);
  assert.equal(history.all().some(snapshot => snapshot === input.snapshots[7]), false);
});

test('advances through a long sequence while preserving only the configured retention', () => {
  const input = makeInput(503);
  const history = makeHistory(input, 500);

  for (let index = 0; index < input.snapshots.length; index++) {
    history.advanceThrough(Date.parse(input.snapshots[index].timestamp));
  }

  assert.equal(history.all().length, 500);
  assert.deepEqual(history.all(), input.snapshots.slice(3));
});

test('matches real HistoryEngine for multiple retentions and source lengths', () => {
  for (const maxHistory of [1, 2, 500]) {
    for (const count of [1, 2, 499, 500, 501, 503]) {
      const input = makeInput(count);
      const liveHistory = makeLiveHistory(maxHistory);
      const replayHistory = makeHistory(input, maxHistory);

      for (const snapshot of input.snapshots) {
        liveHistory.add(snapshot);
        replayHistory.advanceThrough(Date.parse(snapshot.timestamp));
        assert.deepEqual(replayHistory.all(), liveHistory.all(), `${maxHistory}/${count}`);
      }
    }
  }
});

test('matches MarketAnalyzer semantics at identical raw event times', () => {
  const input = makeInput(80);
  const liveHistory = makeLiveHistory(500);
  const replayHistory = makeHistory(input, 500);
  const liveAnalyzer = new MarketAnalyzer(logger, SYMBOL);
  const replayAnalyzer = new MarketAnalyzer(logger, SYMBOL);

  for (const snapshot of input.snapshots) {
    const timestampMs = Date.parse(snapshot.timestamp);
    liveHistory.add(snapshot);
    liveAnalyzer.analyze(liveHistory);
    replayHistory.advanceThrough(timestampMs);
    replayAnalyzer.analyze(replayHistory);

    assert.deepEqual(
      semanticAnalysis(replayAnalyzer.getAnalysis()),
      semanticAnalysis(liveAnalyzer.getAnalysis()),
      `analyzer parity at ${timestampMs}`,
    );
  }
});

test('all returns fresh arrays and array mutation cannot alter adapter state', () => {
  const input = makeInput(3);
  const history = makeHistory(input, 3);

  history.advanceThrough(Date.parse(input.snapshots[1].timestamp));
  const first = history.all();
  first.pop();
  first.push(input.snapshots[2]);

  assert.deepEqual(history.all(), input.snapshots.slice(0, 2));
  assert.notStrictEqual(first, history.all());
  assert.deepEqual(input.snapshots.map(snapshot => snapshot.price), [100, 100.25, 100.5]);
});

test('does not mutate normalized input or source snapshot objects', () => {
  const input = makeInput(3);
  const before = structuredClone(input);
  const refs = [...input.snapshots];
  const history = makeHistory(input, 2);

  history.advanceThrough(Date.parse(input.snapshots[2].timestamp));

  assert.deepEqual(input, before);
  assert.deepEqual(input.snapshots, refs);
  assert.deepEqual(history.all(), input.snapshots.slice(1));
});

test('rejects missing exact raw events without falling backward or forward', () => {
  const input = makeInput(3);
  const history = makeHistory(input);
  const missing = BASE_TIME + 500;

  assertHistoryError(
    () => history.advanceThrough(missing),
    'MISSING_EVENT_SNAPSHOT',
    missing,
  );
  assert.equal(history.getEventTimestamp(), null);
  assert.deepEqual(history.all(), []);
});

test('rejects invalid, out-of-range, duplicate, and non-monotonic events atomically', () => {
  const input = makeInput(4);
  const history = makeHistory(input, 2);
  const first = Date.parse(input.snapshots[0].timestamp);
  const second = Date.parse(input.snapshots[1].timestamp);
  const beforeRange = first - 1;
  const afterRange = Date.parse(input.snapshots[3].timestamp) + 1;

  for (const value of [undefined, null, '1000', 1.5, NaN, Infinity]) {
    assertHistoryError(() => history.advanceThrough(value), 'INVALID_EVENT_TIMESTAMP', value);
    assert.equal(history.getEventTimestamp(), null);
    assert.deepEqual(history.all(), []);
  }
  assertHistoryError(() => history.advanceThrough(beforeRange), 'EVENT_OUT_OF_RANGE', beforeRange);
  assertHistoryError(() => history.advanceThrough(afterRange), 'EVENT_OUT_OF_RANGE', afterRange);
  assert.deepEqual(history.all(), []);

  history.advanceThrough(first);
  const visibleBeforeFailure = history.all();
  assertHistoryError(() => history.advanceThrough(first), 'DUPLICATE_EVENT', first);
  assert.deepEqual(history.all(), visibleBeforeFailure);
  assert.equal(history.getEventTimestamp(), first);

  assertHistoryError(() => history.advanceThrough(first - 1), 'NON_MONOTONIC_EVENT', first - 1);
  assert.deepEqual(history.all(), visibleBeforeFailure);
  assert.equal(history.getEventTimestamp(), first);

  history.advanceThrough(second);
  assert.deepEqual(history.all(), input.snapshots.slice(0, 2));
});

test('later valid advancement consumes the untouched source span after a missing event failure', () => {
  const input = makeInput(4);
  const history = makeHistory(input, 4);
  const first = Date.parse(input.snapshots[0].timestamp);
  const second = Date.parse(input.snapshots[1].timestamp);

  assertHistoryError(
    () => history.advanceThrough(first + 500),
    'MISSING_EVENT_SNAPSHOT',
    first + 500,
  );
  history.advanceThrough(second);

  assert.deepEqual(history.all(), input.snapshots.slice(0, 2));
  assert.equal(history.getEventTimestamp(), second);
});

test('rejects symbol binding errors without trimming, defaulting, or coercion', () => {
  const input = makeInput(1, 'BTCUSDT');

  assert.doesNotThrow(() => makeHistory(input, 1, 'BTCUSDT'));
  assert.doesNotThrow(() => createReplayAnalyzerHistory(input, {
    maxHistory: 1,
    symbol: 'BTCUSDT',
  }));
  assertHistoryError(() => makeHistory(input, 1, 'btcusdt'), 'SYMBOL_MISMATCH');
  assertHistoryError(() => createReplayAnalyzerHistory(input), 'INVALID_INPUT');
  assertHistoryError(() => createReplayAnalyzerHistory(input, { maxHistory: 1 }), 'INVALID_INPUT');
  assertHistoryError(() => makeHistory(input, 1, ''), 'INVALID_INPUT');
  assertHistoryError(() => makeHistory(input, 1, ' BTCUSDT '), 'SYMBOL_MISMATCH');
});

test('accepts reordered normalized root and snapshot keys', () => {
  const input = makeInput(2);
  const reorderedSnapshot = Object.freeze({
    change24h: input.snapshots[0].change24h,
    volume: input.snapshots[0].volume,
    price: input.snapshots[0].price,
    timestamp: input.snapshots[0].timestamp,
  });
  const reorderedSnapshots = Object.freeze([reorderedSnapshot, input.snapshots[1]]);
  const reorderedInput = Object.freeze({
    snapshots: reorderedSnapshots,
    symbol: input.symbol,
    schemaVersion: input.schemaVersion,
  });

  const history = createReplayAnalyzerHistory(reorderedInput, options(2));

  assert.doesNotThrow(() => history.advanceThrough(Date.parse(reorderedSnapshot.timestamp)));
  assert.deepEqual(history.all(), [reorderedSnapshot]);
});

test('rejects invalid maxHistory values and unknown options', () => {
  const input = makeInput();

  for (const maxHistory of [0, -1, 1.5, NaN, Infinity, '500', undefined]) {
    assertHistoryError(
      () => createReplayAnalyzerHistory(input, { symbol: SYMBOL, maxHistory }),
      'INVALID_INPUT',
    );
  }
  assert.doesNotThrow(() => createReplayAnalyzerHistory(input, {
    symbol: SYMBOL,
    maxHistory: Number.MAX_SAFE_INTEGER,
  }));
  assertHistoryError(
    () => createReplayAnalyzerHistory(input, { symbol: SYMBOL, maxHistory: 1, extra: true }),
    'INVALID_INPUT',
  );

  const symbolKey = Symbol('unexpected');
  const optionsWithSymbolKey = { symbol: SYMBOL, maxHistory: 1 };
  optionsWithSymbolKey[symbolKey] = true;
  assertHistoryError(
    () => createReplayAnalyzerHistory(input, optionsWithSymbolKey),
    'INVALID_INPUT',
  );
});

test('rejects representative unfrozen and malformed normalized lookalikes', () => {
  const input = makeInput(2);
  const rootWithExtra = Object.freeze({ ...input, extra: true });
  const wrongSchema = Object.freeze({ ...input, schemaVersion: 2 });
  const unfrozenSnapshots = Object.freeze({ ...input, snapshots: [...input.snapshots] });
  const unfrozenSnapshot = Object.freeze({
    ...input,
    snapshots: Object.freeze([{ ...input.snapshots[0] }, input.snapshots[1]]),
  });
  const badTimestamp = Object.freeze({
    ...input,
    snapshots: Object.freeze([Object.freeze({ ...input.snapshots[0], timestamp: '2024-01-01T00:00:00Z' })]),
  });
  const badNumber = Object.freeze({
    ...input,
    snapshots: Object.freeze([Object.freeze({ ...input.snapshots[0], price: '100' }), input.snapshots[1]]),
  });
  const unknownSnapshotKey = Object.freeze({
    ...input,
    snapshots: Object.freeze([Object.freeze({ ...input.snapshots[0], extra: true }), input.snapshots[1]]),
  });
  const nonChronological = Object.freeze({
    ...input,
    snapshots: Object.freeze([input.snapshots[1], input.snapshots[0]]),
  });

  for (const value of [
    { ...input },
    rootWithExtra,
    wrongSchema,
    unfrozenSnapshots,
    unfrozenSnapshot,
    badTimestamp,
    badNumber,
    unknownSnapshotKey,
    nonChronological,
  ]) {
    assertHistoryError(() => createReplayAnalyzerHistory(value, options()), 'INVALID_INPUT');
  }
});

test('configured retention of one and two matches live HistoryEngine exactly', () => {
  const input = makeInput(5);

  for (const maxHistory of [1, 2]) {
    const liveHistory = makeLiveHistory(maxHistory);
    const replayHistory = makeHistory(input, maxHistory);
    for (const snapshot of input.snapshots) {
      liveHistory.add(snapshot);
      replayHistory.advanceThrough(Date.parse(snapshot.timestamp));
      assert.deepEqual(replayHistory.all(), liveHistory.all());
      assert.equal(replayHistory.all().length, Math.min(maxHistory, liveHistory.size()));
    }
  }
});
