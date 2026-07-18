/**
 * Analytics Engine
 *
 * Analyzes Atlas backtesting results and signal history to measure
 * signal quality, risk metrics, and confidence calibration.
 *
 * Consumes outputs only — never modifies existing engines.
 *
 * Version: 1.0.0
 * Data Source: BacktestEngine results + SignalHistoryEngine records
 */
const ENGINE_VERSION = '1.0.0';
const DEFAULT_SYMBOL = 'BTCUSDT';

class AnalyticsEngine {
  constructor({ logger, symbol }) {
    this.logger = logger;
    this.symbol = symbol || DEFAULT_SYMBOL;
    this.version = ENGINE_VERSION;
    this.lastUpdated = null;
    this.calculationTime = 0;
    this.dataSource = 'BacktestEngine + SignalHistoryEngine';
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Run analytics on backtest results and/or signal history records.
   *
   * @param {Object} options
   * @param {Object} [options.backtestResult]  - Output from BacktestEngine.run()
   * @param {Array}  [options.signalHistory]   - Array of signal history records
   * @returns {Object} Full analytics report
   */
  analyze(options) {
    const start = Date.now();
    const { backtestResult, signalHistory } = options || {};

    const backtestSignals = backtestResult?.signals || [];
    const historyRecords = signalHistory || [];

    const general = this._computeGeneral(backtestSignals, historyRecords);
    const accuracy = this._computeAccuracy(backtestSignals);
    const risk = this._computeRisk(backtestSignals);
    const confidence = this._computeConfidence(backtestSignals);
    const performance = this._computePerformance(backtestSignals, backtestResult);

    this.calculationTime = Date.now() - start;
    this.lastUpdated = new Date().toISOString();

    return {
      symbol: this.symbol,
      general,
      accuracy,
      risk,
      confidence,
      performance,
      engineVersion: this.version,
      lastUpdated: this.lastUpdated,
      calculationTime: this.calculationTime,
      dataSource: this.dataSource,
    };
  }

  getInfo() {
    return {
      name: 'Analytics',
      description: 'Performance analytics engine — measures signal quality, risk, and confidence calibration',
      implemented: true,
      version: this.version,
      symbol: this.symbol,
    };
  }

  // ---------------------------------------------------------------------------
  // General Metrics
  // ---------------------------------------------------------------------------

  _computeGeneral(backtestSignals, historyRecords) {
    const totalBacktest = backtestSignals.length;
    const totalHistory = historyRecords.length;

    const bullish = backtestSignals.filter(s => s.overallBias === 'Bullish').length;
    const bearish = backtestSignals.filter(s => s.overallBias === 'Bearish').length;
    const neutral = backtestSignals.filter(s => s.outcome === 'neutral').length;

    // Signal history bias distribution
    const historyBias = { Bullish: 0, Bearish: 0, Neutral: 0 };
    for (const r of historyRecords) {
      const bias = r.confluence?.bias || r.mtf?.overallBias || null;
      if (bias && historyBias[bias] !== undefined) {
        historyBias[bias]++;
      }
    }

    return {
      totalSignals: totalBacktest,
      bullishSignals: bullish,
      bearishSignals: bearish,
      neutralSignals: neutral,
      signalHistoryRecords: totalHistory,
      signalHistoryBias: historyBias,
    };
  }

  // ---------------------------------------------------------------------------
  // Accuracy Metrics
  // ---------------------------------------------------------------------------

  _computeAccuracy(signals) {
    if (signals.length === 0) {
      return {
        overall: 0,
        byTimeframe: {},
        byConfidenceRange: {},
        byIndicatorAgreement: {},
      };
    }

    const overall = this._accuracyRate(signals);

    // Accuracy by timeframe
    const byTimeframe = {};
    const tfGroups = this._groupBy(signals, 'timeframe');
    for (const [tf, tfSignals] of Object.entries(tfGroups)) {
      byTimeframe[tf] = {
        total: tfSignals.length,
        correct: tfSignals.filter(s => s.outcome === 'correct').length,
        incorrect: tfSignals.filter(s => s.outcome === 'incorrect').length,
        neutral: tfSignals.filter(s => s.outcome === 'neutral').length,
        accuracy: this._accuracyRate(tfSignals),
      };
    }

    // Accuracy by confidence range
    const ranges = [
      { label: '0-20', min: 0, max: 20 },
      { label: '20-40', min: 20, max: 40 },
      { label: '40-60', min: 40, max: 60 },
      { label: '60-80', min: 60, max: 80 },
      { label: '80-100', min: 80, max: 101 },
    ];

    const byConfidenceRange = {};
    for (const range of ranges) {
      const inRange = signals.filter(s => s.confidence >= range.min && s.confidence < range.max);
      if (inRange.length > 0) {
        byConfidenceRange[range.label] = {
          total: inRange.length,
          correct: inRange.filter(s => s.outcome === 'correct').length,
          accuracy: this._accuracyRate(inRange),
          avgConfidence: this._avg(inRange.map(s => s.confidence)),
        };
      }
    }

    // Accuracy by bias direction
    const byDirection = {};
    for (const dir of ['Bullish', 'Bearish']) {
      const dirSignals = signals.filter(s => s.overallBias === dir);
      if (dirSignals.length > 0) {
        byDirection[dir] = {
          total: dirSignals.length,
          correct: dirSignals.filter(s => s.outcome === 'correct').length,
          accuracy: this._accuracyRate(dirSignals),
        };
      }
    }

    return {
      overall,
      byTimeframe,
      byConfidenceRange,
      byDirection,
    };
  }

  // ---------------------------------------------------------------------------
  // Risk Metrics
  // ---------------------------------------------------------------------------

  _computeRisk(signals) {
    if (signals.length === 0) {
      return {
        consecutiveWins: 0,
        consecutiveLosses: 0,
        maxConsecutiveWins: 0,
        maxConsecutiveLosses: 0,
        averageSignalDuration: 0,
        maximumDrawdown: 0,
        bestTimeframe: null,
        worstTimeframe: null,
      };
    }

    // Consecutive wins/losses
    let currentWinStreak = 0;
    let currentLossStreak = 0;
    let maxWinStreak = 0;
    let maxLossStreak = 0;

    for (const signal of signals) {
      if (signal.outcome === 'correct') {
        currentWinStreak++;
        currentLossStreak = 0;
      } else if (signal.outcome === 'incorrect') {
        currentLossStreak++;
        currentWinStreak = 0;
      } else {
        currentWinStreak = 0;
        currentLossStreak = 0;
      }
      maxWinStreak = Math.max(maxWinStreak, currentWinStreak);
      maxLossStreak = Math.max(maxLossStreak, currentLossStreak);
    }

    // Average signal duration — time between consecutive signals
    let totalDuration = 0;
    let durationCount = 0;
    for (let i = 1; i < signals.length; i++) {
      const prev = new Date(signals[i - 1].timestamp).getTime();
      const curr = new Date(signals[i].timestamp).getTime();
      if (!isNaN(prev) && !isNaN(curr)) {
        totalDuration += curr - prev;
        durationCount++;
      }
    }
    const avgDurationMs = durationCount > 0 ? totalDuration / durationCount : 0;

    // Maximum drawdown from equity curve
    const maxDrawdown = this._computeMaxDrawdown(signals);

    // Best/worst timeframe by accuracy
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
    let bestAcc = -1;
    let worstAcc = 101;

    for (const [tf, stat] of Object.entries(tfStats)) {
      const acc = stat.total > 0 ? (stat.correct / stat.total) * 100 : 0;
      if (acc > bestAcc || (acc === bestAcc && stat.total > (tfStats[bestTimeframe]?.total || 0))) {
        bestAcc = acc;
        bestTimeframe = tf;
      }
      if (acc < worstAcc || (acc === worstAcc && stat.total > (tfStats[worstTimeframe]?.total || 0))) {
        worstAcc = acc;
        worstTimeframe = tf;
      }
    }

    return {
      consecutiveWins: currentWinStreak,
      consecutiveLosses: currentLossStreak,
      maxConsecutiveWins: maxWinStreak,
      maxConsecutiveLosses: maxLossStreak,
      averageSignalDuration: Math.round(avgDurationMs),
      maximumDrawdown: this._round(maxDrawdown),
      bestTimeframe,
      worstTimeframe,
    };
  }

  // ---------------------------------------------------------------------------
  // Confidence Metrics
  // ---------------------------------------------------------------------------

  _computeConfidence(signals) {
    if (signals.length === 0) {
      return {
        averageConfidence: 0,
        distribution: {},
        vsAccuracy: {},
      };
    }

    const avgConfidence = this._avg(signals.map(s => s.confidence));

    // Confidence distribution (buckets of 10)
    const distribution = {};
    for (let bucket = 0; bucket < 100; bucket += 10) {
      const label = `${bucket}-${bucket + 10}`;
      const inBucket = signals.filter(s => s.confidence >= bucket && s.confidence < bucket + 10);
      if (inBucket.length > 0) {
        distribution[label] = inBucket.length;
      }
    }

    // Confidence vs accuracy — for each confidence bucket, compute actual accuracy
    const vsAccuracy = {};
    const buckets = [
      { label: '0-25', min: 0, max: 25 },
      { label: '25-50', min: 25, max: 50 },
      { label: '50-75', min: 50, max: 75 },
      { label: '75-100', min: 75, max: 101 },
    ];

    for (const bucket of buckets) {
      const inBucket = signals.filter(s => s.confidence >= bucket.min && s.confidence < bucket.max);
      if (inBucket.length > 0) {
        vsAccuracy[bucket.label] = {
          count: inBucket.length,
          avgConfidence: this._avg(inBucket.map(s => s.confidence)),
          actualAccuracy: this._accuracyRate(inBucket),
        };
      }
    }

    return {
      averageConfidence: this._round(avgConfidence),
      distribution,
      vsAccuracy,
    };
  }

  // ---------------------------------------------------------------------------
  // Performance Metrics
  // ---------------------------------------------------------------------------

  _computePerformance(signals, backtestResult) {
    if (signals.length === 0) {
      return {
        winRate: 0,
        lossRate: 0,
        neutralRate: 0,
        signalFrequency: 0,
      };
    }

    const correct = signals.filter(s => s.outcome === 'correct').length;
    const incorrect = signals.filter(s => s.outcome === 'incorrect').length;
    const neutral = signals.filter(s => s.outcome === 'neutral').length;

    const winRate = this._round((correct / signals.length) * 100);
    const lossRate = this._round((incorrect / signals.length) * 100);
    const neutralRate = this._round((neutral / signals.length) * 100);

    // Signal frequency — signals per total candles analyzed
    let signalFrequency = 0;
    if (backtestResult && backtestResult.totalCandles > 0 && backtestResult.warmupCandles) {
      const analyzedCandles = backtestResult.totalCandles - backtestResult.warmupCandles - (backtestResult.predictionCandles || 5);
      if (analyzedCandles > 0) {
        signalFrequency = this._round((signals.length / analyzedCandles) * 100);
      }
    }

    return {
      winRate,
      lossRate,
      neutralRate,
      signalFrequency,
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  _accuracyRate(signals) {
    const decided = signals.filter(s => s.outcome === 'correct' || s.outcome === 'incorrect');
    if (decided.length === 0) return 0;
    const correct = decided.filter(s => s.outcome === 'correct').length;
    return this._round((correct / decided.length) * 100);
  }

  _groupBy(arr, key) {
    const groups = {};
    for (const item of arr) {
      const k = item[key];
      if (!groups[k]) groups[k] = [];
      groups[k].push(item);
    }
    return groups;
  }

  _avg(values) {
    if (values.length === 0) return 0;
    return values.reduce((a, b) => a + b, 0) / values.length;
  }

  _round(value) {
    return Math.round(value * 100) / 100;
  }

  /**
   * Compute maximum drawdown from an equity curve built from signal outcomes.
   * Each correct signal adds +1%, each incorrect -1%.
   */
  _computeMaxDrawdown(signals) {
    if (signals.length === 0) return 0;

    let equity = 100;
    let peak = 100;
    let maxDrawdown = 0;

    for (const signal of signals) {
      if (signal.outcome === 'correct') {
        equity *= 1.01;
      } else if (signal.outcome === 'incorrect') {
        equity *= 0.99;
      }
      if (equity > peak) peak = equity;
      const drawdown = ((peak - equity) / peak) * 100;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }

    return maxDrawdown;
  }
}

module.exports = { AnalyticsEngine, ENGINE_VERSION, DEFAULT_SYMBOL };
