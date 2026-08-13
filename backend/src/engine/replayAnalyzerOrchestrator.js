const CANONICAL_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

class ReplayAnalyzerOrchestratorError extends TypeError {
  constructor(code, message, boundaryTimeMs) {
    super(message);
    this.name = 'ReplayAnalyzerOrchestratorError';
    this.code = code;
    this.boundaryTimeMs = boundaryTimeMs;
  }
}

function fail(code, message, boundaryTimeMs) {
  throw new ReplayAnalyzerOrchestratorError(code, message, boundaryTimeMs);
}

function assertSource(source, symbol) {
  if (!source || typeof source !== 'object' || Array.isArray(source)
    || !Object.isFrozen(source)) {
    fail('INVALID_INPUT', 'source must be a frozen object');
  }
  if (source.schemaVersion !== 1) {
    fail('INVALID_INPUT', 'source.schemaVersion must be 1');
  }
  if (typeof symbol !== 'string' || symbol.length === 0
    || source.symbol !== symbol) {
    fail('SYMBOL_MISMATCH', 'source.symbol must match symbol exactly');
  }
  if (!Array.isArray(source.snapshots)
    || !Object.isFrozen(source.snapshots)
    || source.snapshots.length === 0) {
    fail('INVALID_INPUT', 'source.snapshots must be a non-empty frozen array');
  }

  const timestampsMs = [];
  let previousTimestampMs = null;
  for (let index = 0; index < source.snapshots.length; index++) {
    const snapshot = source.snapshots[index];
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)
      || !Object.isFrozen(snapshot)) {
      fail('INVALID_INPUT', `source.snapshots[${index}] must be a frozen object`);
    }
    const timestamp = snapshot.timestamp;
    if (typeof timestamp !== 'string' || !CANONICAL_TIMESTAMP_PATTERN.test(timestamp)) {
      fail('INVALID_INPUT', `source.snapshots[${index}].timestamp must be canonical UTC`);
    }

    const timestampMs = Date.parse(timestamp);
    if (!Number.isFinite(timestampMs) || new Date(timestampMs).toISOString() !== timestamp) {
      fail('INVALID_INPUT', `source.snapshots[${index}].timestamp must be valid`);
    }
    if (previousTimestampMs !== null && timestampMs <= previousTimestampMs) {
      fail('INVALID_INPUT', 'source.snapshots must be strictly chronological');
    }

    timestampsMs.push(timestampMs);
    previousTimestampMs = timestampMs;
  }

  return timestampsMs;
}

function assertHistory(history) {
  if (!history || typeof history !== 'object' || Array.isArray(history)
    || typeof history.advanceThrough !== 'function'
    || typeof history.all !== 'function'
    || typeof history.getEventTimestamp !== 'function') {
    fail('INVALID_INPUT', 'history must expose the A2 history interface');
  }
}

function assertAnalyzer(analyzer) {
  if (!analyzer || typeof analyzer !== 'object' || Array.isArray(analyzer)
    || typeof analyzer.analyze !== 'function') {
    fail('INVALID_INPUT', 'analyzer must expose analyze(history)');
  }
}

function assertBoundary(boundaryTimeMs) {
  if (typeof boundaryTimeMs !== 'number'
    || !Number.isFinite(boundaryTimeMs)
    || !Number.isInteger(boundaryTimeMs)) {
    fail('INVALID_BOUNDARY', 'boundaryTimeMs must be a finite integer', boundaryTimeMs);
  }
}

function findLatestAtOrBefore(timestampsMs, boundaryTimeMs) {
  let low = 0;
  let high = timestampsMs.length;

  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (timestampsMs[middle] <= boundaryTimeMs) low = middle + 1;
    else high = middle;
  }

  return low - 1;
}

function assertHistoryCoherence(history, snapshots, selectedIndex, boundaryTimeMs) {
  const visible = history.all();
  if (!Array.isArray(visible) || visible.length === 0 || visible.length > selectedIndex + 1) {
    fail('HISTORY_SOURCE_MISMATCH', 'History does not match the selected source prefix', boundaryTimeMs);
  }

  const expectedStart = selectedIndex - visible.length + 1;
  for (let index = 0; index < visible.length; index++) {
    if (visible[index] !== snapshots[expectedStart + index]) {
      fail('HISTORY_SOURCE_MISMATCH', 'History does not match the selected source prefix', boundaryTimeMs);
    }
  }
}

function createReplayAnalyzerOrchestrator(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    fail('INVALID_INPUT', 'options must be a non-array object');
  }

  const { source, history, analyzer, symbol } = options;
  const timestampsMs = assertSource(source, symbol);
  assertHistory(history);
  assertAnalyzer(analyzer);

  function runForBoundary(boundaryTimeMs) {
    assertBoundary(boundaryTimeMs);

    const selectedIndex = findLatestAtOrBefore(timestampsMs, boundaryTimeMs);
    if (selectedIndex < 0) {
      fail('NO_CAUSAL_EVENT', 'No source event exists at or before boundaryTimeMs', boundaryTimeMs);
    }

    const eventTimestampMs = timestampsMs[selectedIndex];
    const currentHistoryEventMs = history.getEventTimestamp();
    if (currentHistoryEventMs !== null
      && (typeof currentHistoryEventMs !== 'number'
        || !Number.isFinite(currentHistoryEventMs)
        || !Number.isInteger(currentHistoryEventMs))) {
      fail('INVALID_INPUT', 'history.getEventTimestamp() must return null or a timestamp', boundaryTimeMs);
    }
    if (currentHistoryEventMs !== null && currentHistoryEventMs > eventTimestampMs) {
      fail('HISTORY_AHEAD_OF_BOUNDARY', 'History is ahead of the selected causal event', boundaryTimeMs);
    }

    const historyAdvanced = currentHistoryEventMs === null
      || currentHistoryEventMs < eventTimestampMs;
    if (historyAdvanced) history.advanceThrough(eventTimestampMs);

    assertHistoryCoherence(history, source.snapshots, selectedIndex, boundaryTimeMs);
    analyzer.analyze(history);

    return Object.freeze({
      boundaryTimeMs,
      eventTimestampMs,
      historyAdvanced,
    });
  }

  return Object.freeze({ runForBoundary });
}

module.exports = {
  createReplayAnalyzerOrchestrator,
  ReplayAnalyzerOrchestratorError,
};
