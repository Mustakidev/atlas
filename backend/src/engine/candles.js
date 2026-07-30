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
  }

  ingest(snapshot) {
    const ts = new Date(snapshot.timestamp).getTime();
    const price = snapshot.price;
    const volume = snapshot.volume || 0;

    for (const [tf, durationSec] of Object.entries(TIMEFRAMES)) {
      const durationMs = durationSec * 1000;
      const bucketStart = Math.floor(ts / durationMs) * durationMs;
      const bucket = this.buckets[tf];

      if (bucket.active && bucket.active.openTime === bucketStart) {
        this._updateCandle(bucket.active, price, volume);
      } else {
        if (bucket.active) {
          this._finalizeCandle(bucket);
        }
        bucket.active = this._newCandle(bucketStart, price, volume);
      }
    }
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
    if (bucket.active) {
      result.push(bucket.active);
    }

    if (limit && limit > 0) {
      return result.slice(-limit);
    }
    return result;
  }

  getActive(timeframe) {
    const tf = timeframe.toLowerCase();
    const bucket = this.buckets[tf];
    return bucket ? bucket.active : null;
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

module.exports = { CandleEngine, TIMEFRAMES, sortHistoricalOhlcRows };
