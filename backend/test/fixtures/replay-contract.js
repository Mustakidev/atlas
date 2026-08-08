const SUPPORTED_TIMEFRAMES = [
  '1m', '5m', '15m', '30m', '1h', '4h', '12h', '24h',
];

const SUCCESS_KEYS = [
  'symbol', 'timeframe', 'totalCandles', 'candlesAnalyzed', 'warmup',
  'trades', 'rejections', 'regimeHistory', 'stats', 'engineVersion',
  'lastUpdated', 'calculationTime', 'dataSource',
];

const EMPTY_RESULT_KEYS = [
  'symbol', 'timeframe', 'totalCandles', 'candlesAnalyzed', 'warmup',
  'trades', 'rejections', 'stats', 'reason', 'engineVersion',
  'lastUpdated', 'calculationTime', 'dataSource',
];

// Legacy empty replay results intentionally report totalCandles as 0 for
// nonempty sub-warmup input. Canonical migration must preserve this value or
// obtain explicit architecture/API approval for an intentional behavior change.

const TRADE_KEYS = [
  'tradeId', 'direction', 'entry', 'entryTime', 'entryIndex',
  'stopLoss', 'takeProfit', 'riskReward', 'riskSize', 'positionSize',
  'confidence', 'score', 'bias', 'regime', 'regimeConfidence',
  'regimeDecision', 'exit', 'exitTime', 'exitReason', 'win', 'duration',
  'rMultiple', 'pnl', 'pnlPercent',
];

const REGIME_DECISION_KEYS = [
  'allowTrade', 'penalty', 'preferredDirection', 'reason',
];

const REJECTION_KEYS = ['timestamp', 'reason', 'score', 'bias', 'direction'];

const REGIME_HISTORY_KEYS = [
  'timestamp', 'regime', 'confidence', 'trendScore', 'rangeScore', 'volatility',
];

const STATS_KEYS = [
  'totalTrades', 'wins', 'losses', 'winRate', 'profitFactor', 'expectancy',
  'averageR', 'maxDrawdown', 'maxDrawdownPct', 'grossProfit', 'grossLoss',
  'netPnl', 'longs', 'shorts', 'maxConsecutiveWins', 'maxConsecutiveLosses',
  'averageDuration', 'totalRejections', 'rejectionBreakdown', 'regime',
];

// Controlled route contract fixture only. This is not StrategyReplay semantic evidence.
function createControlledSuccessResponse() {
  return {
    symbol: 'BTCUSDT',
    timeframe: '1h',
    totalCandles: 52,
    candlesAnalyzed: 2,
    warmup: 50,
    trades: [{
      tradeId: 'SR-1',
      direction: 'BUY',
      entry: 150,
      entryTime: '2024-01-01T00:50:00.000Z',
      entryIndex: 50,
      stopLoss: 148,
      takeProfit: 156,
      riskReward: 3,
      riskSize: 2,
      positionSize: 50,
      confidence: 80,
      score: 80,
      bias: 'Bullish',
      regime: 'TRENDING_BULL',
      regimeConfidence: 80,
      regimeDecision: {
        allowTrade: true,
        penalty: 0,
        preferredDirection: 'BUY',
        reason: 'Bull trend detected — BUY trades active, no penalty',
      },
      exit: 151,
      exitTime: '2024-01-01T00:51:00.000Z',
      exitReason: 'End of Data',
      win: true,
      duration: 1,
      rMultiple: 0.5,
      pnl: 50,
      pnlPercent: 0.67,
    }],
    rejections: [],
    regimeHistory: [{
      timestamp: '2024-01-01T00:50:00.000Z',
      regime: 'TRENDING_BULL',
      confidence: 80,
      trendScore: 80,
      rangeScore: 20,
      volatility: 'LOW',
    }],
    stats: {
      totalTrades: 1,
      wins: 1,
      losses: 0,
      winRate: 100,
      profitFactor: 'Infinity',
      expectancy: 50,
      averageR: 0.5,
      maxDrawdown: 0,
      maxDrawdownPct: 0,
      grossProfit: 50,
      grossLoss: 0,
      netPnl: 50,
      longs: { total: 1, wins: 1, losses: 0, winRate: 100, avgR: 0.5 },
      shorts: { total: 0, wins: 0, losses: 0, winRate: 0, avgR: 0 },
      maxConsecutiveWins: 1,
      maxConsecutiveLosses: 0,
      averageDuration: 1,
      totalRejections: 0,
      rejectionBreakdown: {},
      regime: {
        byRegime: { TRENDING_BULL: { total: 1, wins: 1, losses: 0 } },
        winRateByRegime: { TRENDING_BULL: 100 },
      },
    },
    engineVersion: '1.0.0',
    lastUpdated: '2024-01-01T00:00:00.000Z',
    calculationTime: 4,
    dataSource: 'Historical OHLCV candles (strategy replay)',
  };
}

function normalizeReplayResponse(response) {
  const normalized = structuredClone(response);
  if (typeof normalized.lastUpdated !== 'string' || Number.isNaN(Date.parse(normalized.lastUpdated))) {
    throw new TypeError('lastUpdated must be an ISO timestamp');
  }
  if (!Number.isFinite(normalized.calculationTime) || normalized.calculationTime < 0) {
    throw new TypeError('calculationTime must be a finite non-negative number');
  }
  normalized.lastUpdated = '<ISO_TIMESTAMP>';
  normalized.calculationTime = '<DURATION_MS>';
  return normalized;
}

module.exports = {
  EMPTY_RESULT_KEYS,
  REGIME_DECISION_KEYS,
  REGIME_HISTORY_KEYS,
  REJECTION_KEYS,
  STATS_KEYS,
  SUCCESS_KEYS,
  SUPPORTED_TIMEFRAMES,
  TRADE_KEYS,
  createControlledSuccessResponse,
  normalizeReplayResponse,
};
