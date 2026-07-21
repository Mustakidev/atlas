/**
 * Multi-Timeframe Analysis Engine
 *
 * Consumes outputs from Trend, Structure, RSI, EMA, and Confluence engines
 * across all supported timeframes. Produces a unified market assessment.
 *
 * Never modifies existing engines. Only reads their outputs.
 *
 * Version: 1.0.0
 * Data Source: ConfluenceEngine + StructureEngine + IndicatorRegistry + CandleEngine
 * Asset: Configurable via symbol parameter (default: BTCUSDT)
 */
const { getFinalizedCandles } = require('./candleUtils');
const ENGINE_VERSION = '1.0.0';
const DEFAULT_SYMBOL = 'BTCUSDT';

// Higher timeframes carry more weight (longer-term trends dominate)
const TF_WEIGHTS = {
  '1m': 0.3,
  '5m': 0.4,
  '15m': 0.5,
  '30m': 0.6,
  '1h': 0.7,
  '4h': 0.8,
  '12h': 0.9,
  '24h': 1.0,
};

const ALL_TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '4h', '12h', '24h'];

class MTFEngine {
  constructor({ confluenceEngine, structureEngine, indicatorRegistry, candleEngine, analyzer, logger, config, symbol }) {
    this.confluenceEngine = confluenceEngine;
    this.structureEngine = structureEngine;
    this.indicatorRegistry = indicatorRegistry;
    this.candleEngine = candleEngine;
    this.analyzer = analyzer;
    this.logger = logger;
    this.config = config;
    this.version = ENGINE_VERSION;
    this.lastUpdated = null;
    this.calculationTime = 0;
    this.dataSource = 'ConfluenceEngine + StructureEngine + IndicatorRegistry + CandleEngine';
    this._symbol = symbol || config?.get('SYMBOL') || DEFAULT_SYMBOL;
    this._cache = null;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  calculate(limit) {
    const start = Date.now();
    const timeframeResults = {};
    const availableTimeframes = [];

    // Step 1: Collect per-timeframe data
    for (const tf of ALL_TIMEFRAMES) {
      const finalized = getFinalizedCandles(this.candleEngine, tf, limit);

      if (finalized.length < 15) {
        timeframeResults[tf] = this._emptyTimeframe(tf);
        continue;
      }

      const confluence = this.confluenceEngine.calculate(finalized, tf);
      const structure = this.structureEngine.calculate(finalized);

      let rsi = { ready: false };
      const rsiIndicator = this.indicatorRegistry.get('RSI');
      if (rsiIndicator) {
        rsi = rsiIndicator.calculate(finalized, tf);
      }

      let ema = { ready: false };
      const emaIndicator = this.indicatorRegistry.get('EMA');
      if (emaIndicator) {
        ema = emaIndicator.calculate(finalized, tf, 20);
      }

      timeframeResults[tf] = {
        confluence: {
          score: confluence.score,
          bias: confluence.bias,
          confidence: confluence.confidence,
        },
        structure: {
          direction: structure.ready ? structure.direction : null,
          score: structure.ready ? structure.score : null,
        },
        rsi: {
          value: rsi.ready ? rsi.value : null,
          state: rsi.ready ? rsi.state : null,
        },
        ema: {
          value: ema.ready ? ema.value : null,
          trend: ema.ready ? ema.trend : null,
        },
        candleCount: finalized.length,
      };

      availableTimeframes.push(tf);
    }

    // Step 2: Aggregate across timeframes
    const overallBias = this._computeOverallBias(timeframeResults, availableTimeframes);
    const confidence = this._computeConfidence(timeframeResults, availableTimeframes);
    const { strongest, weakest } = this._computeStrongestWeakest(timeframeResults, availableTimeframes);
    const timeframeAgreement = this._computeTimeframeAgreement(timeframeResults, availableTimeframes);
    const indicatorAgreement = this._computeIndicatorAgreement(timeframeResults, availableTimeframes);

    this.calculationTime = Date.now() - start;
    this.lastUpdated = new Date().toISOString();

    return {
      symbol: this._symbol,
      overallBias,
      confidence,
      strongestTimeframe: strongest,
      weakestTimeframe: weakest,
      timeframeAgreement,
      indicatorAgreement,
      timeframes: timeframeResults,
      analysisTime: this.calculationTime,
      lastUpdated: this.lastUpdated,
      engineVersion: this.version,
      dataSource: this.dataSource,
    };
  }

  getInfo() {
    return {
      name: 'MTF',
      description: 'Multi-Timeframe Analysis — unified market assessment across all timeframes',
      implemented: true,
      version: this.version,
      timeframes: ALL_TIMEFRAMES,
      symbol: this._symbol,
    };
  }

  // ---------------------------------------------------------------------------
  // Aggregation: Overall Bias
  // ---------------------------------------------------------------------------

  _computeOverallBias(results, available) {
    let bullishVotes = 0;
    let bearishVotes = 0;
    let neutralVotes = 0;
    let totalWeight = 0;

    for (const tf of available) {
      const bias = results[tf].confluence.bias;
      const confidence = results[tf].confluence.confidence || 50;
      const weight = TF_WEIGHTS[tf] || 0.5;

      const vote = weight * (confidence / 100);
      totalWeight += weight;

      if (bias === 'Bullish') bullishVotes += vote;
      else if (bias === 'Bearish') bearishVotes += vote;
      else neutralVotes += vote;
    }

    if (totalWeight === 0) return 'Neutral';

    const bullishScore = (bullishVotes / totalWeight) * 100;
    const bearishScore = (bearishVotes / totalWeight) * 100;

    if (bullishScore >= 60) return 'Bullish';
    if (bearishScore >= 60) return 'Bearish';
    return 'Neutral';
  }

  // ---------------------------------------------------------------------------
  // Aggregation: Confidence
  // ---------------------------------------------------------------------------

  _computeConfidence(results, available) {
    if (available.length === 0) return 0;

    const confidences = available
      .map(tf => results[tf].confluence.confidence)
      .filter(c => c !== null && c !== undefined);

    if (confidences.length === 0) return 0;

    const avgConfidence = confidences.reduce((a, b) => a + b, 0) / confidences.length;
    const coveragePenalty = available.length / ALL_TIMEFRAMES.length;
    const agreement = this._computeTimeframeAgreement(results, available);
    const agreementBonus = (agreement / 100) * 0.3;

    return Math.round(Math.min(100, Math.max(0, avgConfidence * coveragePenalty + agreementBonus)));
  }

  // ---------------------------------------------------------------------------
  // Aggregation: Strongest / Weakest
  // ---------------------------------------------------------------------------

  _computeStrongestWeakest(results, available) {
    if (available.length === 0) {
      return { strongest: null, weakest: null };
    }

    let strongest = available[0];
    let weakest = available[0];

    for (const tf of available) {
      const score = results[tf].confluence.score || 0;
      const strongestScore = results[strongest].confluence.score || 0;
      const weakestScore = results[weakest].confluence.score || 0;

      // Prefer higher timeframe on tie for strongest
      if (score > strongestScore || (score === strongestScore && TF_WEIGHTS[tf] > TF_WEIGHTS[strongest])) {
        strongest = tf;
      }
      // Prefer lower timeframe on tie for weakest
      if (score < weakestScore || (score === weakestScore && TF_WEIGHTS[tf] < TF_WEIGHTS[weakest])) {
        weakest = tf;
      }
    }

    return { strongest, weakest };
  }

  // ---------------------------------------------------------------------------
  // Aggregation: Timeframe Agreement
  // ---------------------------------------------------------------------------

  _computeTimeframeAgreement(results, available) {
    if (available.length === 0) return 0;

    const biases = available.map(tf => results[tf].confluence.bias);
    const counts = {};
    for (const b of biases) {
      counts[b] = (counts[b] || 0) + 1;
    }

    const maxCount = Math.max(...Object.values(counts));
    return Math.round((maxCount / biases.length) * 100);
  }

  // ---------------------------------------------------------------------------
  // Aggregation: Indicator Agreement
  // ---------------------------------------------------------------------------

  _computeIndicatorAgreement(results, available) {
    const indicators = {
      trend: this._indicatorAgreement(results, available, 'trend'),
      structure: this._indicatorAgreement(results, available, 'structure'),
      rsi: this._indicatorAgreement(results, available, 'rsi'),
      ema: this._indicatorAgreement(results, available, 'ema'),
    };

    const availableIndicators = Object.values(indicators).filter(i => i.availableCount > 0);
    const overall = availableIndicators.length > 0
      ? Math.round(availableIndicators.reduce((sum, i) => sum + i.agreement, 0) / availableIndicators.length)
      : 0;

    return { overall, details: indicators };
  }

  _indicatorAgreement(results, available, indicator) {
    const directions = [];

    for (const tf of available) {
      const dir = this._extractDirection(results[tf], indicator);
      if (dir !== null) {
        directions.push(dir);
      }
    }

    if (directions.length === 0) {
      return { agreement: 0, direction: 'neutral', availableCount: 0 };
    }

    const counts = {};
    for (const d of directions) {
      counts[d] = (counts[d] || 0) + 1;
    }

    const dominantDir = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
    const agreement = Math.round((counts[dominantDir] / directions.length) * 100);

    return {
      agreement,
      direction: dominantDir,
      availableCount: directions.length,
    };
  }

  _extractDirection(tfResult, indicator) {
    switch (indicator) {
      case 'trend':
        if (tfResult.confluence.bias === 'Bullish') return 'bullish';
        if (tfResult.confluence.bias === 'Bearish') return 'bearish';
        return 'neutral';

      case 'structure':
        return tfResult.structure.direction;

      case 'rsi':
        if (tfResult.rsi.value === null) return null;
        if (tfResult.rsi.value > 55) return 'bullish';
        if (tfResult.rsi.value < 45) return 'bearish';
        return 'neutral';

      case 'ema':
        if (tfResult.ema.trend === null) return null;
        if (tfResult.ema.trend === 'Above') return 'bullish';
        if (tfResult.ema.trend === 'Below') return 'bearish';
        return 'neutral';

      default:
        return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  _emptyTimeframe(tf) {
    return {
      confluence: { score: null, bias: 'Neutral', confidence: 0 },
      structure: { direction: null, score: null },
      rsi: { value: null, state: null },
      ema: { value: null, trend: null },
      candleCount: 0,
    };
  }
}

module.exports = { MTFEngine, ENGINE_VERSION, TF_WEIGHTS, ALL_TIMEFRAMES, DEFAULT_SYMBOL };
