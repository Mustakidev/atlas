/**
 * RSI Indicator — Wilder's Smoothed RSI (14-period)
 *
 * Mathematically correct implementation of Welles Wilder's RSI.
 * Uses only candle close prices from historical data.
 *
 * Formula:
 *   RS  = Average Gain / Average Loss
 *   RSI = 100 - (100 / (1 + RS))
 *
 * First average: SMA over `period` values.
 * Subsequent:    Wilder's smoothing — (prev * (period-1) + current) / period.
 *
 * Results are calculated from the supplied candle array on every call.
 */
const { Indicator } = require('./base');

const RSI_PERIOD = 14;
const MIN_CANDLES = RSI_PERIOD + 1; // need period+1 closes for first delta

class RSIIndicator extends Indicator {
  constructor(symbol) {
    super('RSI', 'Relative Strength Index — Wilder\'s smoothed 14-period momentum oscillator');
    this._implemented = true;
    this._period = RSI_PERIOD;
    this._symbol = symbol || 'BTCUSDT';

    // Retained as an empty compatibility surface for existing invalidate() callers.
    this._cache = Object.create(null);
  }

  /**
   * Calculate RSI from candle history.
   *
   * @param {Array} candles  - OHLCV objects sorted ascending by openTime
   * @param {string} [tf]    - Timeframe key (e.g. '1h')
   * @returns {Object}       - Structured RSI result
   */
  calculate(candles, tf) {
    // --- guard: no data ---
    if (!candles || candles.length === 0) {
      return this._notReady('No candle data');
    }

    // --- guard: insufficient data ---
    if (candles.length < MIN_CANDLES) {
      return this._notReady('Insufficient candle history');
    }

    const last = candles[candles.length - 1];

    // --- extract close prices ---
    const closes = new Array(candles.length);
    for (let i = 0; i < candles.length; i++) {
      closes[i] = candles[i].close;
    }

    // --- compute RSI ---
    const rsi = this._wilderRSI(closes);
    const result = this._buildResult(rsi, last);

    return result;
  }

  // ---------------------------------------------------------------------------
  // Wilder's RSI core
  // ---------------------------------------------------------------------------

  /**
   * Compute Wilder's smoothed RSI from an array of close prices.
   * @param {number[]} closes - ascending-time close prices
   * @returns {number} RSI value 0–100
   */
  _wilderRSI(closes) {
    const period = this._period;

    // --- deltas (price changes) ---
    const deltas = new Array(closes.length - 1);
    for (let i = 1; i < closes.length; i++) {
      deltas[i - 1] = closes[i] - closes[i - 1];
    }

    // --- separate gains and losses ---
    const gains = new Array(deltas.length);
    const losses = new Array(deltas.length);
    for (let i = 0; i < deltas.length; i++) {
      gains[i] = deltas[i] > 0 ? deltas[i] : 0;
      losses[i] = deltas[i] < 0 ? -deltas[i] : 0;
    }

    // --- first average: simple mean over first `period` values ---
    let avgGain = 0;
    let avgLoss = 0;
    for (let i = 0; i < period; i++) {
      avgGain += gains[i];
      avgLoss += losses[i];
    }
    avgGain /= period;
    avgLoss /= period;

    // --- Wilder's smoothing for remaining deltas ---
    for (let i = period; i < gains.length; i++) {
      avgGain = (avgGain * (period - 1) + gains[i]) / period;
      avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    }

    // --- RS and RSI ---
    if (avgLoss === 0) {
      return avgGain === 0 ? 50 : 100;  // no movement → neutral; all up → 100
    }
    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
  }

  // ---------------------------------------------------------------------------
  // Result builders
  // ---------------------------------------------------------------------------

  _buildResult(rsiValue, lastCandle) {
    const rounded = Math.round(rsiValue * 100) / 100;
    const state = this._classify(rounded);

    return {
      implemented: true,
      ready: true,
      symbol: this._symbol,
      value: rounded,
      period: this._period,
      state: state.state,
      signal: state.signal,
      strength: this._strength(rounded),
      confidence: this._confidence(0), // overridden by route with candle count
      timestamp: lastCandle.timestamp || new Date(lastCandle.openTime).toISOString(),
    };
  }

  _notReady(reason) {
    return {
      implemented: true,
      ready: false,
      reason: reason,
      symbol: this._symbol,
      value: null,
      period: this._period,
      state: null,
      signal: null,
      strength: null,
      confidence: null,
      timestamp: null,
    };
  }

  /**
   * Classify RSI into state + signal.
   *   > 70  → Overbought / Possible Pullback
   *   < 30  → Oversold   / Possible Reversal
   *   else  → Neutral    / Hold
   */
  _classify(rsi) {
    if (rsi > 70) {
      return { state: 'Overbought', signal: 'Possible Pullback' };
    }
    if (rsi < 30) {
      return { state: 'Oversold', signal: 'Possible Reversal' };
    }
    return { state: 'Neutral', signal: 'Hold' };
  }

  /**
   * Strength: distance from neutral zone (50) mapped to 0–100.
   *   RSI 50 → strength 0
   *   RSI 70 or 30 → strength ~40
   *   RSI 100 or 0 → strength 100
   */
  _strength(rsi) {
    return Math.round(Math.abs(rsi - 50) * 2);
  }

  /**
   * Confidence: based on how much candle data is available beyond the minimum.
   *   At MIN_CANDLES → ~50%
   *   At 200 candles  → ~95%
   *   At 300+         → 100%
   */
  _confidence(candleCount) {
    if (candleCount <= MIN_CANDLES) return 50;
    const excess = candleCount - MIN_CANDLES;
    return Math.min(100, Math.round(50 + excess * 0.3));
  }

  // ---------------------------------------------------------------------------
  // Compatibility
  // ---------------------------------------------------------------------------

  /** Clear cache for a specific timeframe or all. */
  invalidate(tf) {
    if (tf) {
      delete this._cache[tf];
    } else {
      this._cache = Object.create(null);
    }
  }

  /**
   * Override getInfo to add RSI-specific metadata.
   */
  getInfo() {
    return {
      ...super.getInfo(),
      period: this._period,
      minCandles: MIN_CANDLES,
      symbol: this._symbol,
    };
  }
}

module.exports = { RSIIndicator, RSI_PERIOD, MIN_CANDLES };
