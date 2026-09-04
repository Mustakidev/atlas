const test = require('node:test');
const assert = require('node:assert/strict');

const {
  LiveStateError,
  createConfigFingerprint,
  serializeLiveExecutionState,
  validateLiveExecutionState,
} = require('../../src/state/liveExecutionStateSchema');

const NOW = Date.parse('2024-01-02T00:00:00.000Z');

function policyContext(overrides = {}) {
  return {
    symbol: 'BTCUSDT',
    paperTrading: { initialBalance: 10000, maxTrades: 500, fallbackRiskPerTradePct: 1 },
    confluence: { bullishThreshold: 65, bearishThreshold: 35 },
    advanceRisk: {
      riskPerTradePct: 1,
      atrMultTrending: 2,
      atrMultRanging: 1.5,
      rrTrending: 3,
      rrRanging: 1.8,
      maxDailyLossPct: 5,
      maxDailyDrawdownPct: 10,
      maxConsecutiveLosses: 3,
      cooldownMs: 3600000,
      sessionMultipliers: { ASIAN: 1, LONDON: 1, NEW_YORK: 1 },
      minConfidence: 30,
      maxVolatilityPct: 5,
    },
    executionPipeline: { signalCooldownMs: 60000 },
    mtf: { aggressive: false },
    ...overrides,
  };
}

function context() {
  return {
    expectedFingerprint: createConfigFingerprint(policyContext()),
    expectedSymbol: 'BTCUSDT',
    nowMs: NOW,
  };
}

function openTrade(id = 'PT-1') {
  return {
    tradeId: id,
    symbol: 'BTCUSDT',
    timeframe: '1h',
    direction: 'BUY',
    entryPrice: 100,
    entryTime: '2024-01-01T00:00:00.000Z',
    stopLoss: 96,
    takeProfit: 106,
    riskReward: 2.5,
    positionSize: 25,
    currentPrice: 100,
    status: 'OPEN',
    exitPrice: null,
    exitTime: null,
    exitReason: null,
    duration: null,
    pnl: null,
    pnlPercent: null,
    confidence: 80,
    reason: 'test',
    timestamp: '2024-01-01T00:00:00.000Z',
  };
}

function closedTrade(id = 'PT-1') {
  return {
    ...openTrade(id),
    currentPrice: 104,
    status: 'CLOSED',
    exitPrice: 104,
    exitTime: '2024-01-01T01:00:00.000Z',
    exitReason: 'Take Profit',
    duration: 3600000,
    pnl: 100,
    pnlPercent: 4,
  };
}

function state(overrides = {}) {
  return {
    schemaVersion: 1,
    stateType: 'live-execution-state',
    symbol: 'BTCUSDT',
    savedAt: '2024-01-02T00:00:00.000Z',
    mutationSequence: 0,
    configFingerprint: context().expectedFingerprint,
    paperTrading: {
      tradeCounter: 0,
      lastPrice: null,
      balance: 10000,
      initialBalance: 10000,
      peakEquity: 10000,
      trades: [],
      closedTrades: [],
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
    executionPipeline: {
      lastSignalTime: 0,
      riskSyncFailure: false,
    },
    ...overrides,
  };
}

function assertCode(fn, code) {
  assert.throws(fn, error => error instanceof LiveStateError && error.code === code);
}

test('validates the exact V1 root and returns a deeply frozen defensive clone', () => {
  const input = state();
  const result = validateLiveExecutionState(input, context());

  assert.deepEqual(result, input);
  assert.notStrictEqual(result, input);
  assert.notStrictEqual(result.paperTrading, input.paperTrading);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.paperTrading), true);
  assert.equal(Object.isFrozen(result.advanceRisk), true);
  assert.equal(Object.isFrozen(result.executionPipeline), true);
});

test('rejects wrong root, version, state type, symbol, fingerprint, and mutation sequence', () => {
  assertCode(() => validateLiveExecutionState({ ...state(), extra: true }, context()), 'STATE_VALIDATION_FAILED');
  assertCode(() => validateLiveExecutionState({ ...state(), schemaVersion: 2 }, context()), 'STATE_SCHEMA_UNSUPPORTED');
  assertCode(() => validateLiveExecutionState({ ...state(), stateType: 'other' }, context()), 'STATE_VALIDATION_FAILED');
  assertCode(() => validateLiveExecutionState({ ...state(), symbol: 'ETHUSDT' }, context()), 'STATE_CONTEXT_MISMATCH');
  assertCode(() => validateLiveExecutionState({ ...state(), configFingerprint: 'sha256:' + '0'.repeat(64) }, context()), 'STATE_CONTEXT_MISMATCH');
  assertCode(() => validateLiveExecutionState({ ...state(), mutationSequence: Number.MAX_SAFE_INTEGER + 1 }, context()), 'STATE_VALIDATION_FAILED');
});

test('rejects non-finite values before JSON serialization', () => {
  const invalid = state({ paperTrading: { ...state().paperTrading, balance: NaN } });
  assertCode(() => validateLiveExecutionState(invalid, context()), 'STATE_VALIDATION_FAILED');
  assertCode(() => serializeLiveExecutionState(invalid, context()), 'STATE_VALIDATION_FAILED');
  assertCode(() => createConfigFingerprint({ ...policyContext(), advanceRisk: { ...policyContext().advanceRisk, cooldownMs: Infinity } }), 'STATE_VALIDATION_FAILED');
});

test('accepts separate PaperTrading and AdvanceRisk balances', () => {
  const input = state({
    paperTrading: { ...state().paperTrading, balance: 12000, initialBalance: 10000, peakEquity: 12000 },
    advanceRisk: { ...state().advanceRisk, accountBalance: 25000, dailyHighWater: 25000 },
  });
  assert.equal(validateLiveExecutionState(input, context()).advanceRisk.accountBalance, 25000);
});

test('accepts a retained CLOSED trade in both runtime arrays', () => {
  const closed = closedTrade();
  const input = state({
    paperTrading: {
      tradeCounter: 1,
      lastPrice: 104,
      balance: 10100,
      initialBalance: 10000,
      peakEquity: 10100,
      trades: [closed],
      closedTrades: [{ ...closed }],
    },
  });
  assert.equal(validateLiveExecutionState(input, context()).paperTrading.trades[0].status, 'CLOSED');
});

test('enforces per-array IDs, active/closed separation, and overlap consistency', () => {
  const duplicate = openTrade();
  const duplicateState = state({
    paperTrading: { ...state().paperTrading, tradeCounter: 1, trades: [duplicate, { ...duplicate }] },
  });
  assertCode(() => validateLiveExecutionState(duplicateState, context()), 'STATE_VALIDATION_FAILED');

  const activeCollision = state({
    paperTrading: { ...state().paperTrading, tradeCounter: 1, trades: [openTrade()], closedTrades: [closedTrade()] },
  });
  assertCode(() => validateLiveExecutionState(activeCollision, context()), 'STATE_VALIDATION_FAILED');

  const inconsistent = closedTrade();
  assertCode(() => validateLiveExecutionState(state({
    paperTrading: {
      tradeCounter: 1,
      lastPrice: 104,
      balance: 10100,
      initialBalance: 10000,
      peakEquity: 10100,
      trades: [inconsistent],
      closedTrades: [{ ...inconsistent, pnl: 101 }],
    },
  }), context()), 'STATE_VALIDATION_FAILED');
});

test('validates risk latches, timestamps, and domain numeric invariants', () => {
  assert.equal(validateLiveExecutionState(state({
    advanceRisk: { ...state().advanceRisk, riskStateHealthy: false },
    executionPipeline: { lastSignalTime: NOW - 1000, riskSyncFailure: true },
  }), context()).advanceRisk.riskStateHealthy, false);
  assertCode(() => validateLiveExecutionState(state({ executionPipeline: { lastSignalTime: null, riskSyncFailure: true } }), context()), 'STATE_VALIDATION_FAILED');
  assertCode(() => validateLiveExecutionState(state({ savedAt: '2024-01-02T00:06:00.000Z' }), context()), 'STATE_VALIDATION_FAILED');
  assert.equal(validateLiveExecutionState(state({ savedAt: '2020-01-01T00:00:00.000Z' }), context()).savedAt, '2020-01-01T00:00:00.000Z');
  assertCode(() => validateLiveExecutionState(state({ advanceRisk: { ...state().advanceRisk, lastResetDay: '2024-02-30' } }), context()), 'STATE_VALIDATION_FAILED');
});

test('fingerprints normalized durable policy independently of insertion order and irrelevant settings', () => {
  const first = policyContext();
  const second = {
    mtf: { aggressive: false },
    executionPipeline: { signalCooldownMs: 60000 },
    advanceRisk: { ...first.advanceRisk, sessionMultipliers: { NEW_YORK: 1, ASIAN: 1, LONDON: 1 } },
    confluence: { bearishThreshold: 35, bullishThreshold: 65 },
    paperTrading: { fallbackRiskPerTradePct: 1, maxTrades: 500, initialBalance: 10000 },
    symbol: 'BTCUSDT',
    http: { port: 3000 },
  };
  assert.equal(createConfigFingerprint(first), createConfigFingerprint(second));
  assert.notEqual(createConfigFingerprint(first), createConfigFingerprint({ ...first, confluence: { ...first.confluence, bullishThreshold: 66 } }));
});
