/**
 * ATR Engine — Average True Range (Wilder's)
 *
 * Production-quality ATR engine using CandleEngine data.
 *
 * Algorithm:
 *   1. True Range = max(high - low, |high - prevClose|, |low - prevClose|)
 *   2. First ATR = SMA of first `period` TR values
 *   3. Subsequent ATR = (prevATR * (period - 1) + currentTR) / period
 *
 * Version: 1.0.0
 * Data Source: CandleEngine OHLCV candles (finalized only)
 * Asset: Configurable via symbol parameter (default: BTCUSDT)
 */
const { getFinalizedCandles } = require('./candleUtils');
const ENGINE_VERSION = '1.0.0';
const DEFAULT_SYMBOL = 'BTCUSDT';
const DEFAULT_PERIOD = 14;
const MIN_CANDLES = DEFAULT_PERIOD + 1;

class ATREngine {
  #period;

  constructor({ candleEngine, logger, symbol, period = DEFAULT_PERIOD }) {
    this.#period = validatePeriod(period);
    this.candleEngine = candleEngine;
    this.logger = logger;
    this.symbol = symbol || DEFAULT_SYMBOL;
    this.version = ENGINE_VERSION;
    this.lastUpdated = null;
    this.calculationTime = 0;
    this.dataSource = 'CandleEngine OHLCV candles (finalized only)';

    // Retained as an empty compatibility surface for existing invalidate() callers.
    this._cache = Object.create(null);
  }

  get period() { return this.#period; }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  calculate(timeframe, limit) {
    const start = Date.now();

    const finalized = getFinalizedCandles(this.candleEngine, timeframe, limit);

    if (!finalized || finalized.length < this.period + 1) {
      this.calculationTime = Date.now() - start;
      this.lastUpdated = new Date().toISOString();
      return this._notReady(timeframe, finalized ? finalized.length : 0);
    }

    const trValues = this._trueRange(finalized);
    const atr = this._wilderATR(trValues);
    const lookback = Math.min(this.period, trValues.length - this.period);
    const previousAtr = lookback > 0
      ? this._wilderATR(trValues.slice(0, trValues.length - lookback))
      : atr;

    const lastClose = finalized[finalized.length - 1].close;
    const atrPercentage = lastClose > 0 ? (atr / lastClose) * 100 : 0;

    const volatilityLevel = this._classifyVolatility(atrPercentage);
    const volatilityTrend = this._trendVolatility(atr, previousAtr);

    this.calculationTime = Date.now() - start;
    this.lastUpdated = new Date().toISOString();

    const result = {
      implemented: true,
      ready: true,
      symbol: this.symbol,
      timeframe,
      period: this.period,
      atr: this._round(atr),
      atrPercentage: this._round(atrPercentage),
      volatilityLevel,
      volatilityTrend,
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
      name: 'ATR',
      description: 'Average True Range — Wilder\'s volatility indicator',
      implemented: true,
      version: this.version,
      symbol: this.symbol,
      period: this.period,
      minCandles: this.period + 1,
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

  _trueRange(candles) {
    const tr = new Array(candles.length);
    tr[0] = candles[0].high - candles[0].low;

    for (let i = 1; i < candles.length; i++) {
      const highLow = candles[i].high - candles[i].low;
      const highPrevClose = Math.abs(candles[i].high - candles[i - 1].close);
      const lowPrevClose = Math.abs(candles[i].low - candles[i - 1].close);
      tr[i] = Math.max(highLow, highPrevClose, lowPrevClose);
    }

    return tr;
  }

  _wilderATR(trValues) {
    if (trValues.length < this.period) return 0;

    let sum = 0;
    for (let i = 0; i < this.period; i++) {
      sum += trValues[i];
    }
    let atr = sum / this.period;

    for (let i = this.period; i < trValues.length; i++) {
      atr = (atr * (this.period - 1) + trValues[i]) / this.period;
    }

    return atr;
  }

  // ---------------------------------------------------------------------------
  // Classifications
  // ---------------------------------------------------------------------------

  _classifyVolatility(atrPercentage) {
    if (atrPercentage < 1) return 'Low';
    if (atrPercentage <= 3) return 'Medium';
    return 'High';
  }

  _trendVolatility(currentAtr, previousAtr) {
    if (previousAtr === 0) return 'Stable';
    const ratio = currentAtr / previousAtr;
    if (ratio > 1.05) return 'Increasing';
    if (ratio < 0.95) return 'Decreasing';
    return 'Stable';
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
      atr: null,
      atrPercentage: null,
      volatilityLevel: null,
      volatilityTrend: null,
      reason: `Insufficient candle data (${candleCount}/${this.period + 1})`,
      candleCount,
      calculationTime: this.calculationTime,
      lastUpdated: this.lastUpdated,
      engineVersion: this.version,
      dataSource: this.dataSource,
    };
  }
}

function validatePeriod(period) {
  if (!Number.isFinite(period) || !Number.isInteger(period) || period <= 0) {
    throw new TypeError('ATR period must be a finite positive integer');
  }
  return period;
}

module.exports = { ATREngine, ENGINE_VERSION, DEFAULT_PERIOD, MIN_CANDLES, DEFAULT_SYMBOL };
