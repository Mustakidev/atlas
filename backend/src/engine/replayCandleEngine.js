const { TIMEFRAMES } = require('./candles');

class ReplayCandleError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = 'ReplayCandleError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ReplayCandleError(code, message);
}

function normalizeTimeframe(timeframe) {
  if (typeof timeframe !== 'string' || timeframe.trim() === '') {
    fail('INVALID_TIMEFRAME', 'Replay candle timeframe must be a non-empty string');
  }

  return timeframe.trim().toLowerCase();
}

function assertBoundaryTime(boundaryTime) {
  if (!Number.isFinite(boundaryTime)
    || !Number.isInteger(boundaryTime)
    || boundaryTime < 0) {
    fail('INVALID_BOUNDARY', 'Replay boundary time must be a non-negative integer timestamp');
  }

  try {
    new Date(boundaryTime).toISOString();
  } catch (error) {
    fail('INVALID_BOUNDARY', 'Replay boundary time must be valid for JavaScript Date');
  }

  return boundaryTime;
}

function sourceDurationMs(timeframe) {
  const durationSeconds = TIMEFRAMES[timeframe];
  if (!durationSeconds) {
    fail('UNSUPPORTED_TIMEFRAME', `Replay boundary timeframe is unsupported: ${timeframe}`);
  }

  return durationSeconds * 1000;
}

function validateBoundaryCandle(candle, index) {
  if (!candle || typeof candle !== 'object' || Array.isArray(candle) || !Object.isFrozen(candle)) {
    fail('INVALID_CANDLE', `Replay source candle ${index} must be a frozen object`);
  }

  if (![candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite)) {
    fail('INVALID_CANDLE', `Replay source candle ${index} must contain finite OHLCV values`);
  }
  if (candle.high < candle.low
    || candle.open < candle.low
    || candle.open > candle.high
    || candle.close < candle.low
    || candle.close > candle.high
    || candle.volume < 0) {
    fail('INVALID_CANDLE', `Replay source candle ${index} contains inconsistent OHLCV values`);
  }
}

function createCausalProjection(sourceCandle) {
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

class ReplayCandleEngine {
  constructor(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      fail('INVALID_INPUT', 'Replay candle adapter input must be an object');
    }

    const { timeframe, candles } = input;
    this.#timeframe = normalizeTimeframe(timeframe);

    if (!Array.isArray(candles)) {
      fail('INVALID_CANDLES', 'Replay candle source must be an array');
    }
    if (!Object.isFrozen(candles)) {
      fail('INVALID_CANDLES', 'Replay candle source array must be frozen');
    }

    let previousOpenTime = null;
    for (const candle of candles) {
      if (!candle || typeof candle !== 'object' || Array.isArray(candle) || !Object.isFrozen(candle)) {
        fail('INVALID_CANDLES', 'Replay source candles must be frozen objects');
      }
      if (!Number.isInteger(candle.openTime) || !Number.isFinite(candle.openTime)) {
        fail('INVALID_CANDLES', 'Replay source candle openTime must be an integer');
      }
      if (previousOpenTime !== null && candle.openTime <= previousOpenTime) {
        fail('INVALID_CANDLES', 'Replay source candles must be strictly chronological and unique');
      }
      previousOpenTime = candle.openTime;
    }

    this.#sourceCandles = candles;
    this.#cursor = -1;
    this.#active = null;
    this.#finalized = [];
    this.#boundaryMode = null;
    this.#completedCursor = -1;
    this.#activeSourceIndex = null;
    this.#boundaryRevision = 0;
    this.#lastBoundaryTime = null;
    this.#boundaryPlans = new WeakMap();
  }

  get timeframe() {
    return this.#timeframe;
  }

  hasNext() {
    const cursor = this.#boundaryMode === 'boundary'
      ? this.#completedCursor
      : this.#cursor;
    return cursor + 1 < this.#sourceCandles.length;
  }

  nextActive() {
    this.#assertLegacyProtocol();
    if (this.#active !== null) {
      fail('ACTIVE_CANDLE_PRESENT', 'Cannot activate a candle while another candle is active');
    }
    if (!this.hasNext()) {
      fail('NO_REMAINING_CANDLES', 'No remaining replay candles to activate');
    }

    this.#boundaryMode = 'legacy';
    this.#cursor += 1;
    this.#active = this.#sourceCandles[this.#cursor];
    return this.#active;
  }

  getActive(timeframe) {
    const requestedTimeframe = normalizeTimeframe(timeframe);
    if (requestedTimeframe !== this.timeframe) return null;
    return this.#active;
  }

  getCandles(timeframe, limit) {
    const requestedTimeframe = normalizeTimeframe(timeframe);
    if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
      fail('INVALID_LIMIT', 'Replay candle limit must be a positive integer');
    }
    if (requestedTimeframe !== this.timeframe) return [];

    return limit === undefined
      ? this.#finalized.slice()
      : this.#finalized.slice(-limit);
  }

  finalizeActive() {
    this.#assertLegacyProtocol();
    if (this.#active === null) {
      fail('NO_ACTIVE_CANDLE', 'Cannot finalize without an active candle');
    }

    this.#boundaryMode = 'legacy';
    const finalized = this.#active;
    this.#finalized.push(finalized);
    this.#active = null;
    return finalized;
  }

  prepareBoundary({ boundaryTime } = {}) {
    if (this.#boundaryMode === 'legacy') {
      fail('MIXED_PROTOCOL', 'Cannot prepare a boundary after legacy replay activation');
    }

    const expectedBoundaryTime = assertBoundaryTime(boundaryTime);
    const completedIndex = this.#completedCursor + 1;
    if (completedIndex >= this.#sourceCandles.length) {
      fail('NO_REMAINING_BOUNDARIES', 'No remaining replay boundaries to prepare');
    }

    const completedCandle = this.#sourceCandles[completedIndex];
    validateBoundaryCandle(completedCandle, completedIndex);
    const durationMs = sourceDurationMs(this.timeframe);
    const completedBoundaryTime = completedCandle.openTime + durationMs;
    if (!Number.isSafeInteger(completedBoundaryTime)
      || expectedBoundaryTime !== completedBoundaryTime) {
      fail('INVALID_BOUNDARY', `Boundary time does not close replay source candle ${completedIndex}`);
    }

    if (this.#activeSourceIndex !== null) {
      if (this.#activeSourceIndex !== completedIndex
        || this.#active === null
        || this.#active.openTime !== completedCandle.openTime
        || this.#active === completedCandle) {
        fail('ACTIVE_SOURCE_MISMATCH', `Active projection does not represent source candle ${completedIndex}`);
      }
    } else if (this.#active !== null) {
      fail('ACTIVE_SOURCE_MISMATCH', 'Replay active source association is invalid');
    }

    const nextSourceIndex = completedIndex + 1;
    const nextCandle = this.#sourceCandles[nextSourceIndex] || null;
    let nextActive = null;
    let nextActiveSourceIndex = null;
    if (nextCandle !== null) {
      validateBoundaryCandle(nextCandle, nextSourceIndex);
      if (nextCandle.openTime < expectedBoundaryTime) {
        fail('INVALID_SOURCE_ORDER', `Next replay source candle ${nextSourceIndex} begins before the boundary`);
      }
      if (nextCandle.openTime === expectedBoundaryTime) {
        nextActive = createCausalProjection(nextCandle);
        nextActiveSourceIndex = nextSourceIndex;
      }
    }

    const plan = Object.freeze({
      sourceIndex: completedIndex,
      lifecycleCandle: completedCandle,
      active: nextActive,
      boundaryTime: expectedBoundaryTime,
      revision: this.#boundaryRevision,
    });
    this.#boundaryPlans.set(plan, {
      expectedRevision: this.#boundaryRevision,
      expectedCompletedCursor: this.#completedCursor,
      expectedActiveSourceIndex: this.#activeSourceIndex,
      expectedActive: this.#active,
      completedCursor: completedIndex,
      activeSourceIndex: nextActiveSourceIndex,
      active: nextActive,
      finalized: [...this.#finalized, completedCandle],
      transition: Object.freeze({
        sourceIndex: completedIndex,
        lifecycleCandle: completedCandle,
        finalized: Object.freeze({ [this.timeframe]: completedCandle }),
        active: nextActive,
        boundaryTime: expectedBoundaryTime,
        revision: this.#boundaryRevision + 1,
      }),
    });
    this.#boundaryMode = 'boundary';
    return plan;
  }

  commitBoundary(plan) {
    if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
      fail('INVALID_PLAN', 'Replay boundary plan must be an authentic plan object');
    }

    const record = this.#boundaryPlans.get(plan);
    if (!record) {
      fail('INVALID_PLAN', 'Replay boundary plan was not created by this engine');
    }

    if (record.expectedRevision !== this.#boundaryRevision
      || record.expectedCompletedCursor !== this.#completedCursor
      || record.expectedActiveSourceIndex !== this.#activeSourceIndex
      || record.expectedActive !== this.#active) {
      fail('STALE_PLAN', 'Replay boundary plan does not match current engine state');
    }

    this.#finalized = record.finalized;
    this.#completedCursor = record.completedCursor;
    this.#activeSourceIndex = record.activeSourceIndex;
    this.#active = record.active;
    this.#lastBoundaryTime = plan.boundaryTime;
    this.#boundaryRevision += 1;
    this.#boundaryPlans.delete(plan);
    return record.transition;
  }

  getAllTimeframes() {
    return [this.timeframe];
  }

  #assertLegacyProtocol() {
    if (this.#boundaryMode === 'boundary') {
      fail('MIXED_PROTOCOL', 'Cannot use legacy replay activation after boundary protocol begins');
    }
  }

  #sourceCandles;
  #timeframe;
  #cursor;
  #active;
  #finalized;
  #boundaryMode;
  #completedCursor;
  #activeSourceIndex;
  #boundaryRevision;
  #lastBoundaryTime;
  #boundaryPlans;
}

module.exports = { ReplayCandleEngine, ReplayCandleError };
