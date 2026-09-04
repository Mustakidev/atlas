const assert = require('node:assert/strict');
const test = require('node:test');

const {
  STATES,
  LiveRuntimeStateError,
  createLiveRuntimeState,
} = require('../../src/state/liveRuntimeState');

function coordinator(healthy = true) {
  return { isDurabilityHealthy: () => healthy };
}

test('tracks restore, activation, readiness, and the durable sequence', async () => {
  let sequence = 0;
  const runtime = createLiveRuntimeState({ sequenceProvider: () => sequence });

  assert.equal(runtime.getState(), STATES.STARTING);
  runtime.beginRestore();
  assert.equal(runtime.getState(), STATES.RESTORING);

  await runtime.activateCoordinator(coordinator(), async () => { sequence = 4; });

  assert.equal(runtime.isReady(), true);
  assert.deepEqual(runtime.getStatus(), {
    state: STATES.READY,
    effectiveState: STATES.READY,
    durabilityHealthy: true,
    mutationSequence: 4,
    activationStarted: true,
    failure: false,
  });
  await assert.rejects(runtime.activateCoordinator(coordinator()), error =>
    error instanceof LiveRuntimeStateError && error.code === 'LIVE_STATE_TRANSITION_INVALID');
});

test('reports UNSAFE and rejects live work when durability becomes unhealthy', () => {
  const runtime = createLiveRuntimeState();
  runtime.beginRestore();

  return runtime.activateCoordinator(coordinator(false)).then(() => {
    assert.equal(runtime.getEffectiveState(), STATES.UNSAFE);
    assert.throws(() => runtime.requireReady(), error =>
      error instanceof LiveRuntimeStateError && error.code === 'LIVE_STATE_DURABILITY_UNAVAILABLE');
  });
});

test('supports explicit initialization and clears its in-flight promise', async () => {
  const runtime = createLiveRuntimeState();
  runtime.beginRestore();
  runtime.markUninitialized();
  runtime.beginInitialization();

  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const finished = runtime.finishInitialization(pending);
  assert.throws(() => runtime.beginInitialization(), error =>
    error instanceof LiveRuntimeStateError && error.code === 'LIVE_STATE_NOT_INITIALIZABLE');

  release();
  await finished;
  runtime.markUninitialized();
  assert.equal(runtime.getState(), STATES.UNINITIALIZED);
  assert.equal(runtime.getStatus().failure, false);
});

test('activation failures latch FAILED and preserve the cause', async () => {
  const runtime = createLiveRuntimeState();
  runtime.beginRestore();
  const cause = new Error('activation failed');

  await assert.rejects(
    runtime.activateCoordinator(coordinator(), async () => { throw cause; }),
    error => error.code === 'LIVE_STATE_ACTIVATION_FAILED' && error.cause === cause,
  );
  assert.equal(runtime.getState(), STATES.FAILED);
  assert.equal(runtime.getStatus().failure, true);
});
