const TIMEFRAMES = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '30m': 1800,
  '1h': 3600,
  '4h': 14400,
  '12h': 43200,
  '24h': 86400,
};

const MAX_CANDLES = 500;
const MIN_HISTORICAL_OPEN_TIME_MS = 100000000000;
const BAR_DURATION_MS = 60_000;

class CandleEngine {
  constructor(config, logger, symbol) {
    this.logger = logger;
    this.maxCandles = config.get('MAX_HISTORY') || MAX_CANDLES;
    this.symbol = symbol || 'BTCUSDT';

    this.buckets = {};
    for (const [tf] of Object.entries(TIMEFRAMES)) {
      this.buckets[tf] = {
        active: null,
        candles: [],
      };
    }
    this._lastBarOpenTime = null;
    this._formingBar = null;
  }

  /**
   * Legacy tick ingestion (price polling). Providers such as CoinGecko report a
   * rolling 24h volume per tick, which is not interval volume, so tick-built
   * candles carry zero volume rather than a misleading figure.
   */
  ingest(snapshot) {
    const ts = new Date(snapshot.timestamp).getTime();
    const price = snapshot.price;
    const volume = 0;
    const finalized = Object.fromEntries(
      Object.keys(TIMEFRAMES).map(tf => [tf, null]),
    );

    for (const [tf, durationSec] of Object.entries(TIMEFRAMES)) {
      const durationMs = durationSec * 1000;
      const bucketStart = Math.floor(ts / durationMs) * durationMs;
      const bucket = this.buckets[tf];

      if (bucket.active && bucket.active.openTime === bucketStart) {
        this._updateCandle(bucket.active, price, volume);
      } else {
        if (bucket.active) {
          const finalizedCandle = bucket.active;
          this._finalizeCandle(bucket);
          finalized[tf] = finalizedCandle;
        }
        bucket.active = this._newCandle(bucketStart, price, volume);
      }
    }

    return Object.freeze({ finalized: Object.freeze(finalized) });
  }

  /**
   * Ingests one closed exchange 1-minute bar and aggregates it exactly into every
   * timeframe. Bars at or before the last ingested bar are ignored, so callers can
   * safely re-deliver overlapping batches.
   */
  ingestBar(bar) {
    const normalized = this._validateHistoricalCandle(bar);
    if (normalized.openTime % BAR_DURATION_MS !== 0) {
      throw new TypeError('Exchange bar openTime must be aligned to one minute');
    }
    const finalized = Object.fromEntries(Object.keys(TIMEFRAMES).map(tf => [tf, null]));
    if (this._lastBarOpenTime !== null && normalized.openTime <= this._lastBarOpenTime) {
      return Object.freeze({ ingested: false, finalized: Object.freeze(finalized) });
    }

    for (const [tf, durationSec] of Object.entries(TIMEFRAMES)) {
      const durationMs = durationSec * 1000;
      const bucketStart = Math.floor(normalized.openTime / durationMs) * durationMs;
      const bucket = this.buckets[tf];
      if (bucket.active && bucket.active.openTime === bucketStart) {
        const active = bucket.active;
        if (normalized.high > active.high) active.high = normalized.high;
        if (normalized.low < active.low) active.low = normalized.low;
        active.close = normalized.close;
        active.volume += normalized.volume;
      } else {
        if (bucket.active) {
          finalized[tf] = bucket.active;
          this._finalizeCandle(bucket);
        }
        bucket.active = {
          open: normalized.open,
          high: normalized.high,
          low: normalized.low,
          close: normalized.close,
          volume: normalized.volume,
          openTime: bucketStart,
          timestamp: new Date(bucketStart).toISOString(),
        };
      }
    }

    // A one-minute bucket is complete as soon as its bar closes.
    const minute = this.buckets['1m'];
    if (minute.active && minute.active.openTime === normalized.openTime) {
      finalized['1m'] = minute.active;
      this._finalizeCandle(minute);
    }

    this._lastBarOpenTime = normalized.openTime;
    if (this._formingBar && this._formingBar.openTime <= normalized.openTime) this._formingBar = null;
    return Object.freeze({
      ingested: true,
      bar: Object.freeze({ ...normalized }),
      finalized: Object.freeze(finalized),
    });
  }

  /** Records the exchange bar still forming; it is shown in active candles but never finalized. */
  setFormingBar(bar) {
    if (bar === null || bar === undefined) {
      this._formingBar = null;
      return;
    }
    const normalized = this._validateHistoricalCandle(bar);
    if (this._lastBarOpenTime !== null && normalized.openTime <= this._lastBarOpenTime) return;
    this._formingBar = Object.freeze(normalized);
  }

  /**
   * Replaces a timeframe with exchange history. `forming` is the exchange candle
   * still open for that timeframe; for 1m it becomes the forming-bar overlay.
   */
  seedTimeframe(timeframe, closedCandles, forming = null) {
    const tf = String(timeframe || '').toLowerCase();
    if (!TIMEFRAMES[tf]) throw new TypeError(`Invalid seed timeframe: ${timeframe}`);
    if (!Array.isArray(closedCandles)) throw new TypeError('Seed candles must be an array');
    const durationMs = TIMEFRAMES[tf] * 1000;
    const normalized = closedCandles.map(candle => Object.freeze(this._validateHistoricalCandle(candle)));
    for (let index = 0; index < normalized.length; index++) {
      if (normalized[index].openTime % durationMs !== 0) {
        throw new TypeError(`Seed candle is not aligned to ${tf}`);
      }
      if (index > 0 && normalized[index].openTime <= normalized[index - 1].openTime) {
        throw new TypeError('Seed candles must be strictly chronological');
      }
    }
    const bucket = this.buckets[tf];
    bucket.candles = normalized.slice(-this.maxCandles);
    bucket.active = null;

    if (tf === '1m') {
      const last = normalized[normalized.length - 1];
      if (last) this._lastBarOpenTime = last.openTime;
      this.setFormingBar(forming);
    } else if (forming) {
      const active = this._validateHistoricalCandle(forming);
      if (active.openTime % durationMs !== 0) throw new TypeError(`Forming seed candle is not aligned to ${tf}`);
      bucket.active = { ...active };
    }
  }

  getLastBarOpenTime() {
    return this._lastBarOpenTime;
  }

  ingestHistoricalCandle(timeframe, candle) {
    const tf = String(timeframe || '').toLowerCase();
    if (!TIMEFRAMES[tf]) {
      throw new TypeError(`Invalid historical candle timeframe: ${timeframe}`);
    }

    const normalized = this._validateHistoricalCandle(candle);
    const bucket = this.buckets[tf];
    const finalized = Object.freeze(normalized);

    bucket.candles.push(finalized);
    if (bucket.candles.length > this.maxCandles) {
      bucket.candles.shift();
    }

    return finalized;
  }

  getCandles(timeframe, limit) {
    const tf = timeframe.toLowerCase();
    const bucket = this.buckets[tf];
    if (!bucket) return [];

    const result = [...bucket.candles];
    const active = this.getActive(tf);
    if (active) {
      result.push(active);
    }

    if (limit && limit > 0) {
      return result.slice(-limit);
    }
    return result;
  }

  getActive(timeframe) {
    const tf = timeframe.toLowerCase();
    const bucket = this.buckets[tf];
    if (!bucket) return null;
    const forming = this._formingBar;
    if (!forming) return bucket.active;

    const durationMs = TIMEFRAMES[tf] * 1000;
    const formingBucket = Math.floor(forming.openTime / durationMs) * durationMs;
    const base = bucket.active;
    if (base && base.openTime === formingBucket) {
      return {
        ...base,
        high: Math.max(base.high, forming.high),
        low: Math.min(base.low, forming.low),
        close: forming.close,
        volume: base.volume + forming.volume,
      };
    }
    if (!base) {
      return {
        open: forming.open,
        high: forming.high,
        low: forming.low,
        close: forming.close,
        volume: forming.volume,
        openTime: formingBucket,
        timestamp: new Date(formingBucket).toISOString(),
      };
    }
    return base;
  }

  getAllTimeframes() {
    return Object.keys(TIMEFRAMES);
  }

  getTotalCandles() {
    let total = 0;
    for (const bucket of Object.values(this.buckets)) {
      total += bucket.candles.length;
      if (bucket.active) total++;
    }
    return total;
  }

  _newCandle(openTime, price, volume) {
    return {
      open: price,
      high: price,
      low: price,
      close: price,
      volume: volume,
      openTime: openTime,
      timestamp: new Date(openTime).toISOString(),
    };
  }

  _validateHistoricalCandle(candle) {
    if (!candle || typeof candle !== 'object') {
      throw new TypeError('Historical candle must be an object');
    }

    const { open, high, low, close, volume } = candle;
    if (![open, high, low, close].every(Number.isFinite)) {
      throw new TypeError('Historical candle OHLC values must be finite');
    }
    if (high < low || open < low || open > high || close < low || close > high) {
      throw new TypeError('Historical candle OHLC values are inconsistent');
    }
    if (!Number.isFinite(volume) || volume < 0) {
      throw new TypeError('Historical candle volume must be finite and non-negative');
    }

    const hasOpenTime = candle.openTime !== undefined && candle.openTime !== null;
    if (hasOpenTime && !Number.isFinite(candle.openTime)) {
      throw new TypeError('Historical candle openTime must be finite');
    }
    if (hasOpenTime && !Number.isInteger(candle.openTime)) {
      throw new TypeError('Historical candle openTime must be an integer millisecond timestamp');
    }
    if (hasOpenTime && candle.openTime < MIN_HISTORICAL_OPEN_TIME_MS) {
      throw new TypeError('Historical candle openTime must be milliseconds, not seconds');
    }

    const hasTimestamp = candle.timestamp !== undefined && candle.timestamp !== null;
    if (hasTimestamp && typeof candle.timestamp !== 'string') {
      throw new TypeError('Historical candle timestamp must be a string');
    }
    const timestampMs = hasTimestamp ? new Date(candle.timestamp).getTime() : NaN;
    if (!hasOpenTime && !Number.isFinite(timestampMs)) {
      throw new TypeError('Historical candle requires a valid timestamp or openTime');
    }
    if (hasTimestamp && !Number.isFinite(timestampMs)) {
      throw new TypeError('Historical candle timestamp must be valid');
    }
    if (hasOpenTime && hasTimestamp && candle.openTime !== timestampMs) {
      throw new TypeError('Historical candle timestamp and openTime must match');
    }

    const openTime = hasOpenTime ? candle.openTime : timestampMs;
    if (!Number.isFinite(new Date(openTime).getTime())) {
      throw new TypeError('Historical candle time identity must be valid');
    }

    return {
      open,
      high,
      low,
      close,
      volume,
      openTime,
      timestamp: hasTimestamp ? candle.timestamp : new Date(openTime).toISOString(),
    };
  }

  _updateCandle(candle, price, volume) {
    if (price > candle.high) candle.high = price;
    if (price < candle.low) candle.low = price;
    candle.close = price;
    candle.volume += volume;
  }

  _finalizeCandle(bucket) {
    Object.freeze(bucket.active);
    bucket.candles.push(bucket.active);
    if (bucket.candles.length > this.maxCandles) {
      bucket.candles.shift();
    }
    bucket.active = null;
  }
}

function sortHistoricalOhlcRows(rows) {
  if (!Array.isArray(rows)) {
    throw new TypeError('Historical OHLC response must be an array');
  }

  return rows
    .map((row, index) => {
      if (!Array.isArray(row)) {
        throw new TypeError('Historical OHLC row must be an array');
      }

      const rawTimestamp = row[0];
      if (typeof rawTimestamp !== 'number' && typeof rawTimestamp !== 'string') {
        throw new TypeError('Historical OHLC timestamp must be numeric');
      }
      if (typeof rawTimestamp === 'string' && rawTimestamp.trim() === '') {
        throw new TypeError('Historical OHLC timestamp must be numeric');
      }

      const timestamp = Number(rawTimestamp);
      if (typeof rawTimestamp === 'string' && Number.isNaN(timestamp)) {
        throw new TypeError('Historical OHLC timestamp must be numeric');
      }
      if (!Number.isFinite(timestamp)) {
        throw new TypeError('Historical OHLC timestamp must be finite');
      }
      if (!Number.isInteger(timestamp)) {
        throw new TypeError('Historical OHLC timestamp must be an integer millisecond timestamp');
      }
      if (timestamp < MIN_HISTORICAL_OPEN_TIME_MS) {
        throw new TypeError('Historical OHLC timestamp must be milliseconds, not seconds');
      }

      return { row: [timestamp, ...row.slice(1)], index, timestamp };
    })
    .sort((left, right) => left.timestamp - right.timestamp || left.index - right.index)
    .map(({ row }) => row);
}

module.exports = { BAR_DURATION_MS, CandleEngine, TIMEFRAMES, sortHistoricalOhlcRows };
