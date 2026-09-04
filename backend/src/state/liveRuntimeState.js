const STATES = Object.freeze({
  STARTING: 'STARTING',
  RESTORING: 'RESTORING',
  UNINITIALIZED: 'UNINITIALIZED',
  INITIALIZING: 'INITIALIZING',
  READY: 'READY',
  FAILED: 'FAILED',
  UNSAFE: 'UNSAFE',
});

class LiveRuntimeStateError extends Error {
  constructor(code, message, { cause = null } = {}) {
    super(message, { cause: cause || undefined });
    this.name = 'LiveRuntimeStateError';
    this.code = code;
    this.cause = cause;
  }
}

function assertCoordinator(coordinator) {
  if (!coordinator || typeof coordinator !== 'object'
    || typeof coordinator.isDurabilityHealthy !== 'function') {
    throw new TypeError('coordinator must expose isDurabilityHealthy()');
  }
}

function createLiveRuntimeState({ sequenceProvider = null } = {}) {
  if (sequenceProvider !== null && typeof sequenceProvider !== 'function') {
    throw new TypeError('sequenceProvider must be a function or null');
  }

  let state = STATES.STARTING;
  let coordinator = null;
  let failure = false;
  let activationStarted = false;
  let initializationPromise = null;

  function getEffectiveState() {
    if (state === STATES.READY && coordinator && !coordinator.isDurabilityHealthy()) {
      return STATES.UNSAFE;
    }
    return state;
  }

  function getMutationSequence() {
    if (!sequenceProvider || ![STATES.READY, STATES.UNSAFE].includes(getEffectiveState())) return null;
    return sequenceProvider();
  }

  function getStatus() {
    const effectiveState = getEffectiveState();
    return Object.freeze({
      state,
      effectiveState,
      durabilityHealthy: coordinator ? coordinator.isDurabilityHealthy() : null,
      mutationSequence: getMutationSequence(),
      activationStarted,
      failure,
    });
  }

  function transition(nextState) {
    state = nextState;
  }

  function beginRestore() {
    if (state !== STATES.STARTING) {
      throw new LiveRuntimeStateError('LIVE_STATE_TRANSITION_INVALID', 'Live state restore cannot start in the current state');
    }
    transition(STATES.RESTORING);
  }

  function markUninitialized() {
    if (![STATES.STARTING, STATES.RESTORING, STATES.INITIALIZING].includes(state)) {
      throw new LiveRuntimeStateError('LIVE_STATE_TRANSITION_INVALID', 'Live state cannot become uninitialized in the current state');
    }
    transition(STATES.UNINITIALIZED);
  }

  function markFailed() {
    failure = true;
    transition(STATES.FAILED);
  }

  function requireReady() {
    if (getEffectiveState() !== STATES.READY) {
      const code = getEffectiveState() === STATES.UNSAFE
        ? 'LIVE_STATE_DURABILITY_UNAVAILABLE'
        : 'LIVE_STATE_NOT_READY';
      throw new LiveRuntimeStateError(code, 'Live state is not ready');
    }
  }

  function getCommitCoordinator() {
    return coordinator;
  }

  async function activateCoordinator(nextCoordinator, onActivated = () => {}) {
    assertCoordinator(nextCoordinator);
    if (![STATES.RESTORING, STATES.INITIALIZING].includes(state)) {
      throw new LiveRuntimeStateError('LIVE_STATE_TRANSITION_INVALID', 'Live state coordinator cannot activate in the current state');
    }
    if (activationStarted) {
      throw new LiveRuntimeStateError('LIVE_STATE_ACTIVATION_DUPLICATE', 'Live state coordinator activation already started');
    }

    activationStarted = true;
    coordinator = nextCoordinator;
    try {
      await onActivated();
      transition(STATES.READY);
      return getStatus();
    } catch (cause) {
      markFailed();
      throw new LiveRuntimeStateError(
        'LIVE_STATE_ACTIVATION_FAILED',
        'Live state activation failed',
        { cause },
      );
    }
  }

  function beginInitialization() {
    if (state !== STATES.UNINITIALIZED) {
      throw new LiveRuntimeStateError('LIVE_STATE_NOT_INITIALIZABLE', 'Live state is not ready for initialization');
    }
    if (initializationPromise) {
      throw new LiveRuntimeStateError('LIVE_STATE_INITIALIZATION_IN_PROGRESS', 'Initialization already in progress');
    }
    transition(STATES.INITIALIZING);
  }

  function finishInitialization(promise) {
    initializationPromise = promise;
    return promise.finally(() => {
      initializationPromise = null;
    });
  }

  return Object.freeze({
    STATES,
    getState: () => state,
    getEffectiveState,
    getStatus,
    getMutationSequence,
    getCommitCoordinator,
    isReady: () => getEffectiveState() === STATES.READY,
    requireReady,
    beginRestore,
    markUninitialized,
    markFailed,
    activateCoordinator,
    beginInitialization,
    finishInitialization,
  });
}

module.exports = { STATES, LiveRuntimeStateError, createLiveRuntimeState };
