const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createAtomicJsonStateStore } = require('../../src/state/atomicJsonStateStore');
const { createConfigFingerprint } = require('../../src/state/liveExecutionStateSchema');

const NOW = Date.parse('2024-01-02T00:00:00.000Z');
const expectedFingerprint = createConfigFingerprint({
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

function state() {
  return {
    schemaVersion: 1, stateType: 'live-execution-state', symbol: 'BTCUSDT',
    savedAt: '2024-01-02T00:00:00.000Z', mutationSequence: 4, configFingerprint: expectedFingerprint,
    paperTrading: { tradeCounter: 0, lastPrice: null, balance: 10000, initialBalance: 10000, peakEquity: 10000, trades: [], closedTrades: [] },
    advanceRisk: { accountBalance: 10000, dailyPnL: 0, dailyHighWater: 10000, consecutiveLosses: 0, lossPauseUntil: 0, dailyLossLimitReached: false, tradingEnabled: true, lastResetDay: '2024-01-02', riskStateHealthy: true },
    executionPipeline: { lastSignalTime: 0, riskSyncFailure: false },
  };
}

test('real Node fs supports the complete atomic write and recovery read path', async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'atlas-ph4b-integration-'));
  try {
    const store = createAtomicJsonStateStore({
      filePath: path.join(directory, 'live-execution-state.json'),
      now: () => NOW,
    });
    const result = await store.write(state(), { expectedFingerprint, expectedSymbol: 'BTCUSDT', nowMs: NOW });
    assert.deepEqual(result, { status: 'WRITTEN' });
    const read = await store.read({ expectedFingerprint, expectedSymbol: 'BTCUSDT', nowMs: NOW });
    assert.equal(read.status, 'VALID');
    assert.equal(read.state.mutationSequence, 4);
    assert.equal(read.recovery.tempPresent, false);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});
