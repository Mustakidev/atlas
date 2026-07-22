/**
 * Confluence Engine
 *
 * Combines Trend, Structure, Momentum, RSI, and Volatility into
 * a unified market quality score (0-100), bias, and confidence.
 *
 * Architecture: Component Registry — future indicators register via
 * registerComponent() with no engine changes required.
 *
 * Version: 1.0.0
 * Data Source: MarketAnalyzer + IndicatorRegistry + StructureEngine + CandleEngine
 */
const { getFinalizedCandles } = require('./candleUtils');
const { classifyBias } = require('./biasClassifier');
const { calculateConfidence } = require('./confidenceCalculator');
const { aggregateScore } = require('./scoreAggregator');
const ENGINE_VERSION = '1.0.0';
const MIN_CANDLES = 15;

const TF_MAP = {
  '24H': '24h', '12H': '12h', '4H': '4h', '1H': '1h',
  '30M': '30m', '15M': '15m', '5M': '5m',
};

class ConfluenceEngine {
  constructor({ analyzer, indicatorRegistry, structureEngine, candleEngine, logger, config, symbol }) {
    this.analyzer = analyzer;
    this.indicatorRegistry = indicatorRegistry;
    this.structureEngine = structureEngine;
    this.candleEngine = candleEngine;
    this.logger = logger;
    this.config = config;
    this.symbol = symbol || config?.get('SYMBOL') || 'BTCUSDT';
    this.version = ENGINE_VERSION;
    this.lastUpdated = null;
    this.calculationTime = 0;
    this.dataSource = 'MarketAnalyzer + IndicatorRegistry + StructureEngine + CandleEngine';

    this.components = new Map();
    this._registerDefaults();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  calculate(candles, tf) {
    const start = Date.now();

    if (!candles || candles.length < MIN_CANDLES) {
      this.calculationTime = Date.now() - start;
      this.lastUpdated = new Date().toISOString();
      return this._notReady(candles ? candles.length : 0, tf);
    }

    const analysis = this.analyzer.getAnalysis();
    const analyzerTf = this._reverseTf(tf);
    const context = { analysis, analyzerTf, tf };

    const componentResults = {};
    const missing = [];

    for (const [name, component] of this.components) {
      try {
        const result = component.calculate(candles, tf, context);
        componentResults[name] = {
          score: result.score,
          direction: result.direction,
          weight: component.weight,
          available: result.available !== false,
          confidence: result.confidence || null,
          reason: result.reason || null,
        };

        if (result.available === false || result.score === null) {
          missing.push({ name, reason: result.reason || 'Insufficient data' });
        }
      } catch (err) {
        componentResults[name] = {
          score: null,
          direction: null,
          weight: component.weight,
          available: false,
          confidence: null,
          reason: err.message,
        };
        missing.push({ name, reason: err.message });
      }
    }

    const overallScore = aggregateScore(componentResults);
    const bias = overallScore !== null ? this._classifyBias(overallScore) : 'Neutral';
    const confidence = this._computeConfidence(componentResults, missing);

    this.calculationTime = Date.now() - start;
    this.lastUpdated = new Date().toISOString();

    return {
      timeframe: tf,
      candleCount: candles.length,
      score: overallScore,
      bias,
      confidence,
      components: componentResults,
      missing,
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
    const timeframes = this.candleEngine.getAllTimeframes();

    for (const tf of timeframes) {
      const finalized = getFinalizedCandles(this.candleEngine, tf, limit);
      results[tf] = this.calculate(finalized, tf);
    }

    return results;
  }

  registerComponent(name, { weight, calculate }) {
    if (this.components.has(name)) {
      throw new Error(`Component '${name}' is already registered`);
    }
    if (typeof calculate !== 'function') {
      throw new Error(`Component '${name}' must provide a calculate function`);
    }
    this.components.set(name, { weight, calculate });
    return this;
  }

  getComponent(name) {
    return this.components.get(name) || null;
  }

  getComponents() {
    const result = {};
    for (const [name, comp] of this.components) {
      result[name] = { weight: comp.weight };
    }
    return result;
  }

  getInfo() {
    return {
      name: 'Confluence',
      description: 'Unified market quality scoring engine — combines all analysis components',
      implemented: true,
      version: this.version,
      symbol: this.symbol,
      componentCount: this.components.size,
      components: this.getComponents(),
    };
  }

  // ---------------------------------------------------------------------------
  // Default component registration
  // ---------------------------------------------------------------------------

  _registerDefaults() {
    this.registerComponent('trend', {
      weight: 0.30,
      calculate: (candles, tf, ctx) => this._scoreTrend(candles, tf, ctx),
    });

    this.registerComponent('structure', {
      weight: 0.25,
      calculate: (candles, tf, ctx) => this._scoreStructure(candles, tf, ctx),
    });

    this.registerComponent('momentum', {
      weight: 0.15,
      calculate: (candles, tf, ctx) => this._scoreMomentum(candles, tf, ctx),
    });

    this.registerComponent('rsi', {
      weight: 0.15,
      calculate: (candles, tf, ctx) => this._scoreRSI(candles, tf, ctx),
    });

    this.registerComponent('volatility', {
      weight: 0.15,
      calculate: (candles, tf, ctx) => this._scoreVolatility(candles, tf, ctx),
    });
  }

  // ---------------------------------------------------------------------------
  // Component scoring functions
  // ---------------------------------------------------------------------------

  _scoreTrend(candles, tf, ctx) {
    const analysis = ctx.analysis;
    if (!analysis || !analysis.trend) {
      return { score: null, direction: null, available: false, reason: 'No analysis data' };
    }

    const trendVal = analysis.trend[ctx.analyzerTf];
    const confVal = analysis.confidence ? analysis.confidence[ctx.analyzerTf] || 0 : 0;

    if (!trendVal) {
      return { score: null, direction: null, available: false, reason: `No trend data for ${ctx.analyzerTf}` };
    }

    let score;
    if (trendVal === 'Bullish') {
      score = 65 + Math.min(confVal * 0.35, 35);
    } else if (trendVal === 'Bearish') {
      score = 35 - Math.min(confVal * 0.35, 35);
    } else {
      score = 50;
    }

    return {
      score: Math.round(Math.max(0, Math.min(100, score))),
      direction: trendVal.toLowerCase(),
      available: true,
      confidence: confVal,
    };
  }

  _scoreStructure(candles, tf, ctx) {
    const result = this.structureEngine.calculate(candles);

    if (!result.ready) {
      return { score: null, direction: null, available: false, reason: result.reason };
    }

    return {
      score: result.score,
      direction: result.direction,
      available: true,
      confidence: result.confidence,
    };
  }

  _scoreMomentum(candles, tf, ctx) {
    const analysis = ctx.analysis;
    if (!analysis || !analysis.momentum) {
      return { score: null, direction: null, available: false, reason: 'No analysis data' };
    }

    const momVal = analysis.momentum[ctx.analyzerTf];
    if (momVal === undefined || momVal === null) {
      return { score: null, direction: null, available: false, reason: `No momentum data for ${ctx.analyzerTf}` };
    }

    let direction = 'neutral';
    if (momVal > 55) direction = 'bullish';
    else if (momVal < 45) direction = 'bearish';

    return {
      score: Math.round(Math.max(0, Math.min(100, momVal))),
      direction,
      available: true,
      confidence: analysis.confidence ? analysis.confidence[ctx.analyzerTf] || 50 : 50,
    };
  }

  _scoreRSI(candles, tf, ctx) {
    const rsiIndicator = this.indicatorRegistry.get('RSI');
    if (!rsiIndicator) {
      return { score: null, direction: null, available: false, reason: 'RSI indicator not registered' };
    }

    const result = rsiIndicator.calculate(candles, tf);
    if (!result.ready) {
      return { score: null, direction: null, available: false, reason: result.reason || 'RSI not ready' };
    }

    let direction = 'neutral';
    if (result.state === 'Overbought') direction = 'neutral';
    else if (result.state === 'Oversold') direction = 'neutral';
    else {
      if (result.value > 55) direction = 'bullish';
      else if (result.value < 45) direction = 'bearish';
    }

    return {
      score: result.strength,
      direction,
      available: true,
      confidence: result.confidence || 50,
    };
  }

  _scoreVolatility(candles, tf, ctx) {
    const analysis = ctx.analysis;
    if (!analysis || !analysis.volatility) {
      return { score: null, direction: null, available: false, reason: 'No analysis data' };
    }

    const volVal = analysis.volatility[ctx.analyzerTf];
    if (!volVal) {
      return { score: null, direction: null, available: false, reason: `No volatility data for ${ctx.analyzerTf}` };
    }

    let score;
    if (volVal === 'Low') score = 85;
    else if (volVal === 'Medium') score = 50;
    else score = 15;

    return {
      score,
      direction: null,
      available: true,
      confidence: analysis.confidence ? analysis.confidence[ctx.analyzerTf] || 50 : 50,
    };
  }

  // ---------------------------------------------------------------------------
  // Bias and confidence
  // ---------------------------------------------------------------------------

  _classifyBias(score) {
    return classifyBias(score, {
      bullishThreshold: this.config?.get('CONFLUENCE_BULLISH_THRESHOLD'),
      bearishThreshold: this.config?.get('CONFLUENCE_BEARISH_THRESHOLD'),
    });
  }

  _computeConfidence(componentResults, missing) {
    return calculateConfidence(componentResults, this.components.size);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  _reverseTf(lowerTf) {
    for (const [upper, lower] of Object.entries(TF_MAP)) {
      if (lower === lowerTf) return upper;
    }
    return lowerTf.toUpperCase();
  }

  _notReady(candleCount, tf) {
    return {
      timeframe: tf,
      candleCount,
      score: null,
      bias: 'Neutral',
      confidence: 0,
      components: {},
      missing: [{ name: 'all', reason: `Insufficient candle data (${candleCount}/${MIN_CANDLES})` }],
      timestamp: null,
      calculatedAt: new Date().toISOString(),
      engineVersion: this.version,
      lastUpdated: this.lastUpdated,
      calculationTime: this.calculationTime,
      dataSource: this.dataSource,
    };
  }
}

module.exports = { ConfluenceEngine, ENGINE_VERSION, TF_MAP, MIN_CANDLES };
