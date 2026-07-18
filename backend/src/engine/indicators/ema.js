/**
 * EMA Indicator — Production Exponential Moving Average
 *
 * Multi-period EMA engine supporting 9, 20, 50, 100, 200 periods.
 * Calculates from historical candle close prices only.
 *
 * Algorithm:
 *   1. Seed = SMA of first `period` closes
 *   2. Multiplier k = 2 / (period + 1)
 *   3. EMA[i] = close[i] * k + EMA[i-1] * (1 - k)
 *
 * Version: 1.0.0
 * Data Source: CandleEngine OHLCV candles (finalized only)
 * Asset: Configurable via symbol parameter (default: BTCUSDT)
 */
const { Indicator } = require('./base');

const DEFAULT_PERIODS = [9, 20, 50, 100, 200];
const ENGINE_VERSION = '1.0.0';
const DEFAULT_SYMBOL = 'BTCUSDT';

class EMAIndicator extends Indicator {
  constructor(symbol) {
    super('EMA', 'Exponential Moving Average — multi-period exponential smoothing with configurable periods');
    this._implemented = true;
    this._symbol = symbol || DEFAULT_SYMBOL;
    this._periods = DEFAULT_PERIODS;
    this._version = ENGINE_VERSION;
    this._lastUpdated = null;
    this._calculationTime = 0;
    this._dataSource = 'CandleEngine OHLCV candles (finalized only)';

    // Cache: { [tf]: { [period]: { lastOpenTime, result } } }
    this._cache = Object.create(null);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Calculate EMA for a single period.
   * @param {Array} candles - OHLCV objects (ascending time, finalized only)
   * @param {string} tf - Timeframe key (e.g. '1h')
   * @param {number} period - EMA period (e.g. 20)
   * @returns {Object} EMA result
   */
  calculate(candles, tf, period) {
    const start = Date.now();
    const p = period || 20;
    const timestamp = candles && candles.length > 0
      ? candles[candles.length - 1].timestamp
      : null;

    // --- guard: no data ---
    if (!candles || candles.length === 0) {
      this._calculationTime = Date.now() - start;
      this._lastUpdated = new Date().toISOString();
      return this._notReady('No candle data', tf, p, 0, timestamp);
    }

    const lastOpenTime = candles[candles.length - 1].openTime;

    // --- cache hit ---
    if (tf && this._cache[tf] && this._cache[tf][p] &&
        this._cache[tf][p].lastOpenTime === lastOpenTime) {
      this._calculationTime = Date.now() - start;
      return this._cache[tf][p].result;
    }

    // --- guard: insufficient data ---
    const minCandles = p + 1;
    if (candles.length < minCandles) {
      const result = this._notReady(
        `Insufficient candle data (${candles.length}/${minCandles})`,
        tf, p, candles.length, timestamp
      );
      this._storeResult(tf, p, lastOpenTime, result);
      this._calculationTime = Date.now() - start;
      this._lastUpdated = new Date().toISOString();
      return result;
    }

    // --- extract close prices ---
    const closes = new Array(candles.length);
    for (let i = 0; i < candles.length; i++) {
      closes[i] = candles[i].close;
    }

    // --- compute current EMA ---
    const emaValue = this._ema(closes, p);

    // --- compute previous EMA (for crossing detection) ---
    const prevCloses = closes.slice(0, -1);
    const prevEma = this._ema(prevCloses, p);

    // --- classify trend ---
    const lastClose = closes[closes.length - 1];
    const prevClose = closes[closes.length - 2];
    const trend = this._trend(lastClose, emaValue, prevClose, prevEma);

    // --- build result ---
    const result = this._buildResult(emaValue, trend, candles.length, p, tf, timestamp);

    this._storeResult(tf, p, lastOpenTime, result);
    this._calculationTime = Date.now() - start;
    this._lastUpdated = new Date().toISOString();

    return result;
  }

  /**
   * Calculate EMA for all default periods.
   * @param {Array} candles - OHLCV objects
   * @param {string} tf - Timeframe key
   * @returns {Object} { [period]: result }
   */
  calculateAll(candles, tf) {
    const results = {};
    for (const period of this._periods) {
      results[period] = this.calculate(candles, tf, period);
    }
    return results;
  }

  /**
   * Get the list of default periods.
   * @returns {number[]}
   */
  getPeriods() {
    return [...this._periods];
  }

  /**
   * Clear cache for a timeframe or all.
   * @param {string} [tf] - Timeframe to clear, or all if omitted
   */
  invalidate(tf) {
    if (tf) {
      delete this._cache[tf];
    } else {
      this._cache = Object.create(null);
    }
  }

  /**
   * Override getInfo with EMA-specific metadata.
   */
  getInfo() {
    return {
      ...super.getInfo(),
      periods: this._periods,
      minCandles: Math.max(...this._periods) + 1,
      version: this._version,
      symbol: this._symbol,
    };
  }

  // ---------------------------------------------------------------------------
  // Core EMA calculation
  // ---------------------------------------------------------------------------

  /**
   * Compute EMA from an array of close prices for a given period.
   * @param {number[]} closes - ascending-time close prices
   * @param {number} period - EMA period
   * @returns {number} EMA value (rounded to 2 decimals)
   */
  _ema(closes, period) {
    if (closes.length < period) return null;

    // Step 1: SMA seed (average of first `period` closes)
    let sum = 0;
    for (let i = 0; i < period; i++) {
      sum += closes[i];
    }
    let ema = sum / period;

    // Step 2: EMA smoothing
    const k = 2 / (period + 1);
    for (let i = period; i < closes.length; i++) {
      ema = closes[i] * k + ema * (1 - k);
    }

    return Math.round(ema * 100) / 100;
  }

  // ---------------------------------------------------------------------------
  // Trend classification
  // ---------------------------------------------------------------------------

  /**
   * Classify price position relative to EMA.
   * @returns {'Above'|'Below'|'Crossing'}
   */
  _trend(currentClose, emaValue, previousClose, previousEma) {
    if (emaValue === null || previousEma === null) return 'Above';

    const wasAbove = previousClose > previousEma;
    const isAbove = currentClose > emaValue;
    const wasBelow = previousClose < previousEma;
    const isBelow = currentClose < emaValue;

    // Crossing: price crossed EMA in the last candle
    if ((wasAbove && isBelow) || (wasBelow && isAbove)) return 'Crossing';

    if (isAbove) return 'Above';
    if (isBelow) return 'Below';
    return 'Above'; // touching EMA from above
  }

  // ---------------------------------------------------------------------------
  // Result builders
  // ---------------------------------------------------------------------------

  _buildResult(emaValue, trend, candleCount, period, tf, timestamp) {
    const lastClose = null; // not needed here, trend already computed

    return {
      implemented: true,
      ready: true,
      symbol: this._symbol,
      timeframe: tf || null,
      period,
      value: emaValue,
      trend,
      candleCount,
      calculationTime: this._calculationTime,
      lastUpdated: this._lastUpdated || new Date().toISOString(),
      engineVersion: this._version,
      dataSource: this._dataSource,
      timestamp,
    };
  }

  _notReady(reason, tf, period, candleCount, timestamp) {
    return {
      implemented: true,
      ready: false,
      reason,
      symbol: this._symbol,
      timeframe: tf || null,
      period,
      value: null,
      trend: null,
      candleCount,
      calculationTime: this._calculationTime,
      lastUpdated: this._lastUpdated || new Date().toISOString(),
      engineVersion: this._version,
      dataSource: this._dataSource,
      timestamp,
    };
  }

  // ---------------------------------------------------------------------------
  // Cache
  // ---------------------------------------------------------------------------

  _storeResult(tf, period, lastOpenTime, result) {
    if (!tf) return;
    if (!this._cache[tf]) this._cache[tf] = Object.create(null);
    this._cache[tf][period] = { lastOpenTime, result };
  }
}

module.exports = { EMAIndicator, DEFAULT_PERIODS, ENGINE_VERSION, DEFAULT_SYMBOL };
