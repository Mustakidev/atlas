/**
 * Signal History Engine — records completed market analyses
 *
 * Stores one snapshot per meaningful state change (new candle or analysis
 * change). Designed for future backtesting, analytics, and paper trading.
 *
 * Does NOT execute trades or predict candles.
 *
 * Version: 1.0.0
 */
const { getFinalizedCandles } = require('./candleUtils');
const ENGINE_VERSION = '1.0.0';

class SignalHistoryEngine {
  constructor({ config, logger, symbol, history, analyzer, structureEngine, candleEngine, indicatorRegistry, confluenceEngine, mtfEngine, macdEngine }) {
    this.logger = logger;
    this.symbol = symbol || 'BTCUSDT';
    this.maxSize = config.get('MAX_HISTORY') || 500;
    this.defaultTimeframe = '1h';

    this.history = history;
    this.analyzer = analyzer;
    this.structureEngine = structureEngine;
    this.candleEngine = candleEngine;
    this.indicatorRegistry = indicatorRegistry;
    this.confluenceEngine = confluenceEngine;
    this.mtfEngine = mtfEngine;
    this.macdEngine = macdEngine;

    this.records = [];
    this.version = ENGINE_VERSION;
    this.lastUpdated = null;
    this.calculationTime = 0;
    this.dataSource = 'All engine outputs (deduplicated)';

    this._lastRecordedOpenTime = null;
    this._lastRecordedHash = null;
    this._recordIndex = 0;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  record(timeframe) {
    const tf = timeframe || this.defaultTimeframe;
    const start = Date.now();

    const finalized = getFinalizedCandles(this.candleEngine, tf, 500);

    if (!finalized || finalized.length === 0) {
      this.calculationTime = Date.now() - start;
      return null;
    }

    const latestCandle = finalized[finalized.length - 1];
    const currentOpenTime = latestCandle.openTime;

    const trend = this._getTrend();
    const structure = this._getStructure(finalized);
    const rsi = this._getRSI(finalized, tf);
    const ema = this._getEMA(finalized, tf);
    const macd = this._getMACD(tf);
    const confluence = this._getConfluence(finalized, tf);
    const mtf = this._getMTF();

    const analysisHash = this._hash({
      trend: trend?.overall,
      structure: structure?.direction,
      rsi: rsi?.value,
      ema: ema?.trend,
      macd: macd?.trend,
      confluence: confluence?.bias,
      mtf: mtf?.overallBias,
    });

    if (currentOpenTime === this._lastRecordedOpenTime &&
        analysisHash === this._lastRecordedHash) {
      this.calculationTime = Date.now() - start;
      return null;
    }

    this._lastRecordedOpenTime = currentOpenTime;
    this._lastRecordedHash = analysisHash;
    this._recordIndex++;

    const record = {
      id: `${currentOpenTime}-${this._recordIndex}`,
      timestamp: new Date().toISOString(),
      symbol: this.symbol,
      timeframe: tf,
      trend,
      structure,
      rsi,
      ema,
      macd,
      confluence,
      mtf,
      confidence: mtf?.confidence ?? null,
      strongestTimeframe: mtf?.strongestTimeframe ?? null,
      weakestTimeframe: mtf?.weakestTimeframe ?? null,
      engineVersion: this.version,
    };

    this.records.push(Object.freeze(record));
    if (this.records.length > this.maxSize) {
      this.records.shift();
    }

    this.calculationTime = Date.now() - start;
    this.lastUpdated = new Date().toISOString();

    this.logger.info('SignalHistory', `Recorded ${record.id} | ${tf} | bias=${mtf?.overallBias} | confidence=${record.confidence} | ${this.calculationTime}ms`);

    return record;
  }

  latest(symbol) {
    if (symbol) {
      for (let i = this.records.length - 1; i >= 0; i--) {
        if (this.records[i].symbol === symbol) return this.records[i];
      }
      return null;
    }
    return this.records[this.records.length - 1] || null;
  }

  last(n, symbol) {
    if (n <= 0) return [];
    if (symbol) {
      const filtered = this.records.filter(r => r.symbol === symbol);
      return filtered.slice(-Math.min(n, this.maxSize));
    }
    return this.records.slice(-Math.min(n, this.maxSize));
  }

  all() {
    return [...this.records];
  }

  size() {
    return this.records.length;
  }

  clear() {
    this.records = [];
    this._lastRecordedOpenTime = null;
    this._lastRecordedHash = null;
    this._recordIndex = 0;
  }

  getBySymbol(symbol) {
    return this.records.filter(r => r.symbol === symbol);
  }

  getByTimeframe(tf) {
    return this.records.filter(r => r.timeframe === tf);
  }

  stats(symbol) {
    const filtered = symbol ? this.records.filter(r => r.symbol === symbol) : this.records;

    if (filtered.length === 0) {
      return {
        totalRecords: 0,
        symbols: [],
        timeframes: [],
        oldest: null,
        newest: null,
        averageConfidence: 0,
        biasDistribution: { Bullish: 0, Bearish: 0, Neutral: 0 },
        limit: this.maxSize,
      };
    }

    const symbols = {};
    const timeframes = {};
    const biasDist = { Bullish: 0, Bearish: 0, Neutral: 0 };
    let totalConfidence = 0;
    let confidenceCount = 0;

    for (const r of filtered) {
      symbols[r.symbol] = (symbols[r.symbol] || 0) + 1;
      timeframes[r.timeframe] = (timeframes[r.timeframe] || 0) + 1;

      const bias = r.mtf?.overallBias;
      if (bias && biasDist[bias] !== undefined) {
        biasDist[bias]++;
      }

      if (r.confidence != null) {
        totalConfidence += r.confidence;
        confidenceCount++;
      }
    }

    return {
      totalRecords: filtered.length,
      symbols: Object.entries(symbols).map(([symbol, count]) => ({ symbol, count })),
      timeframes: Object.entries(timeframes).map(([timeframe, count]) => ({ timeframe, count })),
      oldest: filtered[0].timestamp,
      newest: filtered[filtered.length - 1].timestamp,
      averageConfidence: confidenceCount > 0 ? Math.round(totalConfidence / confidenceCount) : 0,
      biasDistribution: biasDist,
      limit: this.maxSize,
    };
  }

  getInfo() {
    return {
      name: 'SignalHistory',
      description: 'Records completed market analyses for backtesting and paper trading',
      version: this.version,
      symbol: this.symbol,
      maxSize: this.maxSize,
      currentSize: this.records.length,
      dataSource: this.dataSource,
    };
  }

  // ---------------------------------------------------------------------------
  // Engine data collectors
  // ---------------------------------------------------------------------------

  _getTrend() {
    try {
      const analysis = this.analyzer.getAnalysis();
      if (!analysis) return null;
      return {
        overall: analysis.trend?.['1H'] || 'Sideways',
        timeframes: { ...analysis.trend },
      };
    } catch {
      return null;
    }
  }

  _getStructure(candles) {
    try {
      const result = this.structureEngine.calculate(candles);
      if (!result?.ready) return null;
      return {
        direction: result.direction,
        score: result.score,
        lastBOS: result.lastBOS,
      };
    } catch {
      return null;
    }
  }

  _getRSI(candles, tf) {
    try {
      const rsi = this.indicatorRegistry.get('RSI');
      const result = rsi.calculate(candles, tf);
      if (!result?.ready) return null;
      return {
        value: result.value,
        state: result.state,
        timeframe: tf,
      };
    } catch {
      return null;
    }
  }

  _getEMA(candles, tf) {
    try {
      const ema = this.indicatorRegistry.get('EMA');
      const result = ema.calculate(candles, tf, 20);
      if (!result?.ready) return null;
      return {
        value: result.value,
        trend: result.trend,
        period: 20,
        timeframe: tf,
      };
    } catch {
      return null;
    }
  }

  _getMACD(tf) {
    try {
      const result = this.macdEngine.calculate(tf, 500);
      if (!result?.ready) return null;
      return {
        macd: result.macd,
        signal: result.signal,
        histogram: result.histogram,
        trend: result.trend,
        crossover: result.crossover,
        timeframe: tf,
      };
    } catch {
      return null;
    }
  }

  _getConfluence(candles, tf) {
    try {
      const result = this.confluenceEngine.calculate(candles, tf);
      return {
        score: result.score,
        bias: result.bias,
        confidence: result.confidence,
        timeframe: tf,
      };
    } catch {
      return null;
    }
  }

  _getMTF() {
    try {
      const result = this.mtfEngine.calculate(500);
      return {
        overallBias: result.overallBias,
        confidence: result.confidence,
        strongestTimeframe: result.strongestTimeframe,
        weakestTimeframe: result.weakestTimeframe,
        timeframeAgreement: result.timeframeAgreement,
      };
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  _hash(obj) {
    let str = '';
    for (const key of Object.keys(obj).sort()) {
      const val = obj[key];
      str += key + ':' + (val != null ? String(val) : 'null') + '|';
    }
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + ch;
      hash |= 0;
    }
    return hash;
  }
}

module.exports = { SignalHistoryEngine, ENGINE_VERSION };
