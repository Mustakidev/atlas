const {
  LiveStateError,
} = require('./liveExecutionStateSchema');
const {
  RECENT_CLOSED_TRADES_LIMIT,
} = require('../engine/paperTrading');

function cloneTrade(trade) {
  return { ...trade };
}

function createSummary(initialBalance) {
  return {
    totalClosedTrades: 0,
    winningTrades: 0,
    losingTrades: 0,
    breakevenTrades: 0,
    grossProfit: 0,
    lossPnlSum: 0,
    totalPnl: 0,
    totalPnlPercent: 0,
    totalDuration: 0,
    maxPnl: 0,
    minPnl: 0,
    bestTrade: null,
    worstTrade: null,
    drawdownPeakEquity: initialBalance,
    maxDrawdown: 0,
    maxDrawdownPct: 0,
    maxConsecutiveWins: 0,
    maxConsecutiveLosses: 0,
    winningStreakCount: 0,
    losingStreakCount: 0,
    currentStreak: 0,
    currentStreakType: 'None',
    returnMean: 0,
    returnM2: 0,
    downsideReturnCount: 0,
    downsideReturnSumSquares: 0,
    byDirection: {
      BUY: { total: 0, wins: 0, losses: 0, totalPnl: 0 },
      SELL: { total: 0, wins: 0, losses: 0, totalPnl: 0 },
    },
    byTimeframe: Object.create(null),
    byExitReason: Object.create(null),
  };
}

function updateSummary(summary, trade, equity) {
  const { pnl, pnlPercent } = trade;
  const wasEmpty = summary.totalClosedTrades === 0;

  const nPrevious = summary.totalClosedTrades;
  const nNew = nPrevious + 1;
  const delta = pnlPercent - summary.returnMean;
  summary.returnMean = summary.returnMean + (delta / nNew);
  const delta2 = pnlPercent - summary.returnMean;
  summary.returnM2 = summary.returnM2 + (delta * delta2);
  summary.totalClosedTrades = nNew;
  summary.totalPnl += pnl;
  summary.totalPnlPercent += pnlPercent;
  summary.totalDuration += trade.duration || 0;
  if (pnlPercent < 0) {
    summary.downsideReturnCount++;
    summary.downsideReturnSumSquares += Math.pow(pnlPercent, 2);
  }

  if (pnl > 0) {
    summary.winningTrades++;
    summary.grossProfit += pnl;
  } else if (pnl < 0) {
    summary.losingTrades++;
    summary.lossPnlSum += pnl;
  } else {
    summary.breakevenTrades++;
  }

  if (wasEmpty || pnl > summary.maxPnl) summary.maxPnl = pnl;
  if (wasEmpty || pnl < summary.minPnl) summary.minPnl = pnl;
  if (!summary.bestTrade || pnlPercent > summary.bestTrade.pnlPercent) {
    summary.bestTrade = { tradeId: trade.tradeId, pnlPercent };
  }
  if (!summary.worstTrade || pnlPercent < summary.worstTrade.pnlPercent) {
    summary.worstTrade = { tradeId: trade.tradeId, pnlPercent };
  }

  if (equity > summary.drawdownPeakEquity) summary.drawdownPeakEquity = equity;
  const drawdown = summary.drawdownPeakEquity - equity;
  const drawdownPct = summary.drawdownPeakEquity > 0
    ? (drawdown / summary.drawdownPeakEquity) * 100
    : 0;
  if (drawdown > summary.maxDrawdown) summary.maxDrawdown = drawdown;
  if (drawdownPct > summary.maxDrawdownPct) summary.maxDrawdownPct = drawdownPct;

  if (pnl > 0) {
    if (summary.currentStreakType === 'Win') summary.currentStreak++;
    else {
      summary.currentStreak = 1;
      summary.currentStreakType = 'Win';
      summary.winningStreakCount++;
    }
    if (summary.currentStreak > summary.maxConsecutiveWins) {
      summary.maxConsecutiveWins = summary.currentStreak;
    }
  } else if (pnl < 0) {
    if (summary.currentStreakType === 'Loss') summary.currentStreak++;
    else {
      summary.currentStreak = 1;
      summary.currentStreakType = 'Loss';
      summary.losingStreakCount++;
    }
    if (summary.currentStreak > summary.maxConsecutiveLosses) {
      summary.maxConsecutiveLosses = summary.currentStreak;
    }
  } else if (summary.currentStreakType === 'Breakeven') {
    summary.currentStreak++;
  } else {
    summary.currentStreak = 1;
    summary.currentStreakType = 'Breakeven';
  }

  const direction = summary.byDirection[trade.direction];
  direction.total++;
  if (pnl > 0) direction.wins++;
  if (pnl < 0) direction.losses++;
  direction.totalPnl += pnl;

  const timeframe = summary.byTimeframe[trade.timeframe] || {
    total: 0, wins: 0, losses: 0, totalPnl: 0,
  };
  timeframe.total++;
  if (pnl > 0) timeframe.wins++;
  if (pnl < 0) timeframe.losses++;
  timeframe.totalPnl += pnl;
  summary.byTimeframe[trade.timeframe] = timeframe;

  const reason = trade.exitReason || 'Unknown';
  const exit = summary.byExitReason[reason] || { count: 0, totalPnl: 0 };
  exit.count++;
  exit.totalPnl += pnl;
  summary.byExitReason[reason] = exit;
}

function migrationFailure(message) {
  return new LiveStateError('STATE_MIGRATION_FAILED', message, { phase: 'migration' });
}

function migrateV1ToV2(state) {
  if (!state || typeof state !== 'object' || state.schemaVersion !== 1) {
    throw migrationFailure('Only a validated V1 live execution state can be migrated');
  }
  if (state.paperTrading.trades.length > 500) {
    throw migrationFailure('Legacy PaperTrading trades exceed the V2 bound');
  }

  const { initialBalance, closedTrades } = state.paperTrading;
  const summary = createSummary(initialBalance);
  const recent = [];
  let equity = initialBalance;

  for (let index = 0; index < closedTrades.length; index++) {
    const trade = closedTrades[index];
    equity += trade.pnl;
    updateSummary(summary, trade, equity);
    recent[index % RECENT_CLOSED_TRADES_LIMIT] = cloneTrade(trade);
  }

  const recentStart = closedTrades.length >= RECENT_CLOSED_TRADES_LIMIT
    ? closedTrades.length % RECENT_CLOSED_TRADES_LIMIT
    : 0;
  const orderedRecent = recent.length === 0
    ? []
    : recent.slice(recentStart).concat(recent.slice(0, recentStart));

  return {
    schemaVersion: 2,
    stateType: state.stateType,
    symbol: state.symbol,
    savedAt: state.savedAt,
    mutationSequence: state.mutationSequence,
    configFingerprint: state.configFingerprint,
    paperTrading: {
      tradeCounter: state.paperTrading.tradeCounter,
      lastPrice: state.paperTrading.lastPrice,
      balance: state.paperTrading.balance,
      initialBalance: state.paperTrading.initialBalance,
      peakEquity: state.paperTrading.peakEquity,
      trades: state.paperTrading.trades.map(cloneTrade),
      closedTrades: orderedRecent,
      lifetimeSummary: summary,
    },
    advanceRisk: { ...state.advanceRisk },
    executionPipeline: { ...state.executionPipeline },
  };
}

module.exports = { migrateV1ToV2 };
