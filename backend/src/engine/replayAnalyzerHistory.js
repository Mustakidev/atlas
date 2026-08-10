const TOP_LEVEL_KEYS = ['schemaVersion', 'symbol', 'snapshots'];
const SNAPSHOT_KEYS = ['timestamp', 'price', 'volume', 'change24h'];
const OPTION_KEYS = ['symbol', 'maxHistory'];
const CANONICAL_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

class ReplayAnalyzerHistoryError extends TypeError {
  constructor(code, message, eventTimestampMs) {
    super(message);
    this.name = 'ReplayAnalyzerHistoryError';
    this.code = code;
    this.eventTimestampMs = eventTimestampMs;
  }
}

function fail(code, message, eventTimestampMs) {
  throw new ReplayAnalyzerHistoryError(code, message, eventTimestampMs);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.getPrototypeOf(value) === Object.prototype
    || Object.getPrototypeOf(value) === null;
}

function hasExactKeys(value, expected) {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length
    && expected.every(key => typeof key === 'string' && Object.hasOwn(value, key))
    && keys.every(key => typeof key === 'string' && expected.includes(key));
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) {
    fail('INVALID_INPUT', `${label} must be a plain object`);
  }
}

function assertNormalizedInput(input) {
  assertPlainObject(input, 'normalizedInput');
  if (!Object.isFrozen(input)) {
    fail('INVALID_INPUT', 'normalizedInput must be frozen');
  }
  if (!hasExactKeys(input, TOP_LEVEL_KEYS)) {
    fail('INVALID_INPUT', 'normalizedInput has invalid keys');
  }
  if (input.schemaVersion !== 1) {
    fail('INVALID_INPUT', 'normalizedInput.schemaVersion must be 1');
  }
  if (typeof input.symbol !== 'string' || input.symbol.length === 0) {
    fail('INVALID_INPUT', 'normalizedInput.symbol must be a non-empty string');
  }
  if (!Array.isArray(input.snapshots) || input.snapshots.length === 0) {
    fail('INVALID_INPUT', 'normalizedInput.snapshots must be a non-empty array');
  }
  if (!Object.isFrozen(input.snapshots)) {
    fail('INVALID_INPUT', 'normalizedInput.snapshots must be frozen');
  }

  const timestampsMs = [];
  let previousTimestampMs = null;
  for (let index = 0; index < input.snapshots.length; index++) {
    if (!Object.hasOwn(input.snapshots, index)) {
      fail('INVALID_INPUT', `normalizedInput.snapshots[${index}] must be an own value`);
    }

    const snapshot = input.snapshots[index];
    assertPlainObject(snapshot, `normalizedInput.snapshots[${index}]`);
    if (!Object.isFrozen(snapshot)) {
      fail('INVALID_INPUT', `normalizedInput.snapshots[${index}] must be frozen`);
    }
    if (!hasExactKeys(snapshot, SNAPSHOT_KEYS)) {
      fail('INVALID_INPUT', `normalizedInput.snapshots[${index}] has invalid keys`);
    }
    if (typeof snapshot.timestamp !== 'string'
      || !CANONICAL_TIMESTAMP_PATTERN.test(snapshot.timestamp)) {
      fail('INVALID_INPUT', `normalizedInput.snapshots[${index}].timestamp must be canonical UTC`);
    }

    const timestampMs = Date.parse(snapshot.timestamp);
    if (!Number.isFinite(timestampMs)
      || new Date(timestampMs).toISOString() !== snapshot.timestamp) {
      fail('INVALID_INPUT', `normalizedInput.snapshots[${index}].timestamp must be valid`);
    }
    if (previousTimestampMs !== null && timestampMs <= previousTimestampMs) {
      fail('INVALID_INPUT', 'normalizedInput.snapshots must be strictly chronological');
    }
    if (typeof snapshot.price !== 'number'
      || !Number.isFinite(snapshot.price)
      || snapshot.price <= 0) {
      fail('INVALID_INPUT', `normalizedInput.snapshots[${index}].price must be positive and finite`);
    }
    if (typeof snapshot.volume !== 'number'
      || !Number.isFinite(snapshot.volume)
      || snapshot.volume < 0) {
      fail('INVALID_INPUT', `normalizedInput.snapshots[${index}].volume must be non-negative and finite`);
    }
    if (typeof snapshot.change24h !== 'number' || !Number.isFinite(snapshot.change24h)) {
      fail('INVALID_INPUT', `normalizedInput.snapshots[${index}].change24h must be finite`);
    }

    timestampsMs.push(timestampMs);
    previousTimestampMs = timestampMs;
  }

  return timestampsMs;
}

function assertOptions(options, symbol) {
  assertPlainObject(options, 'options');
  if (!hasExactKeys(options, OPTION_KEYS)) {
    fail('INVALID_INPUT', 'options must contain exactly symbol and maxHistory');
  }
  if (typeof options.symbol !== 'string' || options.symbol.length === 0) {
    fail('INVALID_INPUT', 'options.symbol must be a non-empty string');
  }
  if (options.symbol !== symbol) {
    fail('SYMBOL_MISMATCH', 'options.symbol must match normalizedInput.symbol');
  }
  if (typeof options.maxHistory !== 'number'
    || !Number.isFinite(options.maxHistory)
    || !Number.isInteger(options.maxHistory)
    || options.maxHistory <= 0) {
    fail('INVALID_INPUT', 'options.maxHistory must be a positive integer');
  }
}

function assertEventTimestamp(eventTimestampMs) {
  if (typeof eventTimestampMs !== 'number'
    || !Number.isFinite(eventTimestampMs)
    || !Number.isInteger(eventTimestampMs)) {
    fail('INVALID_EVENT_TIMESTAMP', 'eventTimestampMs must be a finite integer', eventTimestampMs);
  }
}

function createReplayAnalyzerHistory(normalizedInput, options) {
  const sourceTimestampsMs = assertNormalizedInput(normalizedInput);
  assertOptions(options, normalizedInput.symbol);

  const sourceSnapshots = normalizedInput.snapshots;
  const timestampToIndex = new Map(
    sourceTimestampsMs.map((timestampMs, index) => [timestampMs, index]),
  );
  const maxHistory = options.maxHistory;
  let nextSourceIndex = 0;
  let visibleQueue = [];
  let lastEventTimestampMs = null;

  function advanceThrough(eventTimestampMs) {
    assertEventTimestamp(eventTimestampMs);

    if (lastEventTimestampMs !== null) {
      if (eventTimestampMs === lastEventTimestampMs) {
        fail('DUPLICATE_EVENT', 'eventTimestampMs was already consumed', eventTimestampMs);
      }
      if (eventTimestampMs < lastEventTimestampMs) {
        fail('NON_MONOTONIC_EVENT', 'eventTimestampMs must be strictly increasing', eventTimestampMs);
      }
    }

    if (eventTimestampMs < sourceTimestampsMs[0]
      || eventTimestampMs > sourceTimestampsMs[sourceTimestampsMs.length - 1]) {
      fail('EVENT_OUT_OF_RANGE', 'eventTimestampMs is outside the source range', eventTimestampMs);
    }

    const targetIndex = timestampToIndex.get(eventTimestampMs);
    if (targetIndex === undefined) {
      fail('MISSING_EVENT_SNAPSHOT', 'No source snapshot exists at eventTimestampMs', eventTimestampMs);
    }

    const candidateQueue = visibleQueue.concat(
      sourceSnapshots.slice(nextSourceIndex, targetIndex + 1),
    );
    const retainedQueue = candidateQueue.length > maxHistory
      ? candidateQueue.slice(-maxHistory)
      : candidateQueue;

    nextSourceIndex = targetIndex + 1;
    visibleQueue = retainedQueue;
    lastEventTimestampMs = eventTimestampMs;
  }

  function all() {
    return [...visibleQueue];
  }

  function getEventTimestamp() {
    return lastEventTimestampMs;
  }

  return Object.freeze({ advanceThrough, all, getEventTimestamp });
}

module.exports = {
  createReplayAnalyzerHistory,
  ReplayAnalyzerHistoryError,
};
