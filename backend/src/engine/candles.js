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

module.exports = { CandleEngine, TIMEFRAMES };
