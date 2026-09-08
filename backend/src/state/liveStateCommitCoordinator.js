const { isDeepStrictEqual } = require('node:util');
const crypto = require('node:crypto');

const DURABILITY_UNAVAILABLE = 'LIVE_STATE_DURABILITY_UNAVAILABLE';
const MUTATION_UNCERTIFIED = 'LIVE_STATE_MUTATION_UNCERTIFIED';
const STATE_QUEUE_FULL = 'STATE_QUEUE_FULL';
const AUDIT_UNSAFE = 'AUDIT_UNSAFE';
const AUDIT_QUEUE_FULL = 'AUDIT_QUEUE_FULL';
const AUDIT_INTENT_FAILED = 'AUDIT_INTENT_FAILED';
const AUDIT_COMPLETION_FAILED = 'AUDIT_COMPLETION_FAILED';
const MAX_QUEUE_DEPTH = 5;

class LiveStateCommitError extends Error {
  constructor(code, message, { cause = null, operation = null, phase = null } = {}) {
    super(message, { cause: cause || undefined });
    this.name = 'LiveStateCommitError';
    this.code = code;
    this.cause = cause;
    this.operation = operation;
    this.phase = phase;
    this.storageCode = cause?.code || null;
  }
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a non-array object`);
  }
}

function assertDependencies(aggregate, stateStore) {
  assertObject(aggregate, 'aggregate');
  for (const method of [
    'captureDurableDomainState',
    'captureSnapshotForSequence',
    'getMutationSequence',
    'setMutationSequence',
  ]) {
    if (typeof aggregate[method] !== 'function') {
      throw new TypeError(`aggregate.${method} must be a function`);
    }
  }
  assertObject(stateStore, 'stateStore');
  if (typeof stateStore.write !== 'function') throw new TypeError('stateStore.write must be a function');
}

function isThenable(value) {
  return value !== null
    && (typeof value === 'object' || typeof value === 'function')
    && typeof value.then === 'function';
}

function auditFailureCode(error, phase) {
  if (error?.code === 'LOG_QUEUE_FULL') return AUDIT_QUEUE_FULL;
  if (error?.code === 'LOG_UNSAFE') return AUDIT_UNSAFE;
  return phase === 'intent' ? AUDIT_INTENT_FAILED : AUDIT_COMPLETION_FAILED;
}

function auditUnavailable(operation, phase, cause = null) {
  return new LiveStateCommitError(
    AUDIT_UNSAFE,
    'Audit durability is unavailable',
    { cause, operation, phase },
  );
}

function buildAuditEvent(descriptor, phase, details, correlationId) {
  const builder = descriptor?.[phase];
  const input = typeof builder === 'function' ? builder(details) : builder;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError(`Audit ${phase} descriptor must produce an object`);
  }
  return {
    ...input,
    durability: 'DURABLE_CRITICAL',
    correlationId,
  };
}

async function certifyAudit(logger, eventInput, operation, phase) {
  if (!logger || typeof logger.record !== 'function') {
    throw auditUnavailable(operation, phase);
  }
  if (typeof logger.getHealth === 'function' && logger.getHealth() === 'UNSAFE') {
    throw auditUnavailable(operation, phase);
  }

  let result;
  try {
    result = await logger.record(eventInput);
  } catch (error) {
    const code = auditFailureCode(error, phase);
    throw new LiveStateCommitError(code, 'Audit certification failed', {
      cause: error,
      operation,
      phase,
    });
  }
  if (result?.status !== 'DURABLE_CRITICAL_CERTIFIED') {
    const code = auditFailureCode(result, phase);
    throw new LiveStateCommitError(code, 'Audit certification was not completed', {
      cause: result?.code ? Object.assign(new Error('Audit certification was not completed'), { code: result.code }) : null,
      operation,
      phase,
    });
  }
  return result;
}

function candidateContext(candidate) {
  const nowMs = Date.parse(candidate.savedAt);
  if (!Number.isFinite(nowMs)) throw new TypeError('Candidate snapshot savedAt must be a valid timestamp');
  return {
    expectedFingerprint: candidate.configFingerprint,
    expectedSymbol: candidate.symbol,
    nowMs,
  };
}

function createLiveStateCommitCoordinator({ aggregate, stateStore, logger = null } = {}) {
  assertDependencies(aggregate, stateStore);

  let durabilityHealthy = true;
  let queue = Promise.resolve();
  let queueDepth = 0;
  let inFlight = null;
  let commitQueueRejects = 0;

  function unavailable(operation, cause = null, phase = null) {
    return new LiveStateCommitError(
      DURABILITY_UNAVAILABLE,
      'Live state durability is unavailable',
      { cause, operation, phase },
    );
  }

  function latchUnsafe(operation, cause, phase) {
    durabilityHealthy = false;
    return unavailable(operation, cause, phase);
  }

  function queueFull(operation, kind) {
    commitQueueRejects++;
    if (logger?.record) {
      void Promise.resolve().then(() => logger.record({
        event: 'STATE_QUEUE_FULL',
        source: 'LiveStateCommitCoordinator',
        category: 'operational',
        durability: 'DURABLE_ASYNC',
        level: 'WARNING',
        message: 'Live-state commit capacity is full',
        context: {
          code: STATE_QUEUE_FULL,
          operation: typeof operation === 'string' ? operation : 'unknown',
          queueDepth,
          capacity: MAX_QUEUE_DEPTH,
        },
      })).catch(() => {});
    }
    return new LiveStateCommitError(
      STATE_QUEUE_FULL,
      'Live state commit capacity is full',
      { operation, phase: kind },
    );
  }

  function enqueue(name, kind, work) {
    if (!durabilityHealthy) return Promise.reject(unavailable(name));
    if (queueDepth >= MAX_QUEUE_DEPTH) return Promise.reject(queueFull(name, kind));

    queueDepth++;
    const operation = queue.then(async () => {
      if (!durabilityHealthy) throw unavailable(name);
      inFlight = { name, kind };
      try {
        return await work();
      } finally {
        inFlight = null;
        queueDepth--;
      }
    });
    queue = operation.catch(() => {});
    return operation;
  }

  function runMutation({ name = 'mutation', mutate, audit = null } = {}) {
    if (typeof mutate !== 'function') throw new TypeError('mutate must be a function');

    return enqueue(name, 'mutation', async () => {
      const correlationId = audit ? crypto.randomUUID() : null;
      if (audit) {
        let intent;
        try {
          intent = buildAuditEvent(audit, 'intent', {
            operation: name,
            mutationSequence: aggregate.getMutationSequence(),
          }, correlationId);
        } catch (cause) {
          throw new LiveStateCommitError(AUDIT_INTENT_FAILED, 'Audit intent is invalid', {
            cause,
            operation: name,
            phase: 'intent',
          });
        }
        await certifyAudit(logger, intent, name, 'intent');
      }

      const before = aggregate.captureDurableDomainState();
      const sequence = aggregate.getMutationSequence();
      let result;

      try {
        result = mutate();
        if (isThenable(result)) throw new TypeError('mutate callback must be synchronous');
      } catch (cause) {
        let after;
        try {
          after = aggregate.captureDurableDomainState();
        } catch (captureError) {
          throw latchUnsafe(name, cause, captureError);
        }
        if (isDeepStrictEqual(before, after)) throw cause;
        durabilityHealthy = false;
        throw new LiveStateCommitError(
          MUTATION_UNCERTIFIED,
          'Live mutation failed after changing durable state',
          { cause, operation: name, phase: 'mutation' },
        );
      }

      let after;
      try {
        after = aggregate.captureDurableDomainState();
      } catch (cause) {
        throw latchUnsafe(name, cause, 'capture-after');
      }
      if (isDeepStrictEqual(before, after)) return result;

      if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence === Number.MAX_SAFE_INTEGER) {
        throw latchUnsafe(name, new TypeError('Mutation sequence cannot advance safely'), 'sequence');
      }

      const nextSequence = sequence + 1;
      let candidate;
      try {
        candidate = aggregate.captureSnapshotForSequence(nextSequence);
      } catch (cause) {
        throw latchUnsafe(name, cause, 'capture-candidate');
      }

      let writeResult;
      try {
        writeResult = await stateStore.write(candidate, candidateContext(candidate));
      } catch (cause) {
        throw latchUnsafe(name, cause, 'write');
      }
      if (!writeResult || writeResult.status !== 'WRITTEN') {
        const cause = new Error('State store did not certify the write');
        cause.code = 'STATE_WRITE_UNCERTIFIED';
        throw latchUnsafe(name, cause, 'write-result');
      }

      try {
        aggregate.setMutationSequence(nextSequence);
      } catch (cause) {
        throw latchUnsafe(name, cause, 'sequence-apply');
      }

      if (audit) {
        let completion;
        try {
          completion = buildAuditEvent(audit, 'completion', {
            operation: name,
            result,
            mutationSequence: nextSequence,
          }, correlationId);
        } catch (cause) {
          throw new LiveStateCommitError(AUDIT_COMPLETION_FAILED, 'Audit completion is invalid', {
            cause,
            operation: name,
            phase: 'completion',
          });
        }
        await certifyAudit(logger, completion, name, 'completion');
      }
      return result;
    });
  }

  function readCommitted(read) {
    if (typeof read !== 'function') throw new TypeError('read must be a function');
    return enqueue('committed-read', 'read', async () => read());
  }

  function isDurabilityHealthy() {
    return durabilityHealthy;
  }

  function assertDurabilityHealthy() {
    if (!durabilityHealthy) throw unavailable('assert-durability-healthy');
  }

  function getStatus() {
    return Object.freeze({
      durabilityHealthy,
      queueDepth,
      commitQueueRejects,
      inFlight: inFlight ? Object.freeze({ ...inFlight }) : null,
    });
  }

  return Object.freeze({
    runMutation,
    readCommitted,
    isDurabilityHealthy,
    assertDurabilityHealthy,
    getStatus,
  });
}

module.exports = {
  DURABILITY_UNAVAILABLE,
  AUDIT_COMPLETION_FAILED,
  AUDIT_INTENT_FAILED,
  AUDIT_QUEUE_FULL,
  AUDIT_UNSAFE,
  MAX_QUEUE_DEPTH,
  MUTATION_UNCERTIFIED,
  STATE_QUEUE_FULL,
  LiveStateCommitError,
  createLiveStateCommitCoordinator,
};
