/**
 * Paper Trading Engine v2.0
 *
 * Professional institutional paper-trading engine with full trade lifecycle,
 * automatic trade management, and comprehensive performance analytics.
 *
 * Lifecycle: PENDING → OPEN → ACTIVE → CLOSED
 *
 * Consumes outputs from Trend, RSI, EMA, MACD, ATR, Bollinger, Structure,
 * Confluence, MTF, and Analytics engines.
 *
 * Never connects to any exchange. Never executes real orders.
 *
 * Version: 2.0.0
 * Data Source: Production engine outputs (consumed only)
 */
const {
  elapsedMs,
  formatTimestamp,
  readMonotonicMs,
  resolveClock,
  resolveCycleNowMs,
} = require('../core/clock');
const ENGINE_VERSION = '2.0.0';
const DEFAULT_SYMBOL = 'BTCUSDT';
const DEFAULT_MAX_TRADES = 500;
const INITIAL_BALANCE = 10000;
const RISK_PER_TRADE_PCT = 1;

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

const TRADE_STATES = {
  PENDING: 'PENDING',
  OPEN: 'OPEN',
  ACTIVE: 'ACTIVE',
  CLOSED: 'CLOSED',
};

const EXIT_REASONS = {
  TAKE_PROFIT: 'Take Profit',
  STOP_LOSS: 'Stop Loss',
  MANUAL: 'Manual',
  INVALIDATED: 'Invalidated',
};

class PaperTradingEngine {
  constructor({ logger, symbol, clock }) {
    this.logger = logger;
    this.symbol = symbol || DEFAULT_SYMBOL;
    this.clock = resolveClock(clock);
    this.version = ENGINE_VERSION;
    this.lastUpdated = null;
    this.calculationTime = 0;
    this.dataSource = 'Production engine outputs (consumed only)';

    this._trades = [];
    this._closedTrades = [];
    this._maxTrades = DEFAULT_MAX_TRADES;
    this._tradeCounter = 0;
    this._lastPrice = null;
    this._balance = INITIAL_BALANCE;
    this._initialBalance = INITIAL_BALANCE;
    this._peakEquity = INITIAL_BALANCE;
    this._closedIds = new Set();
  }

  // ---------------------------------------------------------------------------
  // Public API — Signal Processing
  // ---------------------------------------------------------------------------

  signal(engines, currentPrice, timeframe, pipelineDirection, executionPlan, context = {}) {
    const nowMs = resolveCycleNowMs(this.clock, context?.nowMs);
    const start = readMonotonicMs(this.clock);

    if (currentPrice == null || currentPrice <= 0) {
      this.calculationTime = elapsedMs(this.clock, start);
      return null;
    }

    this._lastPrice = currentPrice;
    const tf = timeframe || '1h';

    const analysis = this._analyzeEngines(engines, tf);
    this._lastAnalysis = analysis;

    let executionDirection;
    if (pipelineDirection === 'BUY' || pipelineDirection === 'SELL') {
      executionDirection = pipelineDirection;
    } else {
      executionDirection = analysis.direction;
    }

    if (executionDirection === 'neutral') {
      this.calculationTime = elapsedMs(this.clock, start);
      return null;
    }

    if (!pipelineDirection && analysis.confidence < 30) {
      this.calculationTime = elapsedMs(this.clock, start);
      return null;
    }

    let stopLoss;
    let takeProfit;
    let riskReward;
    let positionSize;

    if (executionPlan !== undefined) {
      if (!this._isValidExecutionPlan(executionPlan, currentPrice, executionDirection)) {
        this.calculationTime = elapsedMs(this.clock, start);
        return null;
      }
      ({ stopLoss, takeProfit, riskReward, positionSize } = executionPlan);
    } else {
      ({ stopLoss, takeProfit } = this._computeLevels(
        currentPrice, executionDirection, engines.atr, engines.bollinger
      ));

      const risk = Math.abs(currentPrice - stopLoss);
      const reward = Math.abs(takeProfit - currentPrice);
      riskReward = risk > 0 ? this._round(reward / risk) : 0;
      const riskAmount = this._balance * (RISK_PER_TRADE_PCT / 100);
      positionSize = risk > 0 ? this._round(riskAmount / risk) : 0;
    }

    const trade = this._openTrade({
      symbol: this.symbol,
      timeframe: tf,
      direction: executionDirection,
      entryPrice: this._round(currentPrice),
      entryTime: formatTimestamp(nowMs),
      stopLoss: executionPlan === undefined ? this._round(stopLoss) : stopLoss,
      takeProfit: executionPlan === undefined ? this._round(takeProfit) : takeProfit,
      riskReward,
      positionSize,
      currentPrice: this._round(currentPrice),
      confidence: analysis.confidence,
      reason: analysis.reason,
      status: TRADE_STATES.OPEN,
    }, context);

    this.lastUpdated = formatTimestamp(nowMs);
    this.calculationTime = elapsedMs(this.clock, start);
    return this._copyTrade(trade);
  }

  _isValidExecutionPlan(plan, entryPrice, direction) {
    if (!plan || !['stopLoss', 'takeProfit', 'positionSize', 'riskReward'].every(key => isFiniteNumber(plan[key]))) {
      return false;
    }
    if (plan.positionSize <= 0 || plan.riskReward <= 0) return false;
    if (direction === 'BUY') return plan.stopLoss < entryPrice && entryPrice < plan.takeProfit;
    if (direction === 'SELL') return plan.takeProfit < entryPrice && entryPrice < plan.stopLoss;
    return false;
  }

  // ---------------------------------------------------------------------------
  // Public API — Automatic Trade Management (Phase 2)
  // ---------------------------------------------------------------------------

  onCandle(candle, context = {}) {
    if (!candle) return { opened: [], closed: [] };

    const openTrades = this._trades.filter(t => t.status === TRADE_STATES.OPEN || t.status === TRADE_STATES.ACTIVE);
    const closed = [];

    for (const trade of openTrades) {
      if (trade.status === TRADE_STATES.OPEN) {
        this._updateTradeState(trade, TRADE_STATES.ACTIVE);
      }

      trade.currentPrice = this._round(candle.close);

      const high = candle.high;
      const low = candle.low;

      let hitTP = false;
      let hitSL = false;

      if (trade.direction === 'BUY') {
        hitTP = high >= trade.takeProfit;
        hitSL = low <= trade.stopLoss;
      } else {
        hitTP = low <= trade.takeProfit;
        hitSL = high >= trade.stopLoss;
      }

      if (hitSL && hitTP) {
        if (trade.direction === 'BUY') {
          hitTP = trade.takeProfit - trade.entryPrice >= trade.entryPrice - trade.stopLoss;
          hitSL = !hitTP;
        } else {
          hitTP = trade.entryPrice - trade.takeProfit >= trade.stopLoss - trade.entryPrice;
          hitSL = !hitTP;
        }
      }

      if (hitSL) {
        const closedTrade = this._closeTrade(trade, trade.stopLoss, EXIT_REASONS.STOP_LOSS, context);
        if (closedTrade) closed.push(closedTrade);
      } else if (hitTP) {
        const closedTrade = this._closeTrade(trade, trade.takeProfit, EXIT_REASONS.TAKE_PROFIT, context);
        if (closedTrade) closed.push(closedTrade);
      }
    }

    return { opened: [], closed: this._copyTrades(closed) };
  }

  close(tradeId, reason, context = {}) {
    const trade = this._trades.find(t => t.tradeId === tradeId);
    if (!trade) return null;
    if (trade.status === TRADE_STATES.CLOSED) return null;

    const price = this._lastPrice || trade.currentPrice || trade.entryPrice;
    return this._copyTrade(this._closeTrade(trade, price, reason || EXIT_REASONS.MANUAL, context));
  }

  invalidate(tradeId, context = {}) {
    const trade = this._trades.find(t => t.tradeId === tradeId);
    if (!trade) return null;
    if (trade.status === TRADE_STATES.CLOSED) return null;

    return this._copyTrade(this._closeTrade(trade, trade.entryPrice, EXIT_REASONS.INVALIDATED, context));
  }

  evaluateTrades(currentPrice, context = {}) {
    if (currentPrice == null || currentPrice <= 0) return [];
    this._lastPrice = currentPrice;
    const closed = [];

    for (const trade of this._trades) {
      if (trade.status !== TRADE_STATES.OPEN && trade.status !== TRADE_STATES.ACTIVE) continue;

      trade.currentPrice = this._round(currentPrice);

      const hitStopLoss = trade.direction === 'BUY'
        ? currentPrice <= trade.stopLoss
        : currentPrice >= trade.stopLoss;

      const hitTakeProfit = trade.direction === 'BUY'
        ? currentPrice >= trade.takeProfit
        : currentPrice <= trade.takeProfit;

      if (hitStopLoss) {
        const closedTrade = this._closeTrade(trade, currentPrice, EXIT_REASONS.STOP_LOSS, context);
        if (closedTrade) closed.push(closedTrade);
      } else if (hitTakeProfit) {
        const closedTrade = this._closeTrade(trade, currentPrice, EXIT_REASONS.TAKE_PROFIT, context);
        if (closedTrade) closed.push(closedTrade);
      }
    }

    return this._copyTrades(closed);
  }

  // ---------------------------------------------------------------------------
  // Public API — Queries
  // ---------------------------------------------------------------------------

  all() {
    return this._copyTrades(this._trades);
  }

  open() {
    return this._copyTrades(this._trades.filter(t => t.status === TRADE_STATES.OPEN || t.status === TRADE_STATES.ACTIVE));
  }

  pending() {
    return this._copyTrades(this._trades.filter(t => t.status === TRADE_STATES.PENDING));
  }

  closed() {
    return this._copyTrades(this._closedTrades);
  }

  history(limit) {
    if (limit && limit > 0) return this._copyTrades(this._closedTrades.slice(-limit));
    return this._copyTrades(this._closedTrades);
  }

  getTrade(tradeId) {
    return this._copyTrade(this._trades.find(t => t.tradeId === tradeId) || null);
  }

  getBalance() {
    return this._balance;
  }

  // ---------------------------------------------------------------------------
  // Public API — Statistics (Phase 3 + 4)
  // ---------------------------------------------------------------------------

  stats() {
    const allTrades = this._trades;
    const open = this._trades.filter(t => t.status === TRADE_STATES.OPEN || t.status === TRADE_STATES.ACTIVE);
    const closed = this._closedTrades;

    if (closed.length === 0) {
      return this._emptyStats(allTrades, open);
    }

    const wins = closed.filter(t => t.pnl > 0);
    const losses = closed.filter(t => t.pnl < 0);
    const breakeven = closed.filter(t => t.pnl === 0);
    const totalPnl = closed.reduce((s, t) => s + t.pnl, 0);
    const totalPnlPercent = closed.reduce((s, t) => s + t.pnlPercent, 0);
    const totalDuration = closed.reduce((s, t) => s + (t.duration || 0), 0);
    const totalRisk = closed.reduce((s, t) => s + Math.abs(t.pnl), 0);
    const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));

    let bestTrade = closed[0];
    let worstTrade = closed[0];
    for (const t of closed) {
      if (t.pnlPercent > bestTrade.pnlPercent) bestTrade = t;
      if (t.pnlPercent < worstTrade.pnlPercent) worstTrade = t;
    }

    const avgWin = wins.length > 0 ? grossProfit / wins.length : 0;
    const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0;

    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
    const expectancy = closed.length > 0 ? totalPnl / closed.length : 0;
    const winRate = (wins.length / closed.length) * 100;
    const rewardRisk = avgLoss > 0 ? avgWin / avgLoss : 0;
    const expectancyRatio = rewardRisk > 0 ? (winRate / 100) * rewardRisk - (1 - winRate / 100) : 0;

    const { maxDrawdown, maxDrawdownPct } = this._computeDrawdown(closed);
    const { maxConsecutiveWins, maxConsecutiveLosses, currentStreak, currentStreakType } = this._computeStreaks(closed);

    const avgDuration = totalDuration / closed.length;

    const byDirection = {};
    for (const dir of ['BUY', 'SELL']) {
      const dirTrades = closed.filter(t => t.direction === dir);
      const dirWins = dirTrades.filter(t => t.pnl > 0);
      byDirection[dir] = {
        total: dirTrades.length,
        wins: dirWins.length,
        losses: dirTrades.filter(t => t.pnl < 0).length,
        winRate: dirTrades.length > 0 ? this._round((dirWins.length / dirTrades.length) * 100) : 0,
        totalPnl: this._round(dirTrades.reduce((s, t) => s + t.pnl, 0)),
      };
    }

    const byTimeframe = {};
    for (const t of closed) {
      if (!byTimeframe[t.timeframe]) {
        byTimeframe[t.timeframe] = { total: 0, wins: 0, losses: 0, totalPnl: 0 };
      }
      byTimeframe[t.timeframe].total++;
      if (t.pnl > 0) byTimeframe[t.timeframe].wins++;
      if (t.pnl < 0) byTimeframe[t.timeframe].losses++;
      byTimeframe[t.timeframe].totalPnl += t.pnl;
    }

    const byExitReason = {};
    for (const t of closed) {
      const r = t.exitReason || 'Unknown';
      if (!byExitReason[r]) byExitReason[r] = { count: 0, totalPnl: 0 };
      byExitReason[r].count++;
      byExitReason[r].totalPnl += t.pnl;
    }

    for (const tf of Object.keys(byTimeframe)) {
      byTimeframe[tf].totalPnl = this._round(byTimeframe[tf].totalPnl);
    }
    for (const r of Object.keys(byExitReason)) {
      byExitReason[r].totalPnl = this._round(byExitReason[r].totalPnl);
    }

    return {
      totalTrades: allTrades.length,
      openTrades: open.length,
      closedTrades: closed.length,
      pendingTrades: this._trades.filter(t => t.status === TRADE_STATES.PENDING).length,

      winRate: this._round(winRate),
      lossRate: this._round((losses.length / closed.length) * 100),
      breakevenRate: this._round((breakeven.length / closed.length) * 100),

      totalPnl: this._round(totalPnl),
      totalPnlPercent: this._round(totalPnlPercent),
      averagePnl: this._round(totalPnl / closed.length),
      averagePnlPercent: this._round(totalPnlPercent / closed.length),

      grossProfit: this._round(grossProfit),
      grossLoss: this._round(grossLoss),
      profitFactor: profitFactor === Infinity ? 'Infinity' : this._round(profitFactor),
      netReturnPct: this._round(((this._balance - this._initialBalance) / this._initialBalance) * 100),

      expectancy: this._round(expectancy),
      expectancyRatio: this._round(expectancyRatio),
      rewardRisk: this._round(rewardRisk),
      averageWin: this._round(avgWin),
      averageLoss: this._round(avgLoss),

      averageDuration: Math.round(avgDuration),

      maxWin: this._round(Math.max(...closed.map(t => t.pnl))),
      maxLoss: this._round(Math.min(...closed.map(t => t.pnl))),
      largestWin: bestTrade ? bestTrade.tradeId : null,
      largestLoss: worstTrade ? worstTrade.tradeId : null,

      maxDrawdown: this._round(maxDrawdown),
      maxDrawdownPct: this._round(maxDrawdownPct),

      maxConsecutiveWins,
      maxConsecutiveLosses,
      currentStreak,
      currentStreakType,

      balance: this._round(this._balance),
      initialBalance: this._initialBalance,

      byDirection,
      byTimeframe,
      byExitReason,
    };
  }

  performance() {
    const closed = this._closedTrades;
    if (closed.length === 0) {
      return {
        profitFactor: 0, expectancy: 0, expectancyRatio: 0,
        maxDrawdown: 0, maxDrawdownPct: 0,
        largestWin: 0, largestLoss: 0,
        avgConsecutiveWins: 0, avgConsecutiveLosses: 0,
        currentStreak: 0, currentStreakType: 'None',
        totalPnl: 0, netReturnPct: 0,
        sharpeRatio: 0, SortinoRatio: 0,
      };
    }

    const stats = this.stats();
    const pnlSeries = closed.map(t => t.pnlPercent);
    const avgReturn = pnlSeries.reduce((a, b) => a + b, 0) / pnlSeries.length;
    const variance = pnlSeries.reduce((s, r) => s + Math.pow(r - avgReturn, 2), 0) / pnlSeries.length;
    const stdDev = Math.sqrt(variance);
    const downsideVariance = pnlSeries.filter(r => r < 0).reduce((s, r) => s + r * r, 0) / Math.max(pnlSeries.filter(r => r < 0).length, 1);
    const downsideDev = Math.sqrt(downsideVariance);

    const avgConsecWins = this._computeAvgConsecutive(closed, true);
    const avgConsecLosses = this._computeAvgConsecutive(closed, false);

    return {
      profitFactor: stats.profitFactor,
      expectancy: stats.expectancy,
      expectancyRatio: stats.expectancyRatio,
      maxDrawdown: stats.maxDrawdown,
      maxDrawdownPct: stats.maxDrawdownPct,
      largestWin: stats.maxWin,
      largestLoss: stats.maxLoss,
      avgConsecutiveWins: this._round(avgConsecWins),
      avgConsecutiveLosses: this._round(avgConsecLosses),
      currentStreak: stats.currentStreak,
      currentStreakType: stats.currentStreakType,
      totalPnl: stats.totalPnl,
      netReturnPct: stats.netReturnPct,
      sharpeRatio: stdDev > 0 ? this._round(avgReturn / stdDev) : 0,
      sortinoRatio: downsideDev > 0 ? this._round(avgReturn / downsideDev) : 0,
    };
  }

  getInfo() {
    return {
      name: 'PaperTrading',
      description: 'Professional paper trading engine — full lifecycle trade management with performance analytics',
      implemented: true,
      version: this.version,
      symbol: this.symbol,
      maxTrades: this._maxTrades,
      balance: this._balance,
      initialBalance: this._initialBalance,
    };
  }

  getLastAnalysis() {
    return this._copyAnalysis(this._lastAnalysis || null);
  }

  // ---------------------------------------------------------------------------
  // Engine Analysis (determines trade direction + confidence)
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
      return { direction: 'neutral', confidence: 0, reason: '' };
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
      return { direction: 'neutral', confidence: 0, reason: '' };
    }

    return {
      direction,
      confidence: Math.min(100, confidence),
      reason: reasons.join('; '),
    };
  }

  // ---------------------------------------------------------------------------
  // Stop Loss / Take Profit (from ATR + Bollinger)
  // ---------------------------------------------------------------------------

  _computeLevels(price, direction, atrResult, bollingerResult) {
    const atr = atrResult?.ready ? atrResult.atr : null;
    const multiplier = 2;

    let stopLoss, takeProfit;

    if (direction === 'BUY') {
      stopLoss = atr ? price - (atr * multiplier) : price * 0.97;
      takeProfit = atr ? price + (atr * multiplier * 1.5) : price * 1.04;
    } else {
      stopLoss = atr ? price + (atr * multiplier) : price * 1.03;
      takeProfit = atr ? price - (atr * multiplier * 1.5) : price * 0.96;
    }

    if (bollingerResult?.ready) {
      if (direction === 'BUY') {
        stopLoss = Math.max(stopLoss, bollingerResult.lowerBand || stopLoss);
      } else {
        stopLoss = Math.min(stopLoss, bollingerResult.upperBand || stopLoss);
      }
    }

    return { stopLoss, takeProfit };
  }

  // ---------------------------------------------------------------------------
  // Trade Lifecycle
  // ---------------------------------------------------------------------------

  _openTrade(params, context = {}) {
    this._tradeCounter++;
    const tradeId = `PT-${this._tradeCounter}`;
    const entryTime = params.entryTime || formatTimestamp(this.clock.nowMs());

    const trade = {
      tradeId,
      symbol: params.symbol,
      timeframe: params.timeframe,
      direction: params.direction,
      entryPrice: params.entryPrice,
      entryTime,
      stopLoss: params.stopLoss,
      takeProfit: params.takeProfit,
      riskReward: params.riskReward || 0,
      positionSize: params.positionSize || 0,
      currentPrice: params.currentPrice || params.entryPrice,
      status: params.status || TRADE_STATES.OPEN,
      exitPrice: null,
      exitTime: null,
      exitReason: null,
      duration: null,
      pnl: null,
      pnlPercent: null,
      confidence: params.confidence,
      reason: params.reason,
      timestamp: entryTime,
    };

    this._trades.push(trade);

    if (this._trades.length > this._maxTrades) {
      const overflow = this._trades.length - this._maxTrades;
      const toRemove = this._trades.slice(0, overflow);
      for (const t of toRemove) {
        if (t.status !== TRADE_STATES.CLOSED) {
          this._closeTrade(t, t.currentPrice || t.entryPrice, EXIT_REASONS.INVALIDATED, context);
        }
      }
      this._trades.splice(0, overflow);
    }

    return trade;
  }

  _updateTradeState(trade, newState) {
    trade.status = newState;
  }

  _closeTrade(trade, exitPrice, reason, context = {}) {
    if (this._closedIds.has(trade.tradeId)) return null;

    const idx = this._trades.indexOf(trade);
    if (idx === -1) return null;

    trade.status = TRADE_STATES.CLOSED;
    trade.exitPrice = this._round(exitPrice);
    trade.exitTime = formatTimestamp(resolveCycleNowMs(this.clock, context?.nowMs));
    trade.exitReason = reason;

    const entryPrice = trade.entryPrice;
    if (trade.direction === 'BUY') {
      trade.pnl = this._round((exitPrice - entryPrice) * trade.positionSize);
      trade.pnlPercent = this._round(((exitPrice - entryPrice) / entryPrice) * 100);
    } else {
      trade.pnl = this._round((entryPrice - exitPrice) * trade.positionSize);
      trade.pnlPercent = this._round(((entryPrice - exitPrice) / entryPrice) * 100);
    }

    const entryMs = new Date(trade.entryTime).getTime();
    const exitMs = new Date(trade.exitTime).getTime();
    trade.duration = exitMs - entryMs;

    this._balance += trade.pnl;
    if (this._balance > this._peakEquity) this._peakEquity = this._balance;

    this._closedIds.add(trade.tradeId);
    this._closedTrades.push({ ...trade });

    return trade;
  }

  // ---------------------------------------------------------------------------
  // Performance Analytics Internals
  // ---------------------------------------------------------------------------

  _computeDrawdown(closed) {
    let equity = this._initialBalance;
    let peak = this._initialBalance;
    let maxDrawdown = 0;
    let maxDrawdownPct = 0;

    for (const t of closed) {
      equity += t.pnl;
      if (equity > peak) peak = equity;
      const dd = peak - equity;
      const ddPct = peak > 0 ? (dd / peak) * 100 : 0;
      if (dd > maxDrawdown) maxDrawdown = dd;
      if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;
    }

    return { maxDrawdown: this._round(maxDrawdown), maxDrawdownPct: this._round(maxDrawdownPct) };
  }

  _computeStreaks(closed) {
    if (closed.length === 0) {
      return { maxConsecutiveWins: 0, maxConsecutiveLosses: 0, currentStreak: 0, currentStreakType: 'None' };
    }

    let maxWins = 0, maxLosses = 0;
    let curWins = 0, curLosses = 0;

    for (const t of closed) {
      if (t.pnl > 0) {
        curWins++;
        curLosses = 0;
        if (curWins > maxWins) maxWins = curWins;
      } else if (t.pnl < 0) {
        curLosses++;
        curWins = 0;
        if (curLosses > maxLosses) maxLosses = curLosses;
      } else {
        curWins = 0;
        curLosses = 0;
      }
    }

    let currentStreak = 0;
    let currentStreakType = 'None';
    for (let i = closed.length - 1; i >= 0; i--) {
      const t = closed[i];
      if (i === closed.length - 1) {
        if (t.pnl > 0) { currentStreakType = 'Win'; currentStreak = 1; }
        else if (t.pnl < 0) { currentStreakType = 'Loss'; currentStreak = 1; }
        else { currentStreakType = 'Breakeven'; currentStreak = 1; }
      } else {
        const sameType = (currentStreakType === 'Win' && t.pnl > 0) ||
                         (currentStreakType === 'Loss' && t.pnl < 0) ||
                         (currentStreakType === 'Breakeven' && t.pnl === 0);
        if (sameType) currentStreak++;
        else break;
      }
    }

    return { maxConsecutiveWins: maxWins, maxConsecutiveLosses: maxLosses, currentStreak, currentStreakType };
  }

  _computeAvgConsecutive(closed, isWin) {
    if (closed.length === 0) return 0;
    const streaks = [];
    let current = 0;

    for (const t of closed) {
      const match = isWin ? t.pnl > 0 : t.pnl < 0;
      if (match) {
        current++;
      } else {
        if (current > 0) streaks.push(current);
        current = 0;
      }
    }
    if (current > 0) streaks.push(current);

    return streaks.length > 0 ? streaks.reduce((a, b) => a + b, 0) / streaks.length : 0;
  }

  _emptyStats(allTrades, open) {
    return {
      totalTrades: allTrades.length,
      openTrades: open.length,
      closedTrades: 0,
      pendingTrades: this._trades.filter(t => t.status === TRADE_STATES.PENDING).length,
      winRate: 0, lossRate: 0, breakevenRate: 0,
      totalPnl: 0, totalPnlPercent: 0, averagePnl: 0, averagePnlPercent: 0,
      grossProfit: 0, grossLoss: 0, profitFactor: 0, netReturnPct: 0,
      expectancy: 0, expectancyRatio: 0, rewardRisk: 0, averageWin: 0, averageLoss: 0,
      averageDuration: 0,
      maxWin: 0, maxLoss: 0, largestWin: null, largestLoss: null,
      maxDrawdown: 0, maxDrawdownPct: 0,
      maxConsecutiveWins: 0, maxConsecutiveLosses: 0, currentStreak: 0, currentStreakType: 'None',
      balance: this._balance, initialBalance: this._initialBalance,
      byDirection: { BUY: { total: 0, wins: 0, losses: 0, winRate: 0, totalPnl: 0 }, SELL: { total: 0, wins: 0, losses: 0, winRate: 0, totalPnl: 0 } },
      byTimeframe: {},
      byExitReason: {},
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  _round(value) {
    return Math.round(value * 100) / 100;
  }

  _copyTrade(trade) {
    if (trade == null) return trade;

    return {
      tradeId: trade.tradeId,
      symbol: trade.symbol,
      timeframe: trade.timeframe,
      direction: trade.direction,
      entryPrice: trade.entryPrice,
      entryTime: trade.entryTime,
      stopLoss: trade.stopLoss,
      takeProfit: trade.takeProfit,
      riskReward: trade.riskReward,
      positionSize: trade.positionSize,
      currentPrice: trade.currentPrice,
      status: trade.status,
      exitPrice: trade.exitPrice,
      exitTime: trade.exitTime,
      exitReason: trade.exitReason,
      duration: trade.duration,
      pnl: trade.pnl,
      pnlPercent: trade.pnlPercent,
      confidence: trade.confidence,
      reason: trade.reason,
      timestamp: trade.timestamp,
    };
  }

  _copyTrades(trades) {
    if (trades == null) return [];
    return trades.map(trade => this._copyTrade(trade));
  }

  _copyAnalysis(analysis) {
    if (analysis == null) return analysis;
    return {
      direction: analysis.direction,
      confidence: analysis.confidence,
      reason: analysis.reason,
    };
  }
}

module.exports = { PaperTradingEngine, ENGINE_VERSION, DEFAULT_SYMBOL, DEFAULT_MAX_TRADES, INITIAL_BALANCE, RISK_PER_TRADE_PCT, TRADE_STATES, EXIT_REASONS };
