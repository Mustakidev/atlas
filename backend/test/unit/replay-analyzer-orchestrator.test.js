const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeReplayAnalyzerInput } = require('../../src/engine/replayAnalyzerInput');
const { createReplayAnalyzerHistory } = require('../../src/engine/replayAnalyzerHistory');
const {
  createReplayAnalyzerOrchestrator,
  ReplayAnalyzerOrchestratorError,
} = require('../../src/engine/replayAnalyzerOrchestrator');

const BASE_TIME = Date.parse('2024-01-01T00:00:00.000Z');
const SECOND = 1000;
const SYMBOL = 'BTCUSDT';

function rawSnapshot(index, timestampMs = BASE_TIME + index * SECOND) {
  return {
    timestamp: new Date(timestampMs).toISOString(),
    price: 100 + index,
    volume: 1000 + index,
    change24h: index,
  };
}

function makeSource(count = 4, mutate) {
  const snapshots = Array.from({ length: count }, (_, index) => rawSnapshot(index));
  mutate?.(snapshots);
  return normalizeReplayAnalyzerInput({
    schemaVersion: 1,
    symbol: SYMBOL,
    snapshots,
  });
}

function makeHistoryState(initialEventTimestampMs = null) {
  let eventTimestampMs = initialEventTimestampMs;
  let sourceSnapshots = null;
  let visibleSnapshots = [];
  const calls = [];
  return {
    calls,
    setSource(snapshots) {
      sourceSnapshots = snapshots;
      if (eventTimestampMs !== null) {
        visibleSnapshots = sourceSnapshots.filter(snapshot => (
          Date.parse(snapshot.timestamp) <= eventTimestampMs
        ));
      }
    },
    history: {
      advanceThrough(timestampMs) {
        calls.push(['advanceThrough', timestampMs]);
        eventTimestampMs = timestampMs;
        if (sourceSnapshots) {
          visibleSnapshots = sourceSnapshots.filter(snapshot => (
            Date.parse(snapshot.timestamp) <= timestampMs
          ));
        }
      },
      all() {
        return [...visibleSnapshots];
      },
      getEventTimestamp() {
        return eventTimestampMs;
      },
    },
  };
}

function makeSourceHistory(source, selectedIndex, visible = source.snapshots.slice(0, selectedIndex + 1)) {
  let eventTimestampMs = null;
  const calls = [];
  return {
    calls,
    history: {
      advanceThrough(timestampMs) {
        calls.push(['advanceThrough', timestampMs]);
        eventTimestampMs = timestampMs;
      },
      all() {
        return [...visible];
      },
      getEventTimestamp() {
        return eventTimestampMs;
      },
    },
  };
}

function makeOrchestrator({ source = makeSource(), history, state: suppliedState, analyzer, symbol = SYMBOL } = {}) {
  const state = suppliedState || history || makeHistoryState();
  state.setSource?.(source.snapshots);
  const analyzerCalls = analyzer || {
    analyze(value) {
      state.calls.push(['analyze', value]);
    },
  };
  return {
    state,
    analyzer: analyzerCalls,
    orchestrator: createReplayAnalyzerOrchestrator({
      source,
      history: state.history || state,
      analyzer: analyzerCalls,
      symbol,
    }),
  };
}

function assertOrchestratorError(callback, code, boundaryTimeMs) {
  assert.throws(callback, error => {
    assert.ok(error instanceof ReplayAnalyzerOrchestratorError);
    assert.ok(error instanceof TypeError);
    assert.equal(error.name, 'ReplayAnalyzerOrchestratorError');
    assert.equal(error.code, code);
    assert.equal(error.boundaryTimeMs, boundaryTimeMs);
    return true;
  });
}

test('exports exactly the approved A3-1 API', () => {
  assert.deepEqual(Object.keys(require('../../src/engine/replayAnalyzerOrchestrator')), [
    'createReplayAnalyzerOrchestrator',
    'ReplayAnalyzerOrchestratorError',
  ]);
});

test('returns only the runForBoundary facade and does not leak dependencies', () => {
  const { orchestrator } = makeOrchestrator();

  assert.deepEqual(Object.keys(orchestrator), ['runForBoundary']);
  assert.equal(Object.isFrozen(orchestrator), true);
  for (const key of ['source', 'snapshots', 'timestampsMs', 'history', 'analyzer', 'symbol']) {
    assert.equal(orchestrator[key], undefined);
  }
});

test('selects the exact event at the boundary', () => {
  const { orchestrator, state } = makeOrchestrator();
  const boundaryTimeMs = BASE_TIME + SECOND;

  const result = orchestrator.runForBoundary(boundaryTimeMs);

  assert.deepEqual(result, {
    boundaryTimeMs,
    eventTimestampMs: boundaryTimeMs,
    historyAdvanced: true,
  });
  assert.deepEqual(state.calls.map(([name, value]) => [name, value]), [
    ['advanceThrough', boundaryTimeMs],
    ['analyze', state.calls[1][1]],
  ]);
});

test('selects the latest event strictly before the boundary', () => {
  const { orchestrator, state } = makeOrchestrator();
  const boundaryTimeMs = BASE_TIME + 2500;

  const result = orchestrator.runForBoundary(boundaryTimeMs);

  assert.equal(result.eventTimestampMs, BASE_TIME + 2000);
  assert.deepEqual(state.calls.map(([name, value]) => [name, value]), [
    ['advanceThrough', BASE_TIME + 2000],
    ['analyze', state.calls[1][1]],
  ]);
});

test('selects the latest of multiple events before the boundary', () => {
  const { orchestrator, state } = makeOrchestrator();

  const result = orchestrator.runForBoundary(BASE_TIME + 3500);

  assert.equal(result.eventTimestampMs, BASE_TIME + 3000);
  assert.equal(state.calls[0][1], BASE_TIME + 3000);
});

test('excludes a future event and leaves it invisible to history', () => {
  const source = makeSource(2, snapshots => {
    snapshots[0] = rawSnapshot(0, BASE_TIME - SECOND);
    snapshots[1] = rawSnapshot(1, BASE_TIME + SECOND);
  });
  const state = makeHistoryState();
  const visible = [];
  state.history.advanceThrough = timestampMs => {
    state.calls.push(['advanceThrough', timestampMs]);
    visible.push(...source.snapshots.filter(snapshot => Date.parse(snapshot.timestamp) <= timestampMs));
  };
  state.history.all = () => [...visible];
  const analyzer = {
    analyze(history) {
      state.calls.push(['analyze', history.all()]);
    },
  };
  const { orchestrator } = makeOrchestrator({ source, history: state, analyzer });

  const result = orchestrator.runForBoundary(BASE_TIME);

  assert.equal(result.eventTimestampMs, BASE_TIME - SECOND);
  assert.deepEqual(state.history.all(), [source.snapshots[0]]);
  assert.equal(state.history.all().includes(source.snapshots[1]), false);
});

test('fails without a causal event and does not call history or Analyzer', () => {
  const state = makeHistoryState();
  const analyzer = { analyze() { state.calls.push(['analyze']); } };
  const { orchestrator } = makeOrchestrator({
    source: makeSource(2, snapshots => {
      snapshots[0] = rawSnapshot(0, BASE_TIME + SECOND);
      snapshots[1] = rawSnapshot(1, BASE_TIME + 2 * SECOND);
    }),
    history: state,
    analyzer,
  });

  assertOrchestratorError(
    () => orchestrator.runForBoundary(BASE_TIME),
    'NO_CAUSAL_EVENT',
    BASE_TIME,
  );
  assert.deepEqual(state.calls, []);
});

test('rejects a history backed by another source with identical timestamps', () => {
  const source = makeSource(1);
  const otherSource = normalizeReplayAnalyzerInput({
    schemaVersion: 1,
    symbol: SYMBOL,
    snapshots: [{ ...rawSnapshot(0, BASE_TIME),
      price: 500,
      volume: 5000,
      change24h: 50,
    }],
  });
  const history = createReplayAnalyzerHistory(otherSource, { symbol: SYMBOL, maxHistory: 10 });
  let analyzeCalls = 0;
  const { orchestrator } = makeOrchestrator({
    source,
    history,
    analyzer: { analyze() { analyzeCalls++; } },
  });

  assertOrchestratorError(
    () => orchestrator.runForBoundary(BASE_TIME),
    'HISTORY_SOURCE_MISMATCH',
    BASE_TIME,
  );
  assert.equal(analyzeCalls, 0);
  assert.equal(history.getEventTimestamp(), BASE_TIME);
});

test('rejects a wrong history suffix or non-contiguous visible prefix', () => {
  const source = makeSource(4);
  const cases = [
    source.snapshots.slice(0, 2).concat(source.snapshots[3]),
    [source.snapshots[0], source.snapshots[2]],
    [source.snapshots[1], source.snapshots[2]],
  ];

  for (const visible of cases) {
    const state = makeSourceHistory(source, 3, visible);
    const analyzer = { analyze() { throw new Error('Analyzer must not run'); } };
    const { orchestrator } = makeOrchestrator({ source, state, analyzer });

    assertOrchestratorError(
      () => orchestrator.runForBoundary(BASE_TIME + 3 * SECOND),
      'HISTORY_SOURCE_MISMATCH',
      BASE_TIME + 3 * SECOND,
    );
  }
});

test('rejects cloned history items instead of accepting value equality', () => {
  const source = makeSource(2);
  const state = makeSourceHistory(source, 1, [structuredClone(source.snapshots[0]), structuredClone(source.snapshots[1])]);
  const analyzer = { analyze() { throw new Error('Analyzer must not run'); } };
  const { orchestrator } = makeOrchestrator({ source, state, analyzer });

  assertOrchestratorError(
    () => orchestrator.runForBoundary(BASE_TIME + SECOND),
    'HISTORY_SOURCE_MISMATCH',
    BASE_TIME + SECOND,
  );
});

test('rejects empty history after claimed advancement and oversized history', () => {
  const source = makeSource(2);
  for (const visible of [[], source.snapshots.slice(0, 2).concat(source.snapshots[0])]) {
    const state = makeSourceHistory(source, 0, visible);
    const { orchestrator } = makeOrchestrator({ source, state, analyzer: { analyze() {} } });

    assertOrchestratorError(
      () => orchestrator.runForBoundary(BASE_TIME),
      'HISTORY_SOURCE_MISMATCH',
      BASE_TIME,
    );
  }
});

test('supports pre-roll by advancing A2 once through the selected event', () => {
  const { orchestrator, state } = makeOrchestrator();

  const result = orchestrator.runForBoundary(BASE_TIME + 2500);

  assert.equal(result.eventTimestampMs, BASE_TIME + 2000);
  assert.deepEqual(state.calls.slice(0, 1), [['advanceThrough', BASE_TIME + 2000]]);
  assert.equal(state.calls.filter(([name]) => name === 'advanceThrough').length, 1);
});

test('positions history before invoking Analyzer', () => {
  const state = makeHistoryState();
  const analyzer = {
    analyze(history) {
      state.calls.push(['analyze', history.getEventTimestamp()]);
    },
  };
  const { orchestrator } = makeOrchestrator({ state, analyzer });

  orchestrator.runForBoundary(BASE_TIME + SECOND);

  assert.deepEqual(state.calls, [
    ['advanceThrough', BASE_TIME + SECOND],
    ['analyze', BASE_TIME + SECOND],
  ]);
});

test('reuses the same event across boundaries without duplicate A2 advancement', () => {
  const { orchestrator, state } = makeOrchestrator();

  const first = orchestrator.runForBoundary(BASE_TIME + 1500);
  const second = orchestrator.runForBoundary(BASE_TIME + 1800);

  assert.equal(first.eventTimestampMs, BASE_TIME + SECOND);
  assert.equal(second.eventTimestampMs, BASE_TIME + SECOND);
  assert.equal(first.historyAdvanced, true);
  assert.equal(second.historyAdvanced, false);
  assert.equal(state.calls.filter(([name]) => name === 'advanceThrough').length, 1);
  assert.equal(state.calls.filter(([name]) => name === 'analyze').length, 2);
});

test('advances A2 when a newer event becomes causal', () => {
  const { orchestrator, state } = makeOrchestrator();

  orchestrator.runForBoundary(BASE_TIME + 500);
  const result = orchestrator.runForBoundary(BASE_TIME + 2500);

  assert.equal(result.eventTimestampMs, BASE_TIME + 2000);
  assert.deepEqual(state.calls
    .filter(([name]) => name === 'advanceThrough')
    .map(([, timestampMs]) => timestampMs), [BASE_TIME, BASE_TIME + 2000]);
});

test('rejects history already ahead of the selected event', () => {
  const state = makeHistoryState(BASE_TIME + 2000);
  const analyzer = { analyze() { state.calls.push(['analyze']); } };
  const { orchestrator } = makeOrchestrator({ state, analyzer });

  assertOrchestratorError(
    () => orchestrator.runForBoundary(BASE_TIME + 1500),
    'HISTORY_AHEAD_OF_BOUNDARY',
    BASE_TIME + 1500,
  );
  assert.deepEqual(state.calls, []);
});

test('rejects invalid boundary values without touching dependencies', () => {
  const state = makeHistoryState();
  const analyzer = { analyze() { state.calls.push(['analyze']); } };
  const { orchestrator } = makeOrchestrator({ state, analyzer });

  for (const boundaryTimeMs of [undefined, null, '1000', NaN, Infinity, 1.5]) {
    assertOrchestratorError(
      () => orchestrator.runForBoundary(boundaryTimeMs),
      'INVALID_BOUNDARY',
      boundaryTimeMs,
    );
  }
  assert.deepEqual(state.calls, []);
});

test('rejects exact symbol mismatch without touching dependencies', () => {
  const state = makeHistoryState();

  assertOrchestratorError(
    () => makeOrchestrator({ history: state, symbol: 'ETHUSDT' }),
    'SYMBOL_MISMATCH',
    undefined,
  );
  assert.deepEqual(state.calls, []);
});

test('rejects malformed source and dependency interfaces', () => {
  for (const options of [undefined, null, 1, 'options', []]) {
    assertOrchestratorError(
      () => createReplayAnalyzerOrchestrator(options),
      'INVALID_INPUT',
      undefined,
    );
  }

  assertOrchestratorError(
    () => createReplayAnalyzerOrchestrator({
      source: { schemaVersion: 1, symbol: SYMBOL, snapshots: [] },
      history: makeHistoryState().history,
      analyzer: { analyze() {} },
      symbol: SYMBOL,
    }),
    'INVALID_INPUT',
    undefined,
  );

  const source = makeSource();
  for (const history of [null, {}, { advanceThrough() {}, all() {} }]) {
    assertOrchestratorError(
      () => createReplayAnalyzerOrchestrator({ source, history, analyzer: { analyze() {} }, symbol: SYMBOL }),
      'INVALID_INPUT',
      undefined,
    );
  }
  for (const analyzer of [null, {}, { analyze: 'not-a-function' }]) {
    assertOrchestratorError(
      () => createReplayAnalyzerOrchestrator({ source, history: makeHistoryState().history, analyzer, symbol: SYMBOL }),
      'INVALID_INPUT',
      undefined,
    );
  }
});

test('propagates history advancement failures unchanged and skips Analyzer', () => {
  const state = makeHistoryState();
  const error = new Error('controlled history failure');
  state.history.advanceThrough = () => {
    state.calls.push(['advanceThrough']);
    throw error;
  };
  const analyzer = { analyze() { state.calls.push(['analyze']); } };
  const { orchestrator } = makeOrchestrator({ state, analyzer });

  assert.throws(() => orchestrator.runForBoundary(BASE_TIME), actual => actual === error);
  assert.deepEqual(state.calls, [['advanceThrough']]);
});

test('propagates Analyzer failures unchanged after exactly one invocation', () => {
  const state = makeHistoryState();
  const error = new Error('controlled Analyzer failure');
  const analyzer = {
    analyze(history) {
      state.calls.push(['analyze', history.getEventTimestamp()]);
      throw error;
    },
  };
  const { orchestrator } = makeOrchestrator({ state, analyzer });

  assert.throws(() => orchestrator.runForBoundary(BASE_TIME), actual => actual === error);
  assert.deepEqual(state.calls, [
    ['advanceThrough', BASE_TIME],
    ['analyze', BASE_TIME],
  ]);
});

test('returns frozen minimal metadata', () => {
  const { orchestrator } = makeOrchestrator();
  const result = orchestrator.runForBoundary(BASE_TIME + SECOND);

  assert.deepEqual(Object.keys(result), [
    'boundaryTimeMs',
    'eventTimestampMs',
    'historyAdvanced',
  ]);
  assert.equal(Object.isFrozen(result), true);
  result.eventTimestampMs = null;
  assert.equal(result.eventTimestampMs, BASE_TIME + SECOND);
});

test('is compatible with the real A2 history facade and hides future data', () => {
  const source = makeSource(4);
  const history = createReplayAnalyzerHistory(source, { symbol: SYMBOL, maxHistory: 500 });
  const analyses = [];
  const analyzer = {
    analyze(value) {
      analyses.push(value.all());
    },
  };
  const orchestrator = createReplayAnalyzerOrchestrator({
    source,
    history,
    analyzer,
    symbol: SYMBOL,
  });

  const result = orchestrator.runForBoundary(BASE_TIME + 2500);

  assert.equal(result.eventTimestampMs, BASE_TIME + 2000);
  assert.equal(history.getEventTimestamp(), BASE_TIME + 2000);
  assert.deepEqual(history.all(), source.snapshots.slice(0, 3));
  assert.deepEqual(analyses, [source.snapshots.slice(0, 3)]);
  assert.equal(history.all().includes(source.snapshots[3]), false);
});

test('real A2 retention suffix and reused event both remain source-coherent', () => {
  const source = makeSource(4);
  const history = createReplayAnalyzerHistory(source, { symbol: SYMBOL, maxHistory: 2 });
  let analyzeCalls = 0;
  const orchestrator = createReplayAnalyzerOrchestrator({
    source,
    history,
    analyzer: { analyze() { analyzeCalls++; } },
    symbol: SYMBOL,
  });

  const first = orchestrator.runForBoundary(BASE_TIME + 3 * SECOND);
  const second = orchestrator.runForBoundary(BASE_TIME + 3 * SECOND);

  assert.equal(first.historyAdvanced, true);
  assert.equal(second.historyAdvanced, false);
  assert.deepEqual(history.all(), source.snapshots.slice(2, 4));
  assert.equal(analyzeCalls, 2);
});
