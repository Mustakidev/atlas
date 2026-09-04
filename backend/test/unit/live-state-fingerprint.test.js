const assert = require('node:assert/strict');
const test = require('node:test');

const { createCanonicalLiveStateFingerprint } = require('../../src/state/liveStateFingerprint');

function dependencies(overrides = {}) {
  return {
    config: {
      get(name) {
        return {
          CONFLUENCE_BULLISH_THRESHOLD: 65,
          CONFLUENCE_BEARISH_THRESHOLD: 35,
        }[name];
      },
    },
    symbol: 'BTCUSDT',
    paperTrading: {
      getInfo: () => ({ initialBalance: 10000, maxTrades: 500 }),
    },
    advanceRisk: {
      getPolicy: () => ({
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
      }),
    },
    executionPipeline: {
      getPolicy: () => ({ signalCooldownMs: 60000 }),
    },
    mtfConfirmation: {
      isAggressive: () => false,
    },
    ...overrides,
  };
}

test('builds a canonical SHA-256 fingerprint from durable production policy', () => {
  const first = createCanonicalLiveStateFingerprint(dependencies());
  const second = createCanonicalLiveStateFingerprint(dependencies({
    config: {
      get(name) {
        return {
          CONFLUENCE_BEARISH_THRESHOLD: 35,
          CONFLUENCE_BULLISH_THRESHOLD: 65,
        }[name];
      },
    },
  }));

  assert.match(first, /^sha256:[0-9a-f]{64}$/);
  assert.equal(first, second);
});

test('changes when a durable policy input changes', () => {
  const first = createCanonicalLiveStateFingerprint(dependencies());
  const changed = createCanonicalLiveStateFingerprint(dependencies({
    advanceRisk: {
      getPolicy: () => ({
        ...dependencies().advanceRisk.getPolicy(),
        riskPerTradePct: 2,
      }),
    },
  }));

  assert.notEqual(first, changed);
});
