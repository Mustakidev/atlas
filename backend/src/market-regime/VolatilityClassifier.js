const { REGIMES, REGIME_THRESHOLDS } = require('./RegimeTypes');

const ENGINE_VERSION = '1.0.0';
const DEFAULT_SYMBOL = 'BTCUSDT';

class VolatilityClassifier {
  constructor({ atrEngine, logger, symbol }) {
    this.atrEngine = atrEngine;
    this.logger = logger;
    this.symbol = symbol || DEFAULT_SYMBOL;
    this.version = ENGINE_VERSION;
    this.lastUpdated = null;
    this.calculationTime = 0;
    this.dataSource = 'ATREngine (consumed only)';
  }

  evaluate(candles, tf) {
    const start = Date.now();

    if (!this.atrEngine) {
      this.calculationTime = Date.now() - start;
      this.lastUpdated = new Date().toISOString();
      return { level: null, score: null, reason: 'ATR engine not available', details: {} };
    }

    const atrResult = this.atrEngine.calculate(tf, 200);
    if (!atrResult || !atrResult.ready) {
      this.calculationTime = Date.now() - start;
      this.lastUpdated = new Date().toISOString();
      return { level: null, score: null, reason: 'ATR not ready', details: {} };
    }

    const currentAtrPct = atrResult.atrPercentage;
    const volatilityTrend = atrResult.volatilityTrend;

    const atrValues = [];
    if (candles && candles.length >= 15) {
      for (let i = 1; i < candles.length; i++) {
        const highLow = candles[i].high - candles[i].low;
        const highPc = Math.abs(candles[i].high - candles[i - 1].close);
        const lowPc = Math.abs(candles[i].low - candles[i - 1].close);
        const tr = Math.max(highLow, highPc, lowPc);
        const atrPct = candles[i].close > 0 ? (tr / candles[i].close) * 100 : 0;
        atrValues.push(atrPct);
      }
    }

    let level, score;
    if (currentAtrPct >= REGIME_THRESHOLDS.HIGH_VOL_ATR_PCT) {
      level = 'HIGH';
      score = Math.min(100, 65 + Math.round((currentAtrPct - REGIME_THRESHOLDS.HIGH_VOL_ATR_PCT) * 10));
    } else if (currentAtrPct <= REGIME_THRESHOLDS.LOW_VOL_ATR_PCT) {
      level = 'LOW';
      score = Math.max(0, 35 - Math.round((REGIME_THRESHOLDS.LOW_VOL_ATR_PCT - currentAtrPct) * 10));
    } else {
      level = 'NORMAL';
      score = 50;
    }

    const volatilityScore = currentAtrPct >= REGIME_THRESHOLDS.HIGH_VOL_ATR_PCT
      ? Math.min(100, 60 + (currentAtrPct / REGIME_THRESHOLDS.HIGH_VOL_ATR_PCT) * 20)
      : currentAtrPct <= REGIME_THRESHOLDS.LOW_VOL_ATR_PCT
        ? Math.max(0, 40 - (REGIME_THRESHOLDS.LOW_VOL_ATR_PCT / Math.max(currentAtrPct, 0.1)) * 20)
        : 50;

    this.calculationTime = Date.now() - start;
    this.lastUpdated = new Date().toISOString();

    return {
      level,
      score: Math.round(volatilityScore),
      atrPercentage: currentAtrPct,
      trend: volatilityTrend,
      reason: `ATR=${currentAtrPct.toFixed(2)}% → ${level} volatility`,
      details: { currentAtrPct, volatilityTrend },
    };
  }

  getInfo() {
    return {
      name: 'VolatilityClassifier',
      description: 'Classifies market volatility using ATR compared to recent averages',
      implemented: true,
      version: this.version,
      symbol: this.symbol,
    };
  }
}

module.exports = { VolatilityClassifier, ENGINE_VERSION };
