/**
 * MACD Engine — Moving Average Convergence Divergence
 *
 * Production-quality MACD engine using CandleEngine data.
 *
 * Algorithm:
 *   1. Fast EMA (12) of close prices
 *   2. Slow EMA (26) of close prices
 *   3. MACD line = Fast EMA - Slow EMA
 *   4. Signal line = EMA(9) of MACD line
 *   5. Histogram = MACD - Signal
 *
 * Version: 1.0.0
 * Data Source: CandleEngine OHLCV candles (finalized only)
 * Asset: Configurable via symbol parameter (default: BTCUSDT)
 */
const ENGINE_VERSION = '1.0.0';
const DEFAULT_SYMBOL = 'BTCUSDT';
const DEFAULT_FAST_PERIOD = 12;
const DEFAULT_SLOW_PERIOD = 26;
const DEFAULT_SIGNAL_PERIOD = 9;
const MIN_CANDLES = 35;

class MACDEngine {
  constructor({ candleEngine, logger, symbol }) {
    this.candleEngine = candleEngine;
    this.logger = logger;
    this.symbol = symbol || DEFAULT_SYMBOL;
    this.fastPeriod = DEFAULT_FAST_PERIOD;
    this.slowPeriod = DEFAULT_SLOW_PERIOD;
    this.signalPeriod = DEFAULT_SIGNAL_PERIOD;
    this.version = ENGINE_VERSION;
    this.lastUpdated = null;
    this.calculationTime = 0;
    this.dataSource = 'CandleEngine OHLCV candles (finalized only)';

    this._cache = Object.create(null);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  calculate(timeframe, limit) {
    const start = Date.now();

    const allCandles = this.candleEngine.getCandles(timeframe, limit || 500);
    const active = this.candleEngine.getActive(timeframe);
    let finalized = allCandles;
    if (active && allCandles.length > 0 &&
        allCandles[allCandles.length - 1].openTime === active.openTime) {
      finalized = allCandles.slice(0, -1);
    }

    if (!finalized || finalized.length < MIN_CANDLES) {
      this.calculationTime = Date.now() - start;
      this.lastUpdated = new Date().toISOString();
      return this._notReady(timeframe, finalized ? finalized.length : 0);
    }

    const lastOpenTime = finalized[finalized.length - 1].openTime;

    if (this._cache[timeframe] && this._cache[timeframe].lastOpenTime === lastOpenTime) {
      this.calculationTime = Date.now() - start;
      return this._cache[timeframe].result;
    }

    const closes = new Array(finalized.length);
    for (let i = 0; i < finalized.length; i++) {
      closes[i] = finalized[i].close;
    }

    const fastEma = this._ema(closes, this.fastPeriod);
    const slowEma = this._ema(closes, this.slowPeriod);

    const macdLine = [];
    for (let i = 0; i < slowEma.length; i++) {
      macdLine.push(fastEma[i + (this.slowPeriod - this.fastPeriod)] - slowEma[i]);
    }

    const signalLine = this._ema(macdLine, this.signalPeriod);

    const histogram = [];
    for (let i = 0; i < signalLine.length; i++) {
      const macdIdx = i + (this.signalPeriod - 1);
      histogram.push(macdLine[macdIdx] - signalLine[i]);
    }

    const currentMacd = macdLine[macdLine.length - 1];
    const currentSignal = signalLine[signalLine.length - 1];
    const currentHistogram = histogram[histogram.length - 1];

    const trend = currentMacd > currentSignal ? 'Bullish' : 'Bearish';

    let crossover = 'None';
    if (macdLine.length >= 2 && signalLine.length >= 2) {
      const prevMacd = macdLine[macdLine.length - 2];
      const prevSignal = signalLine[signalLine.length - 2];
      if (prevMacd <= prevSignal && currentMacd > currentSignal) {
        crossover = 'Bullish';
      } else if (prevMacd >= prevSignal && currentMacd < currentSignal) {
        crossover = 'Bearish';
      }
    }

    this.calculationTime = Date.now() - start;
    this.lastUpdated = new Date().toISOString();

    const result = {
      implemented: true,
      ready: true,
      symbol: this.symbol,
      timeframe,
      macd: this._round(currentMacd),
      signal: this._round(currentSignal),
      histogram: this._round(currentHistogram),
      trend,
      crossover,
      candleCount: finalized.length,
      calculationTime: this.calculationTime,
      lastUpdated: this.lastUpdated,
      engineVersion: this.version,
      dataSource: this.dataSource,
    };

    this._cache[timeframe] = { lastOpenTime, result };
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
      name: 'MACD',
      description: 'Moving Average Convergence Divergence — trend-following momentum indicator',
      implemented: true,
      version: this.version,
      symbol: this.symbol,
      fastPeriod: this.fastPeriod,
      slowPeriod: this.slowPeriod,
      signalPeriod: this.signalPeriod,
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
  // Core EMA
  // ---------------------------------------------------------------------------

  _ema(closes, period) {
    if (closes.length < period) return [];

    let sum = 0;
    for (let i = 0; i < period; i++) {
      sum += closes[i];
    }
    let ema = sum / period;

    const result = new Array(closes.length - period + 1);
    result[0] = ema;

    const k = 2 / (period + 1);
    for (let i = period; i < closes.length; i++) {
      ema = closes[i] * k + ema * (1 - k);
      result[i - period + 1] = ema;
    }

    return result;
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
      macd: null,
      signal: null,
      histogram: null,
      trend: null,
      crossover: 'None',
      reason: `Insufficient candle data (${candleCount}/${MIN_CANDLES})`,
      candleCount,
      calculationTime: this.calculationTime,
      lastUpdated: this.lastUpdated,
      engineVersion: this.version,
      dataSource: this.dataSource,
    };
  }
}

module.exports = { MACDEngine, ENGINE_VERSION, DEFAULT_FAST_PERIOD, DEFAULT_SLOW_PERIOD, DEFAULT_SIGNAL_PERIOD, MIN_CANDLES, DEFAULT_SYMBOL };
