/**
 * Backtesting Engine
 *
 * Replays historical candles sequentially and evaluates Atlas signals
 * without executing trades. Uses ONLY existing production engines.
 *
 * Architecture:
 *   - Creates an isolated MockCandleEngine per timeframe under test
 *   - Feeds only candles[0..i] at step i (zero look-ahead bias)
 *   - Synthesizes analyzer snapshots from candle data (past only)
 *   - Runs Structure, RSI, EMA, MACD, ATR, Bollinger directly
 *   - Runs Confluence + MTF via the real production engines
 *
 * Version: 1.0.0
 * Data Source: Historical OHLCV candles (user-provided or from CandleEngine)
 */
const ENGINE_VERSION = '1.0.0';
const DEFAULT_SYMBOL = 'BTCUSDT';
const DEFAULT_PREDICTION_CANDLES = 5;
const DEFAULT_MIN_SIGNAL_CONFIDENCE = 0;
const DEFAULT_WARMUP_CANDLES = 50;

class BacktestEngine {
  constructor({ structureEngine, indicatorRegistry, logger, symbol }) {
    this.structureEngine = structureEngine;
    this.indicatorRegistry = indicatorRegistry;
    this.logger = logger;
    this.symbol = symbol || DEFAULT_SYMBOL;
    this.version = ENGINE_VERSION;
    this.lastUpdated = null;
    this.calculationTime = 0;
    this.dataSource = 'Historical OHLCV candles (production engine replay)';
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Run a backtest over the provided candles.
   *
   * @param {Object} options
   * @param {Array}  options.candles            - OHLCV array (ascending time)
   * @param {string} [options.timeframe='1h']   - Timeframe key
   * @param {number} [options.predictionCandles=5] - Candles ahead to evaluate
   * @param {number} [options.minSignalConfidence=0] - Min confidence to record
   * @param {number} [options.warmupCandles=50]  - Candles before first signal
   * @returns {Object} Backtest results
   */
  run(options) {
    const start = Date.now();

    const {
      candles,
      timeframe = '1h',
      predictionCandles = DEFAULT_PREDICTION_CANDLES,
      minSignalConfidence = DEFAULT_MIN_SIGNAL_CONFIDENCE,
      warmupCandles = DEFAULT_WARMUP_CANDLES,
    } = options;

    if (!candles || !Array.isArray(candles) || candles.length === 0) {
      this.calculationTime = Date.now() - start;
      this.lastUpdated = new Date().toISOString();
      return this._emptyResult(timeframe, 'No candle data provided');
    }

    const minRequired = warmupCandles + predictionCandles + 1;
    if (candles.length < minRequired) {
      this.calculationTime = Date.now() - start;
      this.lastUpdated = new Date().toISOString();
      return this._emptyResult(timeframe, `Insufficient candles (${candles.length}/${minRequired})`);
    }

    const signals = [];
    const endLoop = candles.length - predictionCandles;

    for (let i = warmupCandles; i < endLoop; i++) {
      const window = candles.slice(0, i + 1);
      const signal = this._generateSignal(window, timeframe);

      if (!signal || !signal.bias || signal.bias === 'Neutral') continue;
      if (signal.confidence < minSignalConfidence) continue;

      const priceAtSignal = candles[i].close;
      const futureCandle = candles[i + predictionCandles];
      const priceAfter = futureCandle.close;
      const outcome = this._evaluateOutcome(signal.bias, priceAtSignal, priceAfter);

      signals.push({
        timestamp: candles[i].timestamp,
        symbol: this.symbol,
        timeframe,
        overallBias: signal.bias,
        confidence: signal.confidence,
        priceAtSignal: this._round(priceAtSignal),
        priceAfter: this._round(priceAfter),
        outcome,
      });
    }

    const stats = this._computeStats(signals);

    this.calculationTime = Date.now() - start;
    this.lastUpdated = new Date().toISOString();

    return {
      symbol: this.symbol,
      timeframe,
      predictionCandles,
      warmupCandles,
      totalCandles: candles.length,
      signals,
      stats,
      engineVersion: this.version,
      lastUpdated: this.lastUpdated,
      calculationTime: this.calculationTime,
      dataSource: this.dataSource,
    };
  }

  getInfo() {
    return {
      name: 'Backtest',
      description: 'Historical signal replay engine — evaluates Atlas signals without executing trades',
      implemented: true,
      version: this.version,
      symbol: this.symbol,
    };
  }

  // ---------------------------------------------------------------------------
  // Signal Generation (production engine orchestration)
  // ---------------------------------------------------------------------------

  /**
   * Generate a signal from candles[0..end] using ALL production engines.
   * Never accesses candles beyond `end` index.
   */
  _generateSignal(candles, timeframe) {
    const lastCandle = candles[candles.length - 1];
    const lastClose = lastCandle.close;

    // 1. Structure Engine — takes candles directly
    const structureResult = this.structureEngine.calculate(candles);

    // 2. RSI Indicator — takes candles directly
    const rsiIndicator = this.indicatorRegistry.get('RSI');
    const rsiResult = rsiIndicator
      ? rsiIndicator.calculate(candles, `bt_${timeframe}`)
      : { ready: false };

    // 3. EMA Indicator — takes candles directly
    const emaIndicator = this.indicatorRegistry.get('EMA');
    const emaResult = emaIndicator
      ? emaIndicator.calculate(candles, `bt_${timeframe}`, 20)
      : { ready: false };

    // 4. MACD Engine — via MockCandleEngine (windows candles[0..end])
    const macdResult = this._runMACD(candles, timeframe);

    // 5. ATR Engine — via MockCandleEngine (windows candles[0..end])
    const atrResult = this._runATR(candles, timeframe);

    // 6. Bollinger Engine — via MockCandleEngine (windows candles[0..end])
    const bollingerResult = this._runBollinger(candles, timeframe);

    // 7. Trend Analyzer — synthesized from candle data (past only)
    const analyzerOutput = this._synthesizeAnalyzer(candles);

    // 8. Confluence Engine — real production engine
    const confluenceResult = this._runConfluence(
      candles, timeframe, analyzerOutput, structureResult, rsiResult
    );

    // 9. MTF Engine — single-timeframe confluence (real engine logic)
    const mtfResult = this._runMTF(confluenceResult, structureResult, rsiResult, emaResult, timeframe);

    // 10. Combine all signals into overall bias
    return this._combineSignals({
      structure: structureResult,
      rsi: rsiResult,
      ema: emaResult,
      macd: macdResult,
      atr: atrResult,
      bollinger: bollingerResult,
      confluence: confluenceResult,
      mtf: mtfResult,
      lastClose,
    });
  }

  // ---------------------------------------------------------------------------
  // Engine runners (via MockCandleEngine — no look-ahead)
  // ---------------------------------------------------------------------------

  _runMACD(candles, timeframe) {
    try {
      const { MACDEngine } = require('./macd');
      const mock = this._makeMockCandleEngine(candles, timeframe);
      const engine = new MACDEngine({ candleEngine: mock, logger: this.logger, symbol: this.symbol });
      return engine.calculate(timeframe, candles.length);
    } catch {
      return { ready: false };
    }
  }

  _runATR(candles, timeframe) {
    try {
      const { ATREngine } = require('./atr');
      const mock = this._makeMockCandleEngine(candles, timeframe);
      const engine = new ATREngine({ candleEngine: mock, logger: this.logger, symbol: this.symbol });
      return engine.calculate(timeframe, candles.length);
    } catch {
      return { ready: false };
    }
  }

  _runBollinger(candles, timeframe) {
    try {
      const { BollingerEngine } = require('./bollinger');
      const mock = this._makeMockCandleEngine(candles, timeframe);
      const engine = new BollingerEngine({ candleEngine: mock, logger: this.logger, symbol: this.symbol });
      return engine.calculate(timeframe, candles.length);
    } catch {
      return { ready: false };
    }
  }

  _runConfluence(candles, timeframe, analyzerOutput, structureResult, rsiResult) {
    try {
      const { ConfluenceEngine } = require('./confluence');
      const mockAnalyzer = { getAnalysis: () => analyzerOutput };
      const mockIndicatorRegistry = {
        get: (name) => {
          if (name === 'RSI') return { calculate: () => rsiResult };
          if (name === 'EMA') return { calculate: () => ({ ready: false }) };
          return { calculate: () => ({ ready: false }) };
        },
      };
      const mockStructureEngine = {
        calculate: () => structureResult,
      };
      const mockCandleEngine = {
        getAllTimeframes: () => [timeframe],
        getCandles: () => candles,
        getActive: () => null,
      };

      const engine = new ConfluenceEngine({
        analyzer: mockAnalyzer,
        indicatorRegistry: mockIndicatorRegistry,
        structureEngine: mockStructureEngine,
        candleEngine: mockCandleEngine,
        logger: this.logger,
        config: { get: (key) => {
          if (key === 'CONFLUENCE_BULLISH_THRESHOLD') return 65;
          if (key === 'CONFLUENCE_BEARISH_THRESHOLD') return 35;
          return null;
        }},
        symbol: this.symbol,
      });

      return engine.calculate(candles, timeframe);
    } catch {
      return { score: null, bias: 'Neutral', confidence: 0 };
    }
  }

  _runMTF(confluenceResult, structureResult, rsiResult, emaResult, timeframe) {
    try {
      const { MTFEngine } = require('./mtf');
      const mockConfluenceEngine = {
        calculate: () => confluenceResult,
      };
      const mockStructureEngine = {
        calculate: () => structureResult,
      };
      const mockIndicatorRegistry = {
        get: (name) => ({
          calculate: () => {
            if (name === 'RSI') return rsiResult;
            if (name === 'EMA') return emaResult;
            return { ready: false };
          },
        }),
      };
      const mockCandleEngine = {
        getCandles: () => [],
        getActive: () => null,
        getAllTimeframes: () => [timeframe],
      };

      const engine = new MTFEngine({
        confluenceEngine: mockConfluenceEngine,
        structureEngine: mockStructureEngine,
        indicatorRegistry: mockIndicatorRegistry,
        candleEngine: mockCandleEngine,
        analyzer: { getAnalysis: () => null },
        logger: this.logger,
        config: { get: () => null },
        symbol: this.symbol,
      });

      return engine.calculate(candles.length);
    } catch {
      return { overallBias: 'Neutral', confidence: 0 };
    }
  }

  // ---------------------------------------------------------------------------
  // Signal Combination
  // ---------------------------------------------------------------------------

  _combineSignals(engines) {
    const votes = { Bullish: 0, Bearish: 0 };
    let totalWeight = 0;
    const weights = {
      structure: 0.20,
      rsi: 0.10,
      ema: 0.10,
      macd: 0.15,
      bollinger: 0.10,
      confluence: 0.25,
      mtf: 0.10,
    };

    // Structure
    if (engines.structure.ready && engines.structure.direction) {
      const dir = engines.structure.direction === 'bullish' ? 'Bullish'
        : engines.structure.direction === 'bearish' ? 'Bearish' : null;
      if (dir) {
        const w = weights.structure * (engines.structure.confidence || 50) / 100;
        votes[dir] += w;
        totalWeight += w;
      }
    }

    // RSI
    if (engines.rsi.ready && engines.rsi.value !== null) {
      const dir = engines.rsi.value > 55 ? 'Bullish'
        : engines.rsi.value < 45 ? 'Bearish' : null;
      if (dir) {
        const strength = Math.abs(engines.rsi.value - 50) / 50;
        const w = weights.rsi * strength;
        votes[dir] += w;
        totalWeight += w;
      }
    }

    // EMA
    if (engines.ema.ready && engines.ema.trend) {
      const dir = engines.ema.trend === 'Above' ? 'Bullish'
        : engines.ema.trend === 'Below' ? 'Bearish' : null;
      if (dir) {
        votes[dir] += weights.ema;
        totalWeight += weights.ema;
      }
    }

    // MACD
    if (engines.macd.ready && engines.macd.trend) {
      const dir = engines.macd.trend;
      if (dir === 'Bullish' || dir === 'Bearish') {
        const w = weights.macd * (engines.macd.histogram > 0
          ? Math.min(1, Math.abs(engines.macd.histogram) * 10)
          : Math.min(1, Math.abs(engines.macd.histogram) * 10));
        votes[dir] += w;
        totalWeight += w;
      }
    }

    // Bollinger
    if (engines.bollinger.ready && engines.bollinger.pricePosition) {
      const dir = engines.bollinger.pricePosition === 'Below Lower' ? 'Bullish'
        : engines.bollinger.pricePosition === 'Above Upper' ? 'Bearish' : null;
      if (dir) {
        votes[dir] += weights.bollinger;
        totalWeight += weights.bollinger;
      }
    }

    // Confluence
    if (engines.confluence && engines.confluence.bias && engines.confluence.bias !== 'Neutral') {
      const dir = engines.confluence.bias;
      const w = weights.confluence * (engines.confluence.confidence || 50) / 100;
      votes[dir] += w;
      totalWeight += w;
    }

    // MTF
    if (engines.mtf && engines.mtf.overallBias && engines.mtf.overallBias !== 'Neutral') {
      const dir = engines.mtf.overallBias;
      const w = weights.mtf * (engines.mtf.confidence || 50) / 100;
      votes[dir] += w;
      totalWeight += w;
    }

    if (totalWeight === 0) {
      return { bias: 'Neutral', confidence: 0 };
    }

    const bullishRatio = votes.Bullish / totalWeight;
    const bearishRatio = votes.Bearish / totalWeight;

    let bias;
    if (bullishRatio >= 0.55) bias = 'Bullish';
    else if (bearishRatio >= 0.55) bias = 'Bearish';
    else bias = 'Neutral';

    const confidence = Math.round(
      Math.max(bullishRatio, bearishRatio) * 100 * (totalWeight / (totalWeight + 0.5))
    );

    return { bias, confidence: Math.min(100, Math.max(0, confidence)) };
  }

  // ---------------------------------------------------------------------------
  // Analyzer Synthesis (from candle data only — no look-ahead)
  // ---------------------------------------------------------------------------

  _synthesizeAnalyzer(candles) {
    const windowSize = Math.min(candles.length, 50);
    const start = candles.length - windowSize;
    const window = candles.slice(start);

    const trend = {};
    const momentum = {};
    const volatility = {};
    const confidence = {};

    const closes = window.map(c => c.close);

    // Simple trend classification from close direction
    const firstHalf = closes.slice(0, Math.floor(closes.length / 2));
    const secondHalf = closes.slice(Math.floor(closes.length / 2));
    const avgFirst = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
    const avgSecond = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;
    const pctChange = ((avgSecond - avgFirst) / avgFirst) * 100;

    let trendDir;
    if (pctChange > 0.15) trendDir = 'Bullish';
    else if (pctChange < -0.15) trendDir = 'Bearish';
    else trendDir = 'Sideways';

    trend['1H'] = trendDir;

    // Momentum — ratio of up-moves
    let upCount = 0;
    for (let i = 1; i < closes.length; i++) {
      if (closes[i] > closes[i - 1]) upCount++;
    }
    momentum['1H'] = Math.round((upCount / (closes.length - 1)) * 100);

    // Volatility — standard deviation of returns
    const returns = [];
    for (let i = 1; i < closes.length; i++) {
      returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
    }
    const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + (r - avgReturn) ** 2, 0) / returns.length;
    const stdDev = Math.sqrt(variance) * 100;

    let volLevel;
    if (stdDev > 1.5) volLevel = 'High';
    else if (stdDev > 0.5) volLevel = 'Medium';
    else volLevel = 'Low';
    volatility['1H'] = volLevel;

    // Confidence — based on data availability
    const sampleScore = Math.min(100, windowSize * 2);
    const consistencyScore = trendDir !== 'Sideways' ? 70 : 40;
    confidence['1H'] = Math.round(sampleScore * 0.4 + consistencyScore * 0.5 + 10);

    return {
      price: closes[closes.length - 1],
      volume24h: window.reduce((sum, c) => sum + c.volume, 0),
      change24h: pctChange,
      trend,
      volatility,
      momentum,
      confidence,
      dataPoints: { '1H': windowSize },
      timeframes: [{ id: '1H', label: '1H' }],
      timestamp: candles[candles.length - 1].timestamp,
      analyzedAt: new Date().toISOString(),
    };
  }

  // ---------------------------------------------------------------------------
  // Outcome Evaluation
  // ---------------------------------------------------------------------------

  _evaluateOutcome(bias, priceAtSignal, priceAfter) {
    const change = ((priceAfter - priceAtSignal) / priceAtSignal) * 100;
    const threshold = 0.1;

    if (bias === 'Bullish') {
      if (change > threshold) return 'correct';
      if (change < -threshold) return 'incorrect';
    } else if (bias === 'Bearish') {
      if (change < -threshold) return 'correct';
      if (change > threshold) return 'incorrect';
    }
    return 'neutral';
  }

  // ---------------------------------------------------------------------------
  // Statistics
  // ---------------------------------------------------------------------------

  _computeStats(signals) {
    if (signals.length === 0) {
      return {
        totalSignals: 0,
        bullishSignals: 0,
        bearishSignals: 0,
        winRate: 0,
        lossRate: 0,
        averageConfidence: 0,
        bestTimeframe: null,
        worstTimeframe: null,
      };
    }

    const bullish = signals.filter(s => s.overallBias === 'Bullish');
    const bearish = signals.filter(s => s.overallBias === 'Bearish');
    const correct = signals.filter(s => s.outcome === 'correct');
    const incorrect = signals.filter(s => s.outcome === 'incorrect');

    const avgConfidence = signals.reduce((sum, s) => sum + s.confidence, 0) / signals.length;

    // Timeframe performance (in this context all signals share the same timeframe,
    // but the structure supports per-TF stats if extended)
    const tfStats = {};
    for (const s of signals) {
      if (!tfStats[s.timeframe]) {
        tfStats[s.timeframe] = { total: 0, correct: 0 };
      }
      tfStats[s.timeframe].total++;
      if (s.outcome === 'correct') tfStats[s.timeframe].correct++;
    }

    let bestTimeframe = null;
    let worstTimeframe = null;
    let bestWinRate = -1;
    let worstWinRate = 101;

    for (const [tf, stat] of Object.entries(tfStats)) {
      const wr = stat.total > 0 ? (stat.correct / stat.total) * 100 : 0;
      if (wr > bestWinRate) { bestWinRate = wr; bestTimeframe = tf; }
      if (wr < worstWinRate) { worstWinRate = wr; worstTimeframe = tf; }
    }

    return {
      totalSignals: signals.length,
      bullishSignals: bullish.length,
      bearishSignals: bearish.length,
      winRate: Math.round((correct.length / signals.length) * 10000) / 100,
      lossRate: Math.round((incorrect.length / signals.length) * 10000) / 100,
      averageConfidence: Math.round(avgConfidence * 100) / 100,
      bestTimeframe,
      worstTimeframe,
    };
  }

  // ---------------------------------------------------------------------------
  // Mock CandleEngine (isolated per backtest step — zero look-ahead)
  // ---------------------------------------------------------------------------

  _makeMockCandleEngine(candles, timeframe) {
    return {
      getCandles: (tf, limit) => {
        const result = [...candles];
        if (limit && limit > 0) return result.slice(-limit);
        return result;
      },
      getActive: () => null,
      getAllTimeframes: () => [timeframe],
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  _round(value) {
    return Math.round(value * 100) / 100;
  }

  _emptyResult(timeframe, reason) {
    return {
      symbol: this.symbol,
      timeframe,
      predictionCandles: DEFAULT_PREDICTION_CANDLES,
      warmupCandles: DEFAULT_WARMUP_CANDLES,
      totalCandles: 0,
      signals: [],
      stats: {
        totalSignals: 0,
        bullishSignals: 0,
        bearishSignals: 0,
        winRate: 0,
        lossRate: 0,
        averageConfidence: 0,
        bestTimeframe: null,
        worstTimeframe: null,
      },
      reason,
      engineVersion: this.version,
      lastUpdated: new Date().toISOString(),
      calculationTime: this.calculationTime,
      dataSource: this.dataSource,
    };
  }
}

module.exports = { BacktestEngine, ENGINE_VERSION, DEFAULT_SYMBOL, DEFAULT_PREDICTION_CANDLES, DEFAULT_MIN_SIGNAL_CONFIDENCE, DEFAULT_WARMUP_CANDLES };
