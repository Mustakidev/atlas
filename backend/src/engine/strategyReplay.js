/**
 * Strategy Replay Engine
 *
 * Replays historical candles through the complete execution pipeline
 * without modifying any production engine state. Measures and reports
 * strategy performance with full trade and rejection history.
 *
 * Uses the EXACT same logic as the live pipeline:
 *   1. Confluence bias check (Bullish/Bearish → signal)
 *   2. Risk Engine evaluation (confidence, volatility, ATR levels)
 *   3. PaperTrading weighted-vote analysis (direction + confidence gate)
 *   4. Trade lifecycle (SL/TP via candle high/low)
 *
 * Never modifies existing engines. Consumes only.
 *
 * Version: 1.0.0
 * Data Source: Historical OHLCV candles (replay context)
 */
const ENGINE_VERSION = '1.0.0';
const DEFAULT_SYMBOL = 'BTCUSDT';
const DEFAULT_WARMUP = 50;
const BULLISH_THRESHOLD = 65;
const BEARISH_THRESHOLD = 35;

const { ConfluenceEngine } = require('./confluence');
const { StructureEngine } = require('./structure');
const { MACDEngine } = require('./macd');
const { ATREngine } = require('./atr');
const { BollingerEngine } = require('./bollinger');
const { AdvanceRiskEngine } = require('./advanceRisk');
const { RegimeEngine } = require('../market-regime/RegimeEngine');
const { RegimeDecisionEngine } = require('../market-regime/RegimeDecisionEngine');
const { MTFConfirmationEngine } = require('./mtfConfirmation');

class StrategyReplayEngine {
  constructor({ logger, symbol, config, advanceRiskEngine, riskPolicySource, mtfConfirmationEngine }) {
    this.logger = logger;
    this.symbol = symbol || DEFAULT_SYMBOL;
    this.config = config;
    this.version = ENGINE_VERSION;
    this.lastUpdated = null;
    this.calculationTime = 0;
    this.dataSource = 'Historical OHLCV candles (strategy replay)';
    this._bullishThreshold = config?.get?.('CONFLUENCE_BULLISH_THRESHOLD') || BULLISH_THRESHOLD;
    this._bearishThreshold = config?.get?.('CONFLUENCE_BEARISH_THRESHOLD') || BEARISH_THRESHOLD;
    this._riskPolicySource = riskPolicySource || advanceRiskEngine || null;
  }

  setRegimeEngine() {
    // Replay creates regime dependencies from the replay candles per step.
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  run(candles, timeframe) {
    const start = Date.now();
    const tf = timeframe || '1h';

    if (!candles || !Array.isArray(candles) || candles.length === 0) {
      return this._emptyResult(tf, 'No candle data provided');
    }

    if (candles.length < DEFAULT_WARMUP + 1) {
      return this._emptyResult(tf, `Insufficient candles (${candles.length}/${DEFAULT_WARMUP + 1} minimum)`);
    }

    const trades = [];
    const rejections = [];
    const regimeHistory = [];
    const { advanceRiskEngine, mtfConfirmationEngine } = this._createReplayDependencies();
    let tradeCounter = 0;
    let openTrade = null;

    for (let i = DEFAULT_WARMUP; i < candles.length; i++) {
      const window = candles.slice(0, i + 1);
      const candle = candles[i];
      const price = candle.close;

      if (openTrade) {
        const closedBySL = this._checkSL(openTrade, candle);
        const closedByTP = !closedBySL ? this._checkTP(openTrade, candle) : null;

        if (closedBySL) {
          this._finalizeTrade(openTrade, {
            exit: closedBySL.exit,
            exitTime: candle.timestamp,
            exitReason: 'Stop Loss',
            win: false,
            duration: i - openTrade.entryIndex,
          }, advanceRiskEngine, trades);
          openTrade = null;
          continue;
        }

        if (closedByTP) {
          this._finalizeTrade(openTrade, {
            exit: closedByTP.exit,
            exitTime: candle.timestamp,
            exitReason: 'Take Profit',
            win: true,
            duration: i - openTrade.entryIndex,
          }, advanceRiskEngine, trades);
          openTrade = null;
          continue;
        }
      }

      if (openTrade) continue;

      const marketRegime = this._runMarketRegime(window, tf);
      regimeHistory.push({
        timestamp: candle.timestamp,
        regime: marketRegime.regime,
        confidence: marketRegime.confidence,
        trendScore: marketRegime.trendScore,
        rangeScore: marketRegime.rangeScore,
        volatility: marketRegime.volatility,
      });

      const confluence = this._runConfluence(window, tf);

      if (!confluence.score && confluence.score !== 0) {
        rejections.push({ timestamp: candle.timestamp, reason: 'Confluence calculation failed', score: null, bias: 'Neutral', direction: null });
        continue;
      }

      let signalDirection = null;
      if (confluence.bias === 'Bullish') signalDirection = 'BUY';
      else if (confluence.bias === 'Bearish') signalDirection = 'SELL';

      if (!signalDirection) {
        rejections.push({
          timestamp: candle.timestamp,
          reason: `Neutral bias (score ${confluence.score}, thresholds ${this._bearishThreshold}-${this._bullishThreshold})`,
          score: confluence.score,
          bias: confluence.bias,
          direction: null,
        });
        continue;
      }

      const atr = this._runATR(window, tf);
      const structureResult = this._runStructure(window);
      const analyzerOutput = this._synthesizeAnalyzer(window);

      const riskResult = advanceRiskEngine.evaluate({
        symbol: this.symbol,
        timeframe: tf,
        entryPrice: price,
        atr: atr || { ready: false, atr: null, atrPercentage: 0 },
        direction: signalDirection,
        trend: analyzerOutput,
        structure: structureResult,
        confluence,
        regime: marketRegime.regime,
      });

      if (!riskResult.tradeAllowed) {
        rejections.push({
          timestamp: candle.timestamp,
          reason: `Risk Engine: ${riskResult.rejectionReason}`,
          score: confluence.score,
          bias: confluence.bias,
          direction: signalDirection,
        });
        continue;
      }

      // MTF Confirmation check
      if (mtfConfirmationEngine && signalDirection) {
        const mtfTimeframes = {};
        const mtfTFs = ['1m', '5m', '15m', '1h'];
        for (const mtfTF of mtfTFs) {
          const mtfCandles = this._getCandlesForTF(window, tf, mtfTF);
          if (mtfCandles && mtfCandles.length >= 15) {
            const mtfConf = this._runConfluence(mtfCandles, mtfTF);
            mtfTimeframes[mtfTF] = {
              confluence: { score: mtfConf.score, bias: mtfConf.bias, confidence: mtfConf.confidence },
            };
          }
        }
        const mtfResult = mtfConfirmationEngine.evaluate({
          direction: signalDirection,
          timeframe: tf,
          aggressive: false,
          timeframes: mtfTimeframes,
        });
        if (!mtfResult.mtfAllowed) {
          rejections.push({
            timestamp: candle.timestamp,
            reason: `MTF Confirmation: ${mtfResult.rejectionReason}`,
            score: confluence.score,
            bias: confluence.bias,
            direction: signalDirection,
          });
          continue;
        }
      }

      const engines = {
        trend: analyzerOutput,
        structure: structureResult,
        rsi: this._runRSI(window, tf),
        ema: this._runEMA(window, tf),
        macd: this._runMACD(window, tf),
        atr: atr,
        bollinger: this._runBollinger(window, tf),
        confluence: confluence,
        mtf: this._runMTF(window, tf, confluence, structureResult),
      };

      const analysis = this._analyzeEngines(engines, tf);

      if (analysis.direction === 'neutral') {
        rejections.push({
          timestamp: candle.timestamp,
          reason: `Engine analysis: neutral direction (buyRatio=${analysis.buyRatio?.toFixed(2)}, sellRatio=${analysis.sellRatio?.toFixed(2)})`,
          score: confluence.score,
          bias: confluence.bias,
          direction: signalDirection,
        });
        continue;
      }

      if (analysis.confidence < 30) {
        rejections.push({
          timestamp: candle.timestamp,
          reason: `Engine analysis: confidence ${analysis.confidence}% < 30% minimum`,
          score: confluence.score,
          bias: confluence.bias,
          direction: signalDirection,
        });
        continue;
      }

      tradeCounter++;
      const riskSize = riskResult.riskPerUnit;
      const levels = {
        stopLoss: riskResult.stopLoss,
        takeProfit: riskResult.takeProfit,
        riskReward: riskResult.riskReward,
      };
      const positionSize = riskResult.positionSize;

      const regimeDecision = this._runRegimeDecision(marketRegime, signalDirection, confluence.score);

      openTrade = {
        tradeId: `SR-${tradeCounter}`,
        direction: signalDirection,
        entry: this._round(price),
        entryTime: candle.timestamp,
        entryIndex: i,
        stopLoss: levels.stopLoss,
        takeProfit: levels.takeProfit,
        riskReward: levels.riskReward,
        riskSize: riskSize,
        positionSize: positionSize,
        confidence: analysis.confidence,
        score: confluence.score,
        bias: confluence.bias,
        regime: marketRegime.regime,
        regimeConfidence: marketRegime.confidence,
        regimeDecision: {
          allowTrade: regimeDecision.allowTrade,
          penalty: regimeDecision.penalty,
          preferredDirection: regimeDecision.preferredDirection,
          reason: regimeDecision.reason,
        },
        exit: null,
        exitTime: null,
        exitReason: null,
        win: null,
        duration: null,
        rMultiple: null,
        pnl: null,
        pnlPercent: null,
      };
    }

    if (openTrade) {
      const lastCandle = candles[candles.length - 1];
      const exit = this._round(lastCandle.close);
      const win = openTrade.direction === 'SELL'
        ? lastCandle.close < openTrade.entry
        : lastCandle.close > openTrade.entry;
      this._finalizeTrade(openTrade, {
        exit,
        exitTime: lastCandle.timestamp,
        exitReason: 'End of Data',
        win,
        duration: candles.length - 1 - openTrade.entryIndex,
        pnlExit: lastCandle.close,
      }, advanceRiskEngine, trades);
    }

    const stats = this._computeStats(trades, rejections);
    this.calculationTime = Date.now() - start;
    this.lastUpdated = new Date().toISOString();

    return {
      symbol: this.symbol,
      timeframe: tf,
      totalCandles: candles.length,
      candlesAnalyzed: candles.length - DEFAULT_WARMUP,
      warmup: DEFAULT_WARMUP,
      trades,
      rejections,
      regimeHistory,
      stats,
      engineVersion: this.version,
      lastUpdated: this.lastUpdated,
      calculationTime: this.calculationTime,
      dataSource: this.dataSource,
    };
  }

  getInfo() {
    return {
      name: 'StrategyReplay',
      description: 'Historical strategy replay engine — measures performance through the complete execution pipeline',
      implemented: true,
      version: this.version,
      symbol: this.symbol,
    };
  }

  _createReplayDependencies() {
    return {
      advanceRiskEngine: this._createReplayRiskEngine(),
      mtfConfirmationEngine: new MTFConfirmationEngine({
        logger: this.logger,
        symbol: this.symbol,
        config: this.config,
      }),
    };
  }

  _createReplayRiskEngine() {
    const engine = new AdvanceRiskEngine({
      logger: this.logger,
      symbol: this.symbol,
      paperTradeEngine: null,
      config: this.config,
    });
    const policy = this._riskPolicySource?.getPolicy?.();
    if (!policy) return engine;

    engine.setAccountBalance(policy.accountBalance);
    engine.setRiskPerTradePct(policy.riskPerTradePct);
    engine.setAtrMultTrending(policy.atrMultTrending);
    engine.setAtrMultRanging(policy.atrMultRanging);
    engine.setRrTrending(policy.rrTrending);
    engine.setRrRanging(policy.rrRanging);
    engine.setMaxDailyLossPct(policy.maxDailyLossPct);
    engine.setMaxDailyDrawdownPct(policy.maxDailyDrawdownPct);
    engine.setMaxConsecutiveLosses(policy.maxConsecutiveLosses);
    engine.setConsecutiveCooldownMs(policy.cooldownMs);
    for (const [session, multiplier] of Object.entries(policy.sessionMultipliers || {})) {
      engine.setSessionMultiplier(session, multiplier);
    }
    engine.resetDaily();
    return engine;
  }

  // ---------------------------------------------------------------------------
  // Engine Runners (isolated per step — zero look-ahead)
  // ---------------------------------------------------------------------------

  _runMarketRegime(candles, tf) {
    try {
      const mockIndicatorRegistry = {
        get: (name) => ({
          calculate: (c, t, p) => {
            if (name === 'EMA') return this._runEMA(c, t);
            if (name === 'RSI') return this._runRSI(c, t);
            return { ready: false };
          },
        }),
      };
      const mockCandleEngine = this._mockCandleEngine(candles, tf);
      const mockAtrEngine = {
        calculate: (t, limit) => {
          const mock = this._mockCandleEngine(candles, t);
          const { ATREngine } = require('./atr');
          const engine = new ATREngine({ candleEngine: mock, logger: this.logger, symbol: this.symbol });
          return engine.calculate(t, limit || candles.length);
        },
        getInfo: () => ({ name: 'ATR', implemented: true }),
      };
      const mockAnalyzer = { getAnalysis: () => this._synthesizeAnalyzer(candles) };
      const engine = new RegimeEngine({
        indicatorRegistry: mockIndicatorRegistry,
        atrEngine: mockAtrEngine,
        candleEngine: mockCandleEngine,
        analyzer: mockAnalyzer,
        logger: this.logger,
        config: { get: () => null },
        symbol: this.symbol,
      });
      return engine.calculate(candles, tf);
    } catch (e) {
      return { regime: 'UNKNOWN', confidence: 0, trendScore: null, rangeScore: null, volatility: null };
    }
  }

  _runRegimeDecision(marketRegime, direction, confluenceScore) {
    try {
      const engine = new RegimeDecisionEngine({ logger: this.logger, symbol: this.symbol });
      return engine.evaluate({
        regime: marketRegime.regime,
        confidence: marketRegime.confidence,
        direction,
        confluenceScore,
      });
    } catch (e) {
      return { allowTrade: true, penalty: 0, preferredDirection: direction || 'NEUTRAL', reason: 'Regime decision error' };
    }
  }

  _getCandlesForTF(candles, baseTF, targetTF) {
    if (!candles || candles.length === 0 || baseTF === targetTF) return candles;
    const higherMinutes = { '5m': 5, '15m': 15, '1h': 60, '4h': 240, '1d': 1440 };
    const baseM = higherMinutes[baseTF] || 1;
    const targetM = higherMinutes[targetTF] || 1;
    if (targetM <= baseM) return candles;
    const ratio = Math.round(targetM / baseM);
    if (ratio < 1) return candles;
    const aggregated = [];
    for (let i = ratio - 1; i < candles.length; i += ratio) {
      const chunk = candles.slice(Math.max(0, i - ratio + 1), i + 1);
      if (chunk.length === 0) continue;
      const first = chunk[0];
      const last = chunk[chunk.length - 1];
      aggregated.push({
        open: first.open,
        high: Math.max(...chunk.map(c => c.high)),
        low: Math.min(...chunk.map(c => c.low)),
        close: last.close,
        volume: chunk.reduce((s, c) => s + (c.volume || 0), 0),
        timestamp: first.timestamp,
      });
    }
    return aggregated.length > 0 ? aggregated : candles;
  }

  _runConfluence(candles, tf) {
    try {
      const mockAnalyzer = { getAnalysis: () => this._synthesizeAnalyzer(candles) };
      const mockIndicatorRegistry = {
        get: (name) => ({
          calculate: (c, t, p) => {
            if (name === 'RSI') return this._runRSI(c, t);
            if (name === 'EMA') return this._runEMA(c, t);
            return { ready: false };
          },
        }),
      };
      const mockStructureEngine = {
        calculate: (c) => this._runStructure(c),
      };
      const mockCandleEngine = {
        getAllTimeframes: () => [tf],
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
          if (key === 'CONFLUENCE_BULLISH_THRESHOLD') return this._bullishThreshold;
          if (key === 'CONFLUENCE_BEARISH_THRESHOLD') return this._bearishThreshold;
          return null;
        }},
        symbol: this.symbol,
      });
      return engine.calculate(candles, tf);
    } catch {
      return { score: null, bias: 'Neutral', confidence: 0, components: {}, missing: [] };
    }
  }

  _runStructure(candles) {
    try {
      const engine = new StructureEngine(this.logger, this.symbol);
      return engine.calculate(candles);
    } catch {
      return { ready: false, direction: null, structure: null, score: null, confidence: 0 };
    }
  }

  _runRSI(candles, tf) {
    try {
      const { IndicatorRegistry } = require('./indicators');
      const registry = new IndicatorRegistry(this.symbol);
      return registry.get('RSI').calculate(candles, tf);
    } catch {
      return { ready: false };
    }
  }

  _runEMA(candles, tf) {
    try {
      const { IndicatorRegistry } = require('./indicators');
      const registry = new IndicatorRegistry(this.symbol);
      return registry.get('EMA').calculate(candles, tf, 20);
    } catch {
      return { ready: false };
    }
  }

  _runMACD(candles, tf) {
    try {
      const mock = this._mockCandleEngine(candles, tf);
      const engine = new MACDEngine({ candleEngine: mock, logger: this.logger, symbol: this.symbol });
      return engine.calculate(tf, candles.length);
    } catch {
      return { ready: false };
    }
  }

  _runATR(candles, tf) {
    try {
      const mock = this._mockCandleEngine(candles, tf);
      const engine = new ATREngine({ candleEngine: mock, logger: this.logger, symbol: this.symbol });
      return engine.calculate(tf, candles.length);
    } catch {
      return { ready: false };
    }
  }

  _runBollinger(candles, tf) {
    try {
      const mock = this._mockCandleEngine(candles, tf);
      const engine = new BollingerEngine({ candleEngine: mock, logger: this.logger, symbol: this.symbol });
      return engine.calculate(tf, candles.length);
    } catch {
      return { ready: false };
    }
  }

  _runMTF(candles, tf, confluence, structure) {
    try {
      return {
        overallBias: confluence.bias,
        confidence: confluence.confidence,
        timeframeAgreement: confluence.score != null ? (confluence.score > 50 ? confluence.score : 100 - confluence.score) : 0,
      };
    } catch {
      return { overallBias: 'Neutral', confidence: 0 };
    }
  }

  // ---------------------------------------------------------------------------
  // PaperTrading._analyzeEngines() — exact replica of live logic
  // ---------------------------------------------------------------------------

  _analyzeEngines(engines, tf) {
    const reasons = [];
    let buyVotes = 0;
    let sellVotes = 0;
    let totalWeight = 0;

    const addVote = (weight, direction, reason) => {
      if (direction === 'neutral' || direction === null) return;
      const w = weight;
      if (direction === 'bullish' || direction === 'Bullish' || direction === 'BUY') {
        buyVotes += w;
        if (reason) reasons.push(reason);
      } else if (direction === 'bearish' || direction === 'Bearish' || direction === 'SELL') {
        sellVotes += w;
        if (reason) reasons.push(reason);
      }
      totalWeight += w;
    };

    if (engines.trend) {
      const trendDir = engines.trend.trend?.['1H'] || engines.trend.trend?.[tf] || null;
      addVote(0.20, trendDir, trendDir ? `Trend: ${trendDir}` : null);
    }

    if (engines.structure?.ready) {
      addVote(0.15, engines.structure.direction, `Structure: ${engines.structure.structure} (score: ${engines.structure.score})`);
    }

    if (engines.rsi?.ready) {
      const rsiDir = engines.rsi.value > 55 ? 'bullish' : engines.rsi.value < 45 ? 'bearish' : 'neutral';
      addVote(0.10, rsiDir, engines.rsi.state !== 'Neutral' ? `RSI: ${engines.rsi.value} (${engines.rsi.state})` : null);
    }

    if (engines.ema?.ready) {
      const emaDir = engines.ema.trend === 'Above' ? 'bullish' : engines.ema.trend === 'Below' ? 'bearish' : 'neutral';
      addVote(0.10, emaDir, engines.ema.trend !== 'Crossing' ? `EMA: ${engines.ema.trend} (${engines.ema.value})` : null);
    }

    if (engines.macd?.ready) {
      addVote(0.15, engines.macd.trend, `MACD: ${engines.macd.trend} (hist: ${engines.macd.histogram})`);
    }

    if (engines.bollinger?.ready) {
      const bbDir = engines.bollinger.pricePosition === 'Below Lower' ? 'bullish'
        : engines.bollinger.pricePosition === 'Above Upper' ? 'bearish' : 'neutral';
      addVote(0.10, bbDir, engines.bollinger.pricePosition !== 'Inside Bands' ? `Bollinger: ${engines.bollinger.pricePosition}` : null);
    }

    if (engines.confluence?.bias && engines.confluence.bias !== 'Neutral') {
      const confDir = engines.confluence.bias === 'Bullish' ? 'bullish' : 'bearish';
      addVote(0.15, confDir, `Confluence: ${engines.confluence.bias} (score: ${engines.confluence.score})`);
    }

    if (engines.mtf?.overallBias && engines.mtf.overallBias !== 'Neutral') {
      const mtfDir = engines.mtf.overallBias === 'Bullish' ? 'bullish' : 'bearish';
      addVote(0.05, mtfDir, `MTF: ${engines.mtf.overallBias} (agreement: ${engines.mtf.timeframeAgreement}%)`);
    }

    if (totalWeight === 0) {
      return { direction: 'neutral', confidence: 0, reason: '', buyRatio: 0, sellRatio: 0 };
    }

    const buyRatio = buyVotes / totalWeight;
    const sellRatio = sellVotes / totalWeight;

    let direction;
    let confidence;
    if (buyRatio > sellRatio && buyRatio >= 0.55) {
      direction = 'BUY';
      confidence = this._round(buyRatio * 100);
    } else if (sellRatio > buyRatio && sellRatio >= 0.55) {
      direction = 'SELL';
      confidence = this._round(sellRatio * 100);
    } else {
      return { direction: 'neutral', confidence: 0, reason: reasons.join('; '), buyRatio, sellRatio };
    }

    return {
      direction,
      confidence: Math.min(100, confidence),
      reason: reasons.join('; '),
      buyRatio,
      sellRatio,
    };
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

    let upCount = 0;
    for (let i = 1; i < closes.length; i++) {
      if (closes[i] > closes[i - 1]) upCount++;
    }
    momentum['1H'] = Math.round((upCount / (closes.length - 1)) * 100);

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
  // SL/TP Computation and Trade Lifecycle
  // ---------------------------------------------------------------------------

  _finalizeTrade(trade, { exit, exitTime, exitReason, win, duration, pnlExit = exit }, advanceRiskEngine, trades) {
    trade.exit = exit;
    trade.exitTime = exitTime;
    trade.exitReason = exitReason;
    trade.win = win;
    trade.duration = duration;
    trade.rMultiple = this._round(this._directionPnL(trade.direction, pnlExit, trade.entry) / trade.riskSize);
    trade.pnl = this._round((trade.direction === 'BUY'
      ? pnlExit - trade.entry
      : trade.entry - pnlExit) * trade.positionSize);
    trade.pnlPercent = this._round(((pnlExit - trade.entry) / trade.entry) * 100 * (trade.direction === 'BUY' ? 1 : -1));

    const finalizedPnl = trade.pnl;
    trades.push({ ...trade });
    advanceRiskEngine.onTradeClosed(finalizedPnl);
  }

  _computeLevels(price, direction, atr) {
    const atrValue = atr?.ready ? atr.atr : null;
    const mult = 2;

    let stopLoss, takeProfit;

    if (direction === 'BUY') {
      stopLoss = atrValue ? price - (atrValue * mult) : price * 0.97;
      takeProfit = atrValue ? price + (atrValue * mult * 1.5) : price * 1.04;
    } else {
      stopLoss = atrValue ? price + (atrValue * mult) : price * 1.03;
      takeProfit = atrValue ? price - (atrValue * mult * 1.5) : price * 0.96;
    }

    const risk = Math.abs(price - stopLoss);
    const reward = Math.abs(takeProfit - price);
    const riskReward = risk > 0 ? this._round(reward / risk) : 0;

    return { stopLoss: this._round(stopLoss), takeProfit: this._round(takeProfit), riskReward };
  }

  _checkSL(trade, candle) {
    if (trade.direction === 'BUY') {
      if (candle.low <= trade.stopLoss) {
        return { exit: trade.stopLoss };
      }
    } else {
      if (candle.high >= trade.stopLoss) {
        return { exit: trade.stopLoss };
      }
    }
    return null;
  }

  _checkTP(trade, candle) {
    if (trade.direction === 'BUY') {
      if (candle.high >= trade.takeProfit) {
        return { exit: trade.takeProfit };
      }
    } else {
      if (candle.low <= trade.takeProfit) {
        return { exit: trade.takeProfit };
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Statistics
  // ---------------------------------------------------------------------------

  _computeStats(trades, rejections) {
    if (trades.length === 0) {
      return {
        totalTrades: 0, wins: 0, losses: 0, winRate: 0,
        profitFactor: 0, expectancy: 0, averageR: 0,
        maxDrawdown: 0, maxDrawdownPct: 0,
        grossProfit: 0, grossLoss: 0, netPnl: 0,
        longs: { total: 0, wins: 0, losses: 0, winRate: 0, avgR: 0 },
        shorts: { total: 0, wins: 0, losses: 0, winRate: 0, avgR: 0 },
        maxConsecutiveWins: 0, maxConsecutiveLosses: 0,
        averageDuration: 0,
        totalRejections: rejections.length,
        rejectionBreakdown: this._rejectionBreakdown(rejections),
        regime: { byRegime: {}, winRateByRegime: {} },
      };
    }

    const wins = trades.filter(t => t.win);
    const losses = trades.filter(t => !t.win);
    const winRate = (wins.length / trades.length) * 100;

    const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
    const netPnl = grossProfit - grossLoss;
    const expectancy = trades.length > 0 ? netPnl / trades.length : 0;

    const avgR = trades.length > 0
      ? this._round(trades.reduce((s, t) => s + (t.rMultiple || 0), 0) / trades.length)
      : 0;

    const longs = trades.filter(t => t.direction === 'BUY');
    const shorts = trades.filter(t => t.direction === 'SELL');

    const longWins = longs.filter(t => t.win);
    const shortWins = shorts.filter(t => t.win);

    const maxDD = this._computeDrawdown(trades);
    const streaks = this._computeStreaks(trades);

    const avgDuration = trades.reduce((s, t) => s + (t.duration || 0), 0) / trades.length;

    const byRegime = {};
    for (const t of trades) {
      const r = t.regime || 'UNKNOWN';
      if (!byRegime[r]) byRegime[r] = { total: 0, wins: 0, losses: 0 };
      byRegime[r].total++;
      if (t.win) byRegime[r].wins++;
      else byRegime[r].losses++;
    }
    const winRateByRegime = {};
    for (const [r, d] of Object.entries(byRegime)) {
      winRateByRegime[r] = d.total > 0 ? this._round((d.wins / d.total) * 100) : 0;
    }

    return {
      totalTrades: trades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: this._round(winRate),
      profitFactor: profitFactor === Infinity ? 'Infinity' : this._round(profitFactor),
      expectancy: this._round(expectancy),
      averageR: avgR,
      maxDrawdown: this._round(maxDD.maxDrawdown),
      maxDrawdownPct: this._round(maxDD.maxDrawdownPct),
      grossProfit: this._round(grossProfit),
      grossLoss: this._round(grossLoss),
      netPnl: this._round(netPnl),
      longs: {
        total: longs.length,
        wins: longWins.length,
        losses: longs.length - longWins.length,
        winRate: longs.length > 0 ? this._round((longWins.length / longs.length) * 100) : 0,
        avgR: longs.length > 0 ? this._round(longs.reduce((s, t) => s + (t.rMultiple || 0), 0) / longs.length) : 0,
      },
      shorts: {
        total: shorts.length,
        wins: shortWins.length,
        losses: shorts.length - shortWins.length,
        winRate: shorts.length > 0 ? this._round((shortWins.length / shorts.length) * 100) : 0,
        avgR: shorts.length > 0 ? this._round(shorts.reduce((s, t) => s + (t.rMultiple || 0), 0) / shorts.length) : 0,
      },
      maxConsecutiveWins: streaks.maxWins,
      maxConsecutiveLosses: streaks.maxLosses,
      averageDuration: Math.round(avgDuration),
      totalRejections: rejections.length,
      rejectionBreakdown: this._rejectionBreakdown(rejections),
      regime: { byRegime, winRateByRegime },
    };
  }

  _computeDrawdown(trades) {
    let equity = 0;
    let peak = 0;
    let maxDrawdown = 0;
    let maxDrawdownPct = 0;

    for (const t of trades) {
      equity += t.pnl;
      if (equity > peak) peak = equity;
      const dd = peak - equity;
      const ddPct = peak > 0 ? (dd / peak) * 100 : 0;
      if (dd > maxDrawdown) maxDrawdown = dd;
      if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;
    }

    return { maxDrawdown, maxDrawdownPct };
  }

  _computeStreaks(trades) {
    let maxWins = 0, maxLosses = 0;
    let curWins = 0, curLosses = 0;

    for (const t of trades) {
      if (t.win) {
        curWins++;
        curLosses = 0;
        if (curWins > maxWins) maxWins = curWins;
      } else {
        curLosses++;
        curWins = 0;
        if (curLosses > maxLosses) maxLosses = curLosses;
      }
    }

    return { maxWins, maxLosses };
  }

  _rejectionBreakdown(rejections) {
    const breakdown = {};
    for (const r of rejections) {
      const key = r.reason.split(':')[0] || 'Unknown';
      if (!breakdown[key]) breakdown[key] = 0;
      breakdown[key]++;
    }
    return breakdown;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  _mockCandleEngine(candles, tf) {
    return {
      getCandles: (t, limit) => {
        const result = [...candles];
        if (limit && limit > 0) return result.slice(-limit);
        return result;
      },
      getActive: () => null,
      getAllTimeframes: () => [tf],
    };
  }

  _directionPnL(direction, exit, entry) {
    return direction === 'SELL' ? entry - exit : exit - entry;
  }

  _round(value) {
    return Math.round(value * 100) / 100;
  }

  _emptyResult(tf, reason) {
    return {
      symbol: this.symbol,
      timeframe: tf,
      totalCandles: 0,
      candlesAnalyzed: 0,
      warmup: DEFAULT_WARMUP,
      trades: [],
      rejections: [],
      stats: {
        totalTrades: 0, wins: 0, losses: 0, winRate: 0,
        profitFactor: 0, expectancy: 0, averageR: 0,
        maxDrawdown: 0, maxDrawdownPct: 0,
        grossProfit: 0, grossLoss: 0, netPnl: 0,
        longs: { total: 0, wins: 0, losses: 0, winRate: 0, avgR: 0 },
        shorts: { total: 0, wins: 0, losses: 0, winRate: 0, avgR: 0 },
        maxConsecutiveWins: 0, maxConsecutiveLosses: 0,
        averageDuration: 0,
        totalRejections: 0, rejectionBreakdown: {},
      },
      reason,
      engineVersion: this.version,
      lastUpdated: new Date().toISOString(),
      calculationTime: this.calculationTime,
      dataSource: this.dataSource,
    };
  }
}

module.exports = { StrategyReplayEngine, ENGINE_VERSION, DEFAULT_WARMUP };
