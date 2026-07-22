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
const { ComponentRegistry } = require('./componentRegistry');
const { normalizeComponentResult } = require('./componentNormalizer');
const { inspectDefinition, inspectResult } = require('./componentValidator');
const { createDefaultComponents } = require('./defaultComponentScorers');
const ENGINE_VERSION = '1.0.0';
const MIN_CANDLES = 15;

function extractComponentDefinition({ weight, calculate }) {
  return { weight, calculate };
}

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
    this._lastDiagnostics = [];

    this._componentRegistry = new ComponentRegistry();
    this._registerDefaults();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  calculate(candles, tf) {
    const start = Date.now();
    this._lastDiagnostics = [];

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

    for (const [name, component] of this._componentRegistry) {
      try {
        const result = component.calculate(candles, tf, context);
        this._lastDiagnostics.push(...inspectResult(name, result));
        componentResults[name] = normalizeComponentResult(result, component.weight);

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

  registerComponent(name, definition) {
    this._lastDiagnostics = [];
    this._lastDiagnostics.push(...inspectDefinition(name, definition));
    const { weight, calculate } = definition === null || definition === undefined
      ? extractComponentDefinition(definition)
      : definition;
    this._componentRegistry.register(name, { weight, calculate });
    return this;
  }

  getComponent(name) {
    return this._componentRegistry.get(name);
  }

  getComponents() {
    const result = {};
    for (const [name, comp] of this._componentRegistry) {
      result[name] = { weight: comp.weight };
    }
    return result;
  }

  clearComponents() {
    this._componentRegistry.clear();
    return this;
  }

  getInfo() {
    return {
      name: 'Confluence',
      description: 'Unified market quality scoring engine — combines all analysis components',
      implemented: true,
      version: this.version,
      symbol: this.symbol,
      componentCount: this._componentRegistry.size,
      components: this.getComponents(),
    };
  }

  // ---------------------------------------------------------------------------
  // Default component registration
  // ---------------------------------------------------------------------------

  _registerDefaults() {
    const components = createDefaultComponents({
      structureEngine: this.structureEngine,
      indicatorRegistry: this.indicatorRegistry,
    });

    for (const { name, weight, calculate } of components) {
      this.registerComponent(name, { weight, calculate });
    }
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
    return calculateConfidence(componentResults, this._componentRegistry.size);
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
