/**
 * Bollinger Bands Engine
 *
 * Production-quality Bollinger Bands using CandleEngine data.
 *
 * Algorithm:
 *   1. Middle Band = SMA(close, period)
 *   2. Standard Deviation = StdDev(close, period) [population]
 *   3. Upper Band = Middle + (multiplier * StdDev)
 *   4. Lower Band = Middle - (multiplier * StdDev)
 *   5. Bandwidth = (Upper - Lower) / Middle
 *   6. Squeeze = bandwidth below historical minimum threshold
 *   7. Expansion = bandwidth increasing vs previous
 *
 * Version: 1.0.0
 * Data Source: CandleEngine OHLCV candles (finalized only)
 * Asset: Configurable via symbol parameter (default: BTCUSDT)
 */
const { getFinalizedCandles } = require('./candleUtils');
const ENGINE_VERSION = '1.0.0';
const DEFAULT_SYMBOL = 'BTCUSDT';
const DEFAULT_PERIOD = 20;
const DEFAULT_STD_DEV = 2;
const MIN_CANDLES = DEFAULT_PERIOD;
const SQUEEZE_PERCENTILE = 0.2;

class BollingerEngine {
  constructor({ candleEngine, logger, symbol }) {
    this.candleEngine = candleEngine;
    this.logger = logger;
    this.symbol = symbol || DEFAULT_SYMBOL;
    this.period = DEFAULT_PERIOD;
    this.stdDevMultiplier = DEFAULT_STD_DEV;
    this.version = ENGINE_VERSION;
    this.lastUpdated = null;
    this.calculationTime = 0;
    this.dataSource = 'CandleEngine OHLCV candles (finalized only)';

    // Retained as an empty compatibility surface for existing invalidate() callers.
    this._cache = Object.create(null);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  calculate(timeframe, limit) {
    const start = Date.now();

    const finalized = getFinalizedCandles(this.candleEngine, timeframe, limit);

    if (!finalized || finalized.length < MIN_CANDLES) {
      this.calculationTime = Date.now() - start;
      this.lastUpdated = new Date().toISOString();
      return this._notReady(timeframe, finalized ? finalized.length : 0);
    }

    const closes = new Array(finalized.length);
    for (let i = 0; i < finalized.length; i++) {
      closes[i] = finalized[i].close;
    }

    const { middle, upper, lower } = this._bands(closes);
    const bandwidth = middle !== 0 ? (upper - lower) / middle : 0;

    const lastClose = closes[closes.length - 1];
    const pricePosition = this._pricePosition(lastClose, upper, lower);

    const prevBandwidth = closes.length > this.period
      ? this._bandwidth(closes.slice(0, -1))
      : bandwidth;
    const squeeze = this._isSqueeze(closes, bandwidth);
    const expansion = bandwidth > prevBandwidth * 1.02;

    this.calculationTime = Date.now() - start;
    this.lastUpdated = new Date().toISOString();

    const result = {
      implemented: true,
      ready: true,
      symbol: this.symbol,
      timeframe,
      period: this.period,
      stdDevMultiplier: this.stdDevMultiplier,
      middleBand: this._round(middle),
      upperBand: this._round(upper),
      lowerBand: this._round(lower),
      bandwidth: this._round(bandwidth),
      pricePosition,
      squeeze,
      expansion,
      lastClose: this._round(lastClose),
      candleCount: finalized.length,
      calculationTime: this.calculationTime,
      lastUpdated: this.lastUpdated,
      engineVersion: this.version,
      dataSource: this.dataSource,
    };

    return result;
  }

  calculateAll(limit) {
    const results = {};
    const timeframes = this.candleEngine.getAllTimeframes();

    for (const tf of timeframes) {
      results[tf] = this.calculate(tf, limit);
    }

    return results;
  }

  getInfo() {
    return {
      name: 'Bollinger',
      description: 'Bollinger Bands — volatility envelope around price',
      implemented: true,
      version: this.version,
      symbol: this.symbol,
      period: this.period,
      stdDevMultiplier: this.stdDevMultiplier,
      minCandles: MIN_CANDLES,
    };
  }

  invalidate(timeframe) {
    if (timeframe) {
      delete this._cache[timeframe];
    } else {
      this._cache = Object.create(null);
    }
  }

  // ---------------------------------------------------------------------------
  // Core calculations
  // ---------------------------------------------------------------------------

  _bands(closes) {
    const slice = closes.slice(-this.period);
    const middle = this._sma(slice);
    const stdDev = this._stdDev(slice, middle);
    return {
      middle,
      upper: middle + this.stdDevMultiplier * stdDev,
      lower: middle - this.stdDevMultiplier * stdDev,
    };
  }

  _bandwidth(closes) {
    const { middle, upper, lower } = this._bands(closes);
    return middle !== 0 ? (upper - lower) / middle : 0;
  }

  _sma(values) {
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      sum += values[i];
    }
    return sum / values.length;
  }

  _stdDev(values, mean) {
    let sumSqDiff = 0;
    for (let i = 0; i < values.length; i++) {
      const diff = values[i] - mean;
      sumSqDiff += diff * diff;
    }
    return Math.sqrt(sumSqDiff / values.length);
  }

  // ---------------------------------------------------------------------------
  // Classifications
  // ---------------------------------------------------------------------------

  _pricePosition(close, upper, lower) {
    if (close > upper) return 'Above Upper';
    if (close < lower) return 'Below Lower';
    return 'Inside Bands';
  }

  _isSqueeze(closes, currentBandwidth) {
    if (closes.length < this.period * 2) return false;

    const recentBandwidths = [];
    for (let i = this.period; i <= closes.length; i++) {
      recentBandwidths.push(this._bandwidth(closes.slice(0, i)));
    }

    recentBandwidths.sort((a, b) => a - b);
    const thresholdIdx = Math.floor(recentBandwidths.length * SQUEEZE_PERCENTILE);
    const threshold = recentBandwidths[thresholdIdx];

    return currentBandwidth <= threshold;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  _round(value) {
    return Math.round(value * 100) / 100;
  }

  _notReady(timeframe, candleCount) {
    return {
      implemented: true,
      ready: false,
      symbol: this.symbol,
      timeframe,
      period: this.period,
      stdDevMultiplier: this.stdDevMultiplier,
      middleBand: null,
      upperBand: null,
      lowerBand: null,
      bandwidth: null,
      pricePosition: null,
      squeeze: null,
      expansion: null,
      lastClose: null,
      reason: `Insufficient candle data (${candleCount}/${MIN_CANDLES})`,
      candleCount,
      calculationTime: this.calculationTime,
      lastUpdated: this.lastUpdated,
      engineVersion: this.version,
      dataSource: this.dataSource,
    };
  }
}

module.exports = { BollingerEngine, ENGINE_VERSION, DEFAULT_PERIOD, DEFAULT_STD_DEV, MIN_CANDLES, DEFAULT_SYMBOL };
