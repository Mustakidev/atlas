const assert = require('node:assert/strict');
const test = require('node:test');

const { registerLiveSnapshotHandler } = require('../../src/core/liveSnapshot');

function harness({ commitCoordinator } = {}) {
  const calls = [];
  let handler;
  const history = {};
  const snapshot = { price: 123 };
  const eventBus = {
    on(event, callback) {
      calls.push(['register', event]);
      handler = callback;
    },
  };
  const analyzer = {
    analyze(value) {
      calls.push(['analyzer', value]);
    },
  };
  const signalHistoryEngine = {
    record() {
      calls.push(['signalHistory']);
    },
  };
  const executionPipeline = {
    run(...args) {
      calls.push(['pipeline', args]);
    },
  };

  const registered = registerLiveSnapshotHandler({
    eventBus,
    history,
    analyzer,
    signalHistoryEngine,
    executionPipeline,
    commitCoordinator,
  });

  return { calls, handler, registered, history, snapshot };
}

test('registers the market snapshot handler and preserves listener order', () => {
  const state = harness();

  assert.strictEqual(state.registered, state.handler);
  assert.deepEqual(state.calls.slice(0, 1), [['register', 'market:snapshot']]);

  state.handler(state.snapshot);

  assert.deepEqual(state.calls.slice(1).map(([name]) => name), [
    'analyzer',
    'signalHistory',
    'pipeline',
  ]);
  assert.strictEqual(state.calls[1][1], state.history);
  assert.deepEqual(state.calls[3][1], [state.snapshot]);
});

test('first ingest without transition calls pipeline with exactly one argument', () => {
  const state = harness();

  state.handler(state.snapshot, undefined);

  const pipelineCalls = state.calls.filter(([name]) => name === 'pipeline');
  assert.equal(pipelineCalls.length, 1);
  assert.deepEqual(pipelineCalls[0][1], [state.snapshot]);
});

test('same-bucket null finalization preserves the active-candle fallback', () => {
  const state = harness();
  const transition = { finalized: { '1h': null, '5m': {} } };

  state.handler(state.snapshot, transition);

  const pipelineArgs = state.calls.find(([name]) => name === 'pipeline')[1];
  assert.equal(pipelineArgs.length, 1);
  assert.strictEqual(pipelineArgs[0], state.snapshot);
});

test('exact boundary passes the completed 1h candle by identity', () => {
  const state = harness();
  const oneMinute = { openTime: 60000 };
  const completedOneHour = { openTime: 3600000 };
  const fourHour = { openTime: 14400000 };
  const transition = {
    finalized: {
      '1m': oneMinute,
      '5m': { openTime: 300000 },
      '15m': { openTime: 900000 },
      '30m': { openTime: 1800000 },
      '1h': completedOneHour,
      '4h': fourHour,
    },
  };

  state.handler(state.snapshot, transition);

  const pipelineArgs = state.calls.find(([name]) => name === 'pipeline')[1];
  assert.equal(pipelineArgs.length, 2);
  assert.strictEqual(pipelineArgs[0], state.snapshot);
  assert.strictEqual(pipelineArgs[0].price, 123);
  assert.strictEqual(pipelineArgs[1].lifecycleCandle, transition.finalized['1h']);
  assert.notStrictEqual(pipelineArgs[1].lifecycleCandle, transition.finalized['1m']);
  assert.notStrictEqual(pipelineArgs[1].lifecycleCandle, transition.finalized['4h']);
});

test('malformed or missing transitions are treated as no completed lifecycle candle', () => {
  for (const transition of [null, {}, { finalized: null }, { finalized: {} }]) {
    const state = harness();

    state.handler(state.snapshot, transition);

    const pipelineArgs = state.calls.find(([name]) => name === 'pipeline')[1];
    assert.deepEqual(pipelineArgs, [state.snapshot]);
  }
});

test('optional coordinator wraps the complete synchronous snapshot operation', async () => {
  let callback;
  const commitCoordinator = {
    runMutation({ name, mutate }) {
      assert.equal(name, 'live-snapshot');
      callback = mutate;
      const result = mutate();
      assert.equal(result, undefined);
      return Promise.resolve('committed');
    },
  };
  const state = harness({ commitCoordinator });

  const result = state.handler(state.snapshot);
  assert.equal(typeof result.then, 'function');
  assert.equal(callback !== undefined, true);
  assert.deepEqual(state.calls.slice(1).map(([name]) => name), [
    'analyzer',
    'signalHistory',
    'pipeline',
  ]);
  assert.equal(await result, 'committed');
});
