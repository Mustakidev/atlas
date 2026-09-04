const assert = require('node:assert/strict');
const test = require('node:test');

const { migrateV1ToV2 } = require('../../src/state/liveStateMigration');
const { PaperTradingEngine } = require('../../src/engine/paperTrading');
const {
  createConfigFingerprint,
  validateLiveExecutionState,
} = require('../../src/state/liveExecutionStateSchema');

const NOW = Date.parse('2024-01-02T00:00:00.000Z');
const fingerprint = createConfigFingerprint({
  symbol: 'BTCUSDT',
  paperTrading: { initialBalance: 10000, maxTrades: 500, fallbackRiskPerTradePct: 1 },
  confluence: { bullishThreshold: 65, bearishThreshold: 35 },
  advanceRisk: {
    riskPerTradePct: 1, atrMultTrending: 2, atrMultRanging: 1.5, rrTrending: 3, rrRanging: 1.8,
    maxDailyLossPct: 5, maxDailyDrawdownPct: 10, maxConsecutiveLosses: 3, cooldownMs: 3600000,
    sessionMultipliers: { ASIAN: 1, LONDON: 1, NEW_YORK: 1 }, minConfidence: 30, maxVolatilityPct: 5,
  },
  executionPipeline: { signalCooldownMs: 60000 },
  mtf: { aggressive: false },
});

function trade(index, pnl) {
  const entryTime = new Date(NOW + index).toISOString();
  const exitTime = new Date(NOW + index + 1).toISOString();
  return {
    tradeId: `PT-${index}`,
    symbol: 'BTCUSDT',
    timeframe: index % 2 ? '1h' : '4h',
    direction: 'BUY',
    entryPrice: 100,
    entryTime,
    stopLoss: 90,
    takeProfit: 110,
    riskReward: 2,
    positionSize: 1,
    currentPrice: 100,
    status: 'CLOSED',
    exitPrice: 100 + pnl,
    exitTime,
    exitReason: index % 2 ? 'Manual' : 'Take Profit',
    duration: 1,
    pnl,
    pnlPercent: pnl,
    confidence: 80,
    reason: 'migration test',
    timestamp: entryTime,
  };
}

function v1State(closedTrades = [], trades = []) {
  let peakEquity = 10000;
  let balance = 10000;
  for (const closed of closedTrades) {
    balance += closed.pnl;
    if (balance > peakEquity) peakEquity = balance;
  }
  return {
    schemaVersion: 1,
    stateType: 'live-execution-state',
    symbol: 'BTCUSDT',
    savedAt: '2024-01-02T00:00:00.000Z',
    mutationSequence: 7,
    configFingerprint: fingerprint,
    paperTrading: {
      tradeCounter: Math.max(closedTrades.length, trades.length),
      lastPrice: 100,
      balance,
      initialBalance: 10000,
      peakEquity,
      trades,
      closedTrades,
    },
    advanceRisk: {
      accountBalance: 10000,
      dailyPnL: 0,
      dailyHighWater: 10000,
      consecutiveLosses: 0,
      lossPauseUntil: 0,
      dailyLossLimitReached: false,
      tradingEnabled: true,
      lastResetDay: '2024-01-02',
      riskStateHealthy: true,
    },
    executionPipeline: { lastSignalTime: 0, riskSyncFailure: false },
  };
}

function context() {
  return { expectedFingerprint: fingerprint, expectedSymbol: 'BTCUSDT', nowMs: NOW };
}

test('migrates a large V1 closed history to an exact V2 suffix and summary', () => {
  const closed = Array.from({ length: 503 }, (_, index) => trade(index + 1, [1, -1, 0][index % 3]));
  const source = v1State(closed);
  const before = structuredClone(source);

  assert.doesNotThrow(() => validateLiveExecutionState(source, context()));
  const migrated = migrateV1ToV2(source);
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.mutationSequence, source.mutationSequence);
  assert.equal(migrated.configFingerprint, source.configFingerprint);
  assert.equal(migrated.paperTrading.closedTrades.length, 500);
  assert.equal(migrated.paperTrading.closedTrades[0].tradeId, 'PT-4');
  assert.equal(migrated.paperTrading.closedTrades.at(-1).tradeId, 'PT-503');
  assert.equal(migrated.paperTrading.lifetimeSummary.totalClosedTrades, 503);
  assert.deepEqual(source, before);
  assert.doesNotThrow(() => validateLiveExecutionState(migrated, context()));
  assert.deepEqual(migrateV1ToV2(source), migrated);
});

test('legacy oversized _trades fail migration without trimming', () => {
  const trades = Array.from({ length: 501 }, (_, index) => ({
    ...trade(index + 1, 0),
    status: 'OPEN',
    exitPrice: null,
    exitTime: null,
    exitReason: null,
    duration: null,
    pnl: null,
    pnlPercent: null,
  }));
  const source = v1State([], trades);
  assert.throws(() => migrateV1ToV2(source), error => error.code === 'STATE_MIGRATION_FAILED');
});

test('migration and fresh runtime use identical Welford return state', () => {
  const closed = Array.from({ length: 503 }, (_, index) => trade(index + 1, [0.1, -0.2, 0.01, 4.5][index % 4]));
  const migrated = migrateV1ToV2(v1State(closed));
  const fresh = new PaperTradingEngine({
    logger: { info() {}, warn() {}, error() {} },
    symbol: 'BTCUSDT',
    clock: { nowMs: () => NOW, monotonicMs: () => 0 },
  });
  for (const sourceTrade of closed) {
    const opened = fresh._openTrade({
      symbol: 'BTCUSDT',
      timeframe: sourceTrade.timeframe,
      direction: sourceTrade.direction,
      entryPrice: 100,
      stopLoss: 90,
      takeProfit: 110,
      riskReward: 2,
      positionSize: 1,
      currentPrice: 100,
      confidence: 80,
      reason: 'migration test',
      status: 'OPEN',
    });
    fresh._lastPrice = sourceTrade.exitPrice;
    fresh.close(opened.tradeId, sourceTrade.exitReason, { nowMs: NOW });
  }
  const migratedSummary = migrated.paperTrading.lifetimeSummary;
  const freshSummary = fresh.exportDurableState().lifetimeSummary;
  assert.equal(freshSummary.returnMean, migratedSummary.returnMean);
  assert.equal(freshSummary.returnM2, migratedSummary.returnM2);
  assert.equal(fresh.performance().sharpeRatio, migratedSummary.returnM2 > 0
    ? Math.round((migratedSummary.returnMean / Math.sqrt(migratedSummary.returnM2 / closed.length)) * 100) / 100
    : 0);
});

test('V2 validation rejects oversized arrays and malformed summary while accepting V1', () => {
  const source = v1State([trade(1, 1)]);
  assert.doesNotThrow(() => validateLiveExecutionState(source, context()));
  const migrated = migrateV1ToV2(source);
  assert.doesNotThrow(() => validateLiveExecutionState(migrated, context()));

  assert.throws(() => validateLiveExecutionState({
    ...migrated,
    paperTrading: {
      ...migrated.paperTrading,
      closedTrades: Array.from({ length: 501 }, () => migrated.paperTrading.closedTrades[0]),
    },
  }, context()), error => error.code === 'STATE_VALIDATION_FAILED');

  assert.throws(() => validateLiveExecutionState({
    ...migrated,
    paperTrading: {
      ...migrated.paperTrading,
      lifetimeSummary: {
        ...migrated.paperTrading.lifetimeSummary,
        winningTrades: '1',
      },
    },
  }, context()), error => error.code === 'STATE_VALIDATION_FAILED');

  assert.throws(() => validateLiveExecutionState({ ...migrated, schemaVersion: 3 }, context()), error => error.code === 'STATE_SCHEMA_UNSUPPORTED');
});
