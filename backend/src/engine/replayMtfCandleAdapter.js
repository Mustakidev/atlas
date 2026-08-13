const { REPLAY_MTF_DURATIONS_MS } = require('./replayMultiTimeframeInput');

const SUPPORTED_TIMEFRAMES = Object.freeze(['1m', '5m', '15m']);
const REQUIRED_INPUT_TIMEFRAMES = Object.freeze([...SUPPORTED_TIMEFRAMES, '1h']);
const COMMON_BOUNDARY_MS = REPLAY_MTF_DURATIONS_MS['1h'];

class ReplayMtfCandleAdapterError extends TypeError {
  constructor(code, message, boundaryTime = null) {
    super(message);
    this.name = 'ReplayMtfCandleAdapterError';
    this.code = code;
    this.boundaryTime = boundaryTime;
  }
}

function fail(code, message, boundaryTime = null) {
  throw new ReplayMtfCandleAdapterError(code, message, boundaryTime);
}

function assertSupportedTimeframe(timeframe) {
  if (!SUPPORTED_TIMEFRAMES.includes(timeframe)) {
    fail('UNSUPPORTED_TIMEFRAME', `Unsupported replay MTF timeframe: ${String(timeframe)}`);
  }
}

function validateLimit(limit) {
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    fail('INVALID_LIMIT', 'Replay MTF candle limit must be a positive integer');
  }
}

function validateSecondaryStream(stream, timeframe) {
  if (!Array.isArray(stream) || !Object.isFrozen(stream) || stream.length === 0) {
    fail('INVALID_INPUT', `timeframes.${timeframe} must be a non-empty frozen array`);
  }

  for (let index = 0; index < stream.length; index++) {
    const candle = stream[index];
    const path = `timeframes.${timeframe}[${index}]`;
    if (!candle || typeof candle !== 'object' || Array.isArray(candle) || !Object.isFrozen(candle)) {
      fail('INVALID_INPUT', `${path} must be a frozen candle object`);
    }
    if (!Number.isFinite(candle.openTime) || !Number.isInteger(candle.openTime)) {
      fail('INVALID_INPUT', `${path}.openTime must be a finite integer`);
    }
    if (!Number.isFinite(candle.closeTime) || !Number.isInteger(candle.closeTime)) {
      fail('INVALID_INPUT', `${path}.closeTime must be a finite integer`);
    }
    if (!Number.isFinite(candle.open)) {
      fail('INVALID_INPUT', `${path}.open must be finite`);
    }
  }
}

function validateInput(normalizedMtfInput) {
  if (!normalizedMtfInput
    || typeof normalizedMtfInput !== 'object'
    || Array.isArray(normalizedMtfInput)
    || !Object.isFrozen(normalizedMtfInput)) {
    fail('INVALID_INPUT', 'normalizedMtfInput must be a frozen non-array object');
  }
  if (normalizedMtfInput.schemaVersion !== 2) {
    fail('INVALID_INPUT', 'normalizedMtfInput.schemaVersion must be 2');
  }
  if (normalizedMtfInput.primaryTimeframe !== '1h') {
    fail('INVALID_INPUT', 'normalizedMtfInput.primaryTimeframe must be 1h');
  }
  if (normalizedMtfInput.sourcePolicy !== 'independent') {
    fail('INVALID_INPUT', 'normalizedMtfInput.sourcePolicy must be independent');
  }
  if (!normalizedMtfInput.timeframes
    || typeof normalizedMtfInput.timeframes !== 'object'
    || Array.isArray(normalizedMtfInput.timeframes)
    || !Object.isFrozen(normalizedMtfInput.timeframes)) {
    fail('INVALID_INPUT', 'normalizedMtfInput.timeframes must be a frozen non-array object');
  }

  for (const timeframe of Reflect.ownKeys(normalizedMtfInput.timeframes)) {
    if (!REQUIRED_INPUT_TIMEFRAMES.includes(timeframe)) {
      fail('INVALID_INPUT', `normalizedMtfInput.timeframes.${String(timeframe)} is unsupported`);
    }
  }
  for (const timeframe of REQUIRED_INPUT_TIMEFRAMES) {
    if (!Object.hasOwn(normalizedMtfInput.timeframes, timeframe)) {
      fail('INVALID_INPUT', `normalizedMtfInput.timeframes.${timeframe} is required`);
    }
    const stream = normalizedMtfInput.timeframes[timeframe];
    if (!Array.isArray(stream) || !Object.isFrozen(stream) || stream.length === 0) {
      fail('INVALID_INPUT', `timeframes.${timeframe} must be a non-empty frozen array`);
    }
    if (SUPPORTED_TIMEFRAMES.includes(timeframe)) {
      validateSecondaryStream(stream, timeframe);
    }
  }

  return normalizedMtfInput.timeframes;
}

function assertBoundaryTime(boundaryTime) {
  if (!Number.isFinite(boundaryTime)
    || !Number.isInteger(boundaryTime)
    || boundaryTime < 0) {
    fail('INVALID_BOUNDARY', 'Replay MTF boundary time must be a non-negative integer', boundaryTime);
  }
  try {
    new Date(boundaryTime).toISOString();
  } catch {
    fail('INVALID_BOUNDARY', 'Replay MTF boundary time must be valid for JavaScript Date', boundaryTime);
  }
  if (boundaryTime % COMMON_BOUNDARY_MS !== 0) {
    fail('INVALID_BOUNDARY', 'Replay MTF boundary must be an exact hourly boundary', boundaryTime);
  }
  return boundaryTime;
}

function createProjection(sourceCandle) {
  const open = sourceCandle.open;
  return Object.freeze({
    open,
    high: open,
    low: open,
    close: open,
    volume: 0,
    openTime: sourceCandle.openTime,
    timestamp: new Date(sourceCandle.openTime).toISOString(),
  });
}

function createReplayMtfCandleAdapter(normalizedMtfInput) {
  const streams = validateInput(normalizedMtfInput);
  const cursors = Object.fromEntries(SUPPORTED_TIMEFRAMES.map(timeframe => [timeframe, 0]));
  const finalized = Object.fromEntries(SUPPORTED_TIMEFRAMES.map(timeframe => [timeframe, []]));
  const active = Object.fromEntries(SUPPORTED_TIMEFRAMES.map(timeframe => [timeframe, null]));
  const activeSourceIndices = Object.fromEntries(SUPPORTED_TIMEFRAMES.map(timeframe => [timeframe, null]));
  const plans = new WeakMap();
  const consumedPlans = new WeakSet();
  let revision = 0;
  let lastBoundaryTime = null;

  function getCandles(timeframe, limit) {
    assertSupportedTimeframe(timeframe);
    validateLimit(limit);
    const candles = finalized[timeframe];
    return limit === undefined ? candles.slice() : candles.slice(-limit);
  }

  function getActive(timeframe) {
    assertSupportedTimeframe(timeframe);
    return active[timeframe];
  }

  function getAllTimeframes() {
    return [...SUPPORTED_TIMEFRAMES];
  }

  function prepareBoundary(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      fail('INVALID_BOUNDARY', 'Replay MTF boundary options must be a non-array object');
    }
    const boundaryTime = assertBoundaryTime(options.boundaryTime);
    if (lastBoundaryTime !== null && boundaryTime <= lastBoundaryTime) {
      fail('INVALID_BOUNDARY', 'Replay MTF boundary must move strictly forward', boundaryTime);
    }

    const nextFinalized = {};
    const nextCursors = {};
    const nextActive = {};
    const nextActiveSourceIndices = {};

    for (const timeframe of SUPPORTED_TIMEFRAMES) {
      const stream = streams[timeframe];
      if (stream[0].openTime > boundaryTime || stream.at(-1).closeTime < boundaryTime) {
        fail('MISSING_BOUNDARY', `Replay MTF stream ${timeframe} does not cover boundary`, boundaryTime);
      }

      let cursor = cursors[timeframe];
      const finalizedCandles = finalized[timeframe].slice();
      while (cursor < stream.length && stream[cursor].closeTime <= boundaryTime) {
        finalizedCandles.push(stream[cursor]);
        cursor += 1;
      }

      const candidate = stream[cursor] || null;
      if (candidate && candidate.openTime < boundaryTime && candidate.closeTime > boundaryTime) {
        fail('NON_CAUSAL_SOURCE', `Replay MTF source ${timeframe} crosses boundary`, boundaryTime);
      }

      nextFinalized[timeframe] = finalizedCandles;
      nextCursors[timeframe] = cursor;
      nextActiveSourceIndices[timeframe] = candidate?.openTime === boundaryTime ? cursor : null;
      nextActive[timeframe] = candidate?.openTime === boundaryTime
        ? createProjection(candidate)
        : null;
    }

    const plan = Object.freeze({ boundaryTime });
    plans.set(plan, {
      expectedRevision: revision,
      expectedBoundaryTime: lastBoundaryTime,
      expectedCursors: { ...cursors },
      expectedActiveSourceIndices: { ...activeSourceIndices },
      nextFinalized,
      nextCursors,
      nextActive,
      nextActiveSourceIndices,
    });
    return plan;
  }

  function commitBoundary(plan) {
    if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
      fail('INVALID_PLAN', 'Replay MTF boundary plan must be an authentic plan object');
    }

    const record = plans.get(plan);
    if (!record) {
      fail(
        consumedPlans.has(plan) ? 'STALE_PLAN' : 'INVALID_PLAN',
        consumedPlans.has(plan)
          ? 'Replay MTF boundary plan was already consumed'
          : 'Replay MTF boundary plan was not created by this adapter',
        plan.boundaryTime ?? null,
      );
    }

    if (record.expectedRevision !== revision
      || record.expectedBoundaryTime !== lastBoundaryTime
      || SUPPORTED_TIMEFRAMES.some(timeframe =>
        record.expectedCursors[timeframe] !== cursors[timeframe]
        || record.expectedActiveSourceIndices[timeframe] !== activeSourceIndices[timeframe])) {
      fail('STALE_PLAN', 'Replay MTF boundary plan does not match adapter state', plan.boundaryTime);
    }

    finalized[SUPPORTED_TIMEFRAMES[0]] = record.nextFinalized[SUPPORTED_TIMEFRAMES[0]];
    finalized[SUPPORTED_TIMEFRAMES[1]] = record.nextFinalized[SUPPORTED_TIMEFRAMES[1]];
    finalized[SUPPORTED_TIMEFRAMES[2]] = record.nextFinalized[SUPPORTED_TIMEFRAMES[2]];
    cursors[SUPPORTED_TIMEFRAMES[0]] = record.nextCursors[SUPPORTED_TIMEFRAMES[0]];
    cursors[SUPPORTED_TIMEFRAMES[1]] = record.nextCursors[SUPPORTED_TIMEFRAMES[1]];
    cursors[SUPPORTED_TIMEFRAMES[2]] = record.nextCursors[SUPPORTED_TIMEFRAMES[2]];
    active[SUPPORTED_TIMEFRAMES[0]] = record.nextActive[SUPPORTED_TIMEFRAMES[0]];
    active[SUPPORTED_TIMEFRAMES[1]] = record.nextActive[SUPPORTED_TIMEFRAMES[1]];
    active[SUPPORTED_TIMEFRAMES[2]] = record.nextActive[SUPPORTED_TIMEFRAMES[2]];
    activeSourceIndices[SUPPORTED_TIMEFRAMES[0]] = record.nextActiveSourceIndices[SUPPORTED_TIMEFRAMES[0]];
    activeSourceIndices[SUPPORTED_TIMEFRAMES[1]] = record.nextActiveSourceIndices[SUPPORTED_TIMEFRAMES[1]];
    activeSourceIndices[SUPPORTED_TIMEFRAMES[2]] = record.nextActiveSourceIndices[SUPPORTED_TIMEFRAMES[2]];
    lastBoundaryTime = plan.boundaryTime;
    revision += 1;
    plans.delete(plan);
    consumedPlans.add(plan);

    return Object.freeze({ boundaryTime: plan.boundaryTime });
  }

  return Object.freeze({
    getCandles,
    getActive,
    getAllTimeframes,
    prepareBoundary,
    commitBoundary,
  });
}

module.exports = { createReplayMtfCandleAdapter, ReplayMtfCandleAdapterError };
