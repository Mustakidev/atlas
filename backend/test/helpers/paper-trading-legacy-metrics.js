function round(value) {
  return Math.round(value * 100) / 100;
}

function drawdown(closed, initialBalance) {
  let equity = initialBalance;
  let peak = initialBalance;
  let maxDrawdown = 0;
  let maxDrawdownPct = 0;

  for (const trade of closed) {
    equity += trade.pnl;
    if (equity > peak) peak = equity;
    const currentDrawdown = peak - equity;
    const currentDrawdownPct = peak > 0 ? (currentDrawdown / peak) * 100 : 0;
    if (currentDrawdown > maxDrawdown) maxDrawdown = currentDrawdown;
    if (currentDrawdownPct > maxDrawdownPct) maxDrawdownPct = currentDrawdownPct;
  }

  return { maxDrawdown: round(maxDrawdown), maxDrawdownPct: round(maxDrawdownPct) };
}

function streaks(closed) {
  if (closed.length === 0) {
    return { maxConsecutiveWins: 0, maxConsecutiveLosses: 0, currentStreak: 0, currentStreakType: 'None' };
  }

  let maxWins = 0;
  let maxLosses = 0;
  let currentWins = 0;
  let currentLosses = 0;
  for (const trade of closed) {
    if (trade.pnl > 0) {
      currentWins++;
      currentLosses = 0;
      if (currentWins > maxWins) maxWins = currentWins;
    } else if (trade.pnl < 0) {
      currentLosses++;
      currentWins = 0;
      if (currentLosses > maxLosses) maxLosses = currentLosses;
    } else {
      currentWins = 0;
      currentLosses = 0;
    }
  }

  let currentStreak = 0;
  let currentStreakType = 'None';
  for (let index = closed.length - 1; index >= 0; index--) {
    const trade = closed[index];
    if (index === closed.length - 1) {
      if (trade.pnl > 0) { currentStreakType = 'Win'; currentStreak = 1; }
      else if (trade.pnl < 0) { currentStreakType = 'Loss'; currentStreak = 1; }
      else { currentStreakType = 'Breakeven'; currentStreak = 1; }
    } else {
      const sameType = (currentStreakType === 'Win' && trade.pnl > 0)
        || (currentStreakType === 'Loss' && trade.pnl < 0)
        || (currentStreakType === 'Breakeven' && trade.pnl === 0);
      if (sameType) currentStreak++;
      else break;
    }
  }

  return {
    maxConsecutiveWins: maxWins,
    maxConsecutiveLosses: maxLosses,
    currentStreak,
    currentStreakType,
  };
}

function averageConsecutive(closed, isWin) {
  const lengths = [];
  let current = 0;
  for (const trade of closed) {
    const match = isWin ? trade.pnl > 0 : trade.pnl < 0;
    if (match) current++;
    else {
      if (current > 0) lengths.push(current);
      current = 0;
    }
  }
  if (current > 0) lengths.push(current);
  return lengths.length > 0 ? lengths.reduce((a, b) => a + b, 0) / lengths.length : 0;
}

function legacyStats({ trades, closedTrades, balance, initialBalance }) {
  const allTrades = trades;
  const open = trades.filter(t => t.status === 'OPEN' || t.status === 'ACTIVE');
  const closed = closedTrades;
  if (closed.length === 0) {
    return {
      totalTrades: allTrades.length,
      openTrades: open.length,
      closedTrades: 0,
      pendingTrades: trades.filter(t => t.status === 'PENDING').length,
      winRate: 0, lossRate: 0, breakevenRate: 0,
      totalPnl: 0, totalPnlPercent: 0, averagePnl: 0, averagePnlPercent: 0,
      grossProfit: 0, grossLoss: 0, profitFactor: 0, netReturnPct: 0,
      expectancy: 0, expectancyRatio: 0, rewardRisk: 0, averageWin: 0, averageLoss: 0,
      averageDuration: 0,
      maxWin: 0, maxLoss: 0, largestWin: null, largestLoss: null,
      maxDrawdown: 0, maxDrawdownPct: 0,
      maxConsecutiveWins: 0, maxConsecutiveLosses: 0, currentStreak: 0, currentStreakType: 'None',
      balance, initialBalance,
      byDirection: { BUY: { total: 0, wins: 0, losses: 0, winRate: 0, totalPnl: 0 }, SELL: { total: 0, wins: 0, losses: 0, winRate: 0, totalPnl: 0 } },
      byTimeframe: {},
      byExitReason: {},
    };
  }

  const wins = closed.filter(t => t.pnl > 0);
  const losses = closed.filter(t => t.pnl < 0);
  const breakeven = closed.filter(t => t.pnl === 0);
  const totalPnl = closed.reduce((s, t) => s + t.pnl, 0);
  const totalPnlPercent = closed.reduce((s, t) => s + t.pnlPercent, 0);
  const totalDuration = closed.reduce((s, t) => s + (t.duration || 0), 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  let bestTrade = closed[0];
  let worstTrade = closed[0];
  for (const trade of closed) {
    if (trade.pnlPercent > bestTrade.pnlPercent) bestTrade = trade;
    if (trade.pnlPercent < worstTrade.pnlPercent) worstTrade = trade;
  }
  const avgWin = wins.length > 0 ? grossProfit / wins.length : 0;
  const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  const expectancy = totalPnl / closed.length;
  const winRate = (wins.length / closed.length) * 100;
  const rewardRisk = avgLoss > 0 ? avgWin / avgLoss : 0;
  const expectancyRatio = rewardRisk > 0 ? (winRate / 100) * rewardRisk - (1 - winRate / 100) : 0;
  const { maxDrawdown, maxDrawdownPct } = drawdown(closed, initialBalance);
  const { maxConsecutiveWins, maxConsecutiveLosses, currentStreak, currentStreakType } = streaks(closed);

  const byDirection = {};
  for (const direction of ['BUY', 'SELL']) {
    const directionTrades = closed.filter(t => t.direction === direction);
    const directionWins = directionTrades.filter(t => t.pnl > 0);
    byDirection[direction] = {
      total: directionTrades.length,
      wins: directionWins.length,
      losses: directionTrades.filter(t => t.pnl < 0).length,
      winRate: directionTrades.length > 0 ? round((directionWins.length / directionTrades.length) * 100) : 0,
      totalPnl: round(directionTrades.reduce((s, t) => s + t.pnl, 0)),
    };
  }
  const byTimeframe = {};
  for (const trade of closed) {
    if (!byTimeframe[trade.timeframe]) byTimeframe[trade.timeframe] = { total: 0, wins: 0, losses: 0, totalPnl: 0 };
    byTimeframe[trade.timeframe].total++;
    if (trade.pnl > 0) byTimeframe[trade.timeframe].wins++;
    if (trade.pnl < 0) byTimeframe[trade.timeframe].losses++;
    byTimeframe[trade.timeframe].totalPnl += trade.pnl;
  }
  for (const timeframe of Object.keys(byTimeframe)) byTimeframe[timeframe].totalPnl = round(byTimeframe[timeframe].totalPnl);
  const byExitReason = {};
  for (const trade of closed) {
    const reason = trade.exitReason || 'Unknown';
    if (!byExitReason[reason]) byExitReason[reason] = { count: 0, totalPnl: 0 };
    byExitReason[reason].count++;
    byExitReason[reason].totalPnl += trade.pnl;
  }
  for (const reason of Object.keys(byExitReason)) byExitReason[reason].totalPnl = round(byExitReason[reason].totalPnl);

  return {
    totalTrades: allTrades.length,
    openTrades: open.length,
    closedTrades: closed.length,
    pendingTrades: trades.filter(t => t.status === 'PENDING').length,
    winRate: round(winRate),
    lossRate: round((losses.length / closed.length) * 100),
    breakevenRate: round((breakeven.length / closed.length) * 100),
    totalPnl: round(totalPnl),
    totalPnlPercent: round(totalPnlPercent),
    averagePnl: round(totalPnl / closed.length),
    averagePnlPercent: round(totalPnlPercent / closed.length),
    grossProfit: round(grossProfit),
    grossLoss: round(grossLoss),
    profitFactor: profitFactor === Infinity ? 'Infinity' : round(profitFactor),
    netReturnPct: round(((balance - initialBalance) / initialBalance) * 100),
    expectancy: round(expectancy),
    expectancyRatio: round(expectancyRatio),
    rewardRisk: round(rewardRisk),
    averageWin: round(avgWin),
    averageLoss: round(avgLoss),
    averageDuration: Math.round(totalDuration / closed.length),
    maxWin: round(Math.max(...closed.map(t => t.pnl))),
    maxLoss: round(Math.min(...closed.map(t => t.pnl))),
    largestWin: bestTrade ? bestTrade.tradeId : null,
    largestLoss: worstTrade ? worstTrade.tradeId : null,
    maxDrawdown: round(maxDrawdown),
    maxDrawdownPct: round(maxDrawdownPct),
    maxConsecutiveWins,
    maxConsecutiveLosses,
    currentStreak,
    currentStreakType,
    balance: round(balance),
    initialBalance,
    byDirection,
    byTimeframe,
    byExitReason,
  };
}

function legacyPerformance({ trades, closedTrades, balance, initialBalance }) {
  const closed = closedTrades;
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
  const stats = legacyStats({ trades, closedTrades, balance, initialBalance });
  const returns = closed.map(t => t.pnlPercent);
  const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + Math.pow(r - avgReturn, 2), 0) / returns.length;
  const stdDev = Math.sqrt(variance);
  const downside = returns.filter(r => r < 0);
  const downsideVariance = downside.reduce((s, r) => s + r * r, 0) / Math.max(downside.length, 1);
  const downsideDev = Math.sqrt(downsideVariance);
  return {
    profitFactor: stats.profitFactor,
    expectancy: stats.expectancy,
    expectancyRatio: stats.expectancyRatio,
    maxDrawdown: stats.maxDrawdown,
    maxDrawdownPct: stats.maxDrawdownPct,
    largestWin: stats.maxWin,
    largestLoss: stats.maxLoss,
    avgConsecutiveWins: round(averageConsecutive(closed, true)),
    avgConsecutiveLosses: round(averageConsecutive(closed, false)),
    currentStreak: stats.currentStreak,
    currentStreakType: stats.currentStreakType,
    totalPnl: stats.totalPnl,
    netReturnPct: stats.netReturnPct,
    sharpeRatio: stdDev > 0 ? round(avgReturn / stdDev) : 0,
    sortinoRatio: downsideDev > 0 ? round(avgReturn / downsideDev) : 0,
  };
}

module.exports = { legacyStats, legacyPerformance };
