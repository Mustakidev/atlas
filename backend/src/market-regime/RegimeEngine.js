const { getFinalizedCandles } = require('../engine/candleUtils');
const { REGIMES, REGIME_THRESHOLDS } = require('./RegimeTypes');
const { TrendStrength } = require('./TrendStrength');
const { RangeDetector } = require('./RangeDetector');
const { VolatilityClassifier } = require('./VolatilityClassifier');

const ENGINE_VERSION = '1.0.0';
const DEFAULT_SYMBOL = 'BTCUSDT';
const MIN_CANDLES = 30;

class RegimeEngine {
  constructor({ indicatorRegistry, atrEngine, candleEngine, analyzer, logger, config, symbol }) {
    this.indicatorRegistry = indicatorRegistry;
    this.atrEngine = atrEngine;
    this.candleEngine = candleEngine;
    this.analyzer = analyzer;
    this.logger = logger;
    this.config = config;
    this.symbol = symbol || DEFAULT_SYMBOL;
    this.version = ENGINE_VERSION;
    this.lastUpdated = null;
    this.calculationTime = 0;
    this.dataSource = 'TrendStrength + RangeDetector + VolatilityClassifier (consumed only)';

    this.trendStrength = new TrendStrength({ indicatorRegistry, logger, symbol });
    this.rangeDetector = new RangeDetector({ atrEngine, indicatorRegistry, candleEngine, logger, symbol });
    this.volatilityClassifier = new VolatilityClassifier({ atrEngine, logger, symbol });
  }

  calculate(candles, tf) {
    const start = Date.now();

    if (!candles || candles.length < MIN_CANDLES) {
      this.calculationTime = Date.now() - start;
      this.lastUpdated = new Date().toISOString();
      return this._notReady(candles ? candles.length : 0, tf);
    }

    const analysis = this.analyzer ? this.analyzer.getAnalysis() : null;

    const trendResult = this.trendStrength.evaluate(candles, tf, analysis);
    const rangeResult = this.rangeDetector.evaluate(candles, tf, analysis);
    const volResult = this.volatilityClassifier.evaluate(candles, tf);

    const decision = this._decide(trendResult, rangeResult, volResult);

    this.calculationTime = Date.now() - start;
    this.lastUpdated = new Date().toISOString();

    return {
      timeframe: tf,
      candleCount: candles.length,
      regime: decision.regime,
      confidence: decision.confidence,
      trendScore: trendResult.score,
      rangeScore: rangeResult.confidence,
      volatility: volResult.level,
      volatilityScore: volResult.score,
      trendReason: trendResult.reason,
      rangeReason: rangeResult.confidence !== null
        ? (rangeResult.confidence >= REGIME_THRESHOLDS.RANGE_CONFIDENCE_MIN ? 'Market is ranging' : 'Market is directional')
        : 'Insufficient data',
      volReason: volResult.reason,
      decisionReason: decision.reason,
      components: {
        trend: trendResult,
        range: rangeResult,
        volatility: volResult,
      },
      timestamp: candles[candles.length - 1].timestamp,
      calculatedAt: new Date().toISOString(),
      engineVersion: this.version,
      lastUpdated: this.lastUpdated,
      calculationTime: this.calculationTime,
      dataSource: this.dataSource,
    };
  }

  calculateAll(limit) {
    const results = {};
    const timeframes = this.candleEngine ? this.candleEngine.getAllTimeframes() : [];

    for (const tf of timeframes) {
      const finalized = getFinalizedCandles(this.candleEngine, tf, limit);
      results[tf] = this.calculate(finalized, tf);
    }

    return results;
  }

  _decide(trendResult, rangeResult, volResult) {
    const trendScore = trendResult.score;
    const rangeConf = rangeResult.confidence;
    const volLevel = volResult.level;
    const volScore = volResult.score;

    if (trendScore === null && rangeConf === null && volLevel === null) {
      return { regime: REGIMES.UNKNOWN, confidence: 0, reason: 'All components returned null — insufficient data' };
    }

    if (trendScore !== null && rangeConf !== null) {
      if (rangeConf >= REGIME_THRESHOLDS.RANGE_CONFIDENCE_MIN && trendScore > 35 && trendScore < 65) {
        return {
          regime: REGIMES.RANGING,
          confidence: rangeConf,
          reason: `Market is ranging (range confidence: ${rangeConf}%)`,
        };
      }

      if (trendScore >= REGIME_THRESHOLDS.TREND_BULL_MIN_SCORE) {
        return {
          regime: REGIMES.TRENDING_BULL,
          confidence: trendScore,
          reason: `Strong bullish trend detected (trend score: ${trendScore})`,
        };
      }

      if (trendScore <= REGIME_THRESHOLDS.TREND_BEAR_MAX_SCORE) {
        return {
          regime: REGIMES.TRENDING_BEAR,
          confidence: 100 - trendScore,
          reason: `Strong bearish trend detected (trend score: ${trendScore})`,
        };
      }
    }

    if (volLevel === 'HIGH' && volScore !== null && volScore > 65) {
      return {
        regime: REGIMES.HIGH_VOLATILITY,
        confidence: volScore,
        reason: `Elevated volatility detected (ATR: ${volResult.atrPercentage?.toFixed(2) || '?'}%)`,
      };
    }

    if (volLevel === 'LOW' && volScore !== null && volScore < 35) {
      return {
        regime: REGIMES.LOW_VOLATILITY,
        confidence: 100 - volScore,
        reason: `Suppressed volatility detected (ATR: ${volResult.atrPercentage?.toFixed(2) || '?'}%)`,
      };
    }

    if (trendScore !== null) {
      if (trendScore >= 55) {
        return { regime: REGIMES.TRENDING_BULL, confidence: trendScore, reason: `Moderate bullish trend (score: ${trendScore})` };
      }
      if (trendScore <= 45) {
        return { regime: REGIMES.TRENDING_BEAR, confidence: 100 - trendScore, reason: `Moderate bearish trend (score: ${trendScore})` };
      }
      return { regime: REGIMES.RANGING, confidence: 100 - Math.abs(trendScore - 50) * 2, reason: `No clear trend (score: ${trendScore})` };
    }

    if (rangeConf !== null) {
      if (rangeConf >= 50) {
        return { regime: REGIMES.RANGING, confidence: rangeConf, reason: `Range indicators suggest sideways (conf: ${rangeConf})` };
      }
    }

    return { regime: REGIMES.UNKNOWN, confidence: 0, reason: 'Unable to determine regime from available data' };
  }

  getInfo() {
    return {
      name: 'MarketRegime',
      description: 'Market Regime Detection Engine — classifies market before trading signal evaluation',
      implemented: true,
      version: this.version,
      symbol: this.symbol,
      minCandles: MIN_CANDLES,
    };
  }

  _notReady(candleCount, tf) {
    return {
      timeframe: tf,
      candleCount,
      regime: REGIMES.UNKNOWN,
      confidence: 0,
      trendScore: null,
      rangeScore: null,
      volatility: null,
      volatilityScore: null,
      trendReason: null,
      rangeReason: null,
      volReason: null,
      decisionReason: `Insufficient candle data (${candleCount}/${MIN_CANDLES})`,
      components: {},
      timestamp: null,
      calculatedAt: new Date().toISOString(),
      engineVersion: this.version,
      lastUpdated: this.lastUpdated,
      calculationTime: this.calculationTime,
      dataSource: this.dataSource,
    };
  }
}

module.exports = { RegimeEngine, ENGINE_VERSION, MIN_CANDLES };
