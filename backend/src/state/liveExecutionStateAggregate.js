const {
  FINGERPRINT_PATTERN,
  LiveStateError,
  SCHEMA_VERSION,
  STATE_TYPE,
  validateLiveExecutionState,
} = require('./liveExecutionStateSchema');

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a non-array object`);
  }
}

function assertDependency(dependency, label) {
  assertObject(dependency, label);
  for (const method of ['exportDurableState', 'prepareDurableState', 'applyDurableState']) {
    if (typeof dependency[method] !== 'function') {
      throw new TypeError(`${label}.${method} must be a function`);
    }
  }
}

function readNow(now) {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError('now() must return a valid Date');
  }
  return value;
}

function assertMutationSequence(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('mutationSequence must be a non-negative safe integer');
  }
}

function createLiveExecutionStateAggregate({
  symbol,
  configFingerprint,
  paperTrading,
  advanceRisk,
  executionPipeline,
  now = () => new Date(),
} = {}) {
  if (typeof symbol !== 'string' || symbol.length === 0) throw new TypeError('symbol must be a non-empty string');
  if (typeof configFingerprint !== 'string' || !FINGERPRINT_PATTERN.test(configFingerprint)) {
    throw new TypeError('configFingerprint must be a sha256 fingerprint');
  }
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  assertDependency(paperTrading, 'paperTrading');
  assertDependency(advanceRisk, 'advanceRisk');
  assertDependency(executionPipeline, 'executionPipeline');

  let mutationSequence = 0;

  function getMutationSequence() {
    return mutationSequence;
  }

  function setMutationSequence(nextSequence) {
    assertMutationSequence(nextSequence);
    mutationSequence = nextSequence;
  }

  function expectedContext(nowMs) {
    return { expectedFingerprint: configFingerprint, expectedSymbol: symbol, nowMs };
  }

  function captureSnapshot() {
    const savedAt = readNow(now);
    const snapshot = {
      schemaVersion: SCHEMA_VERSION,
      stateType: STATE_TYPE,
      symbol,
      savedAt: savedAt.toISOString(),
      mutationSequence,
      configFingerprint,
      paperTrading: paperTrading.exportDurableState(),
      advanceRisk: advanceRisk.exportDurableState(),
      executionPipeline: executionPipeline.exportDurableState(),
    };
    return validateLiveExecutionState(snapshot, expectedContext(savedAt.getTime()));
  }

  function restoreSnapshot(snapshot) {
    const current = readNow(now);
    const validated = validateLiveExecutionState(snapshot, expectedContext(current.getTime()));
    const preparedPaper = paperTrading.prepareDurableState(validated.paperTrading);
    const preparedRisk = advanceRisk.prepareDurableState(validated.advanceRisk);
    const preparedPipeline = executionPipeline.prepareDurableState(validated.executionPipeline);
    const preparedSequence = validated.mutationSequence;

    paperTrading.applyDurableState(preparedPaper);
    advanceRisk.applyDurableState(preparedRisk);
    executionPipeline.applyDurableState(preparedPipeline);
    mutationSequence = preparedSequence;
  }

  return Object.freeze({
    captureSnapshot,
    restoreSnapshot,
    getMutationSequence,
    setMutationSequence,
  });
}

module.exports = { createLiveExecutionStateAggregate };
