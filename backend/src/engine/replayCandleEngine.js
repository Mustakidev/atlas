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
  }

  get timeframe() {
    return this.#timeframe;
  }

  hasNext() {
    return this.#cursor + 1 < this.#sourceCandles.length;
  }

  nextActive() {
    if (this.#active !== null) {
      fail('ACTIVE_CANDLE_PRESENT', 'Cannot activate a candle while another candle is active');
    }
    if (!this.hasNext()) {
      fail('NO_REMAINING_CANDLES', 'No remaining replay candles to activate');
    }

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
    if (this.#active === null) {
      fail('NO_ACTIVE_CANDLE', 'Cannot finalize without an active candle');
    }

    const finalized = this.#active;
    this.#finalized.push(finalized);
    this.#active = null;
    return finalized;
  }

  getAllTimeframes() {
    return [this.timeframe];
  }

  #sourceCandles;
  #timeframe;
  #cursor;
  #active;
  #finalized;
}

module.exports = { ReplayCandleEngine, ReplayCandleError };
