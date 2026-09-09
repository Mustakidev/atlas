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
const { computeRawAtr } = require('./atrCore');
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

    const { atr, atrPercent, previousAtr } = computeRawAtr(finalized, this.period);

    const volatilityLevel = this._classifyVolatility(atrPercent);
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
      atrPercentage: this._round(atrPercent),
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
