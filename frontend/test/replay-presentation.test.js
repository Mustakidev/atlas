const assert = require('node:assert/strict');
const test = require('node:test');

const {
  formatDuration,
  presentCanonicalReplay,
} = require('../replayPresentation');

function trade(overrides = {}) {
  return {
    tradeId: 'PT-1',
    direction: 'BUY',
    entryPrice: 100,
    exitPrice: 110,
    stopLoss: 95,
    takeProfit: 110,
    status: 'CLOSED',
    exitReason: 'Take Profit',
    duration: 3_600_000,
    entryTime: '2024-01-01T00:00:00.000Z',
    exitTime: '2024-01-01T01:00:00.000Z',
    pnl: 10,
    riskReward: 2,
    ...overrides,
  };
}

function payload(overrides = {}) {
  return {
    replay: {
      runnerState: { status: 'EXHAUSTED', cycleCount: 720 },
      stats: {
        totalTrades: 1,
        winRate: 100,
        profitFactor: 2,
        expectancy: 10,
        maxDrawdownPct: 0,
        totalPnl: 10,
        byDirection: {
          BUY: { total: 1, wins: 1, losses: 0, winRate: 100, totalPnl: 10 },
          SELL: { total: 0, wins: 0, losses: 0, winRate: 0, totalPnl: 0 },
        },
      },
      trades: [trade()],
      ...overrides,
    },
    provenance: { sourceType: 'test' },
  };
}

function assertInvalid(value) {
  assert.throws(
    () => presentCanonicalReplay(value),
    { name: 'TypeError', message: 'Invalid canonical replay payload' },
  );
}

test('maps canonical summary statistics and preserves zero values', () => {
  const result = presentCanonicalReplay(payload({
    stats: {
      totalTrades: 0,
      winRate: 0,
      profitFactor: 0,
      expectancy: 0,
      maxDrawdownPct: 0,
      totalPnl: 0,
      byDirection: {
        BUY: { total: 0, wins: 0, losses: 0, winRate: 0, totalPnl: 0 },
        SELL: { total: 0, wins: 0, losses: 0, winRate: 0, totalPnl: 0 },
      },
    },
    trades: [],
  }));

  assert.deepEqual(result.summary, {
    totalTrades: 0,
    winRate: 0,
    profitFactor: 0,
    expectancy: 0,
    maxDrawdownPct: 0,
    totalPnl: 0,
  });
});

test('maps totalPnl, BUY, and SELL canonical statistics', () => {
  const result = presentCanonicalReplay(payload());

  assert.equal(result.summary.totalPnl, 10);
  assert.deepEqual(result.directions.BUY, {
    total: 1, wins: 1, losses: 0, winRate: 100, totalPnl: 10,
  });
  assert.deepEqual(result.directions.SELL, {
    total: 0, wins: 0, losses: 0, winRate: 0, totalPnl: 0,
  });
});

test('preserves the canonical Infinity profit-factor sentinel', () => {
  const result = presentCanonicalReplay(payload({
    stats: { totalTrades: 1, profitFactor: 'Infinity' },
  }));

  assert.equal(result.summary.profitFactor, 'Infinity');
});

test('uses a truthful empty state for a missing direction object', () => {
  const result = presentCanonicalReplay(payload({
    stats: { totalTrades: 0 },
    trades: [],
  }));

  assert.equal(result.directions.BUY, null);
  assert.equal(result.directions.SELL, null);
});

test('maps canonical trades without legacy aliases', () => {
  const result = presentCanonicalReplay(payload());

  assert.deepEqual(result.trades[0], {
    tradeId: 'PT-1',
    direction: 'BUY',
    entry: 100,
    exit: 110,
    stopLoss: 95,
    takeProfit: 110,
    status: 'CLOSED',
    outcome: 'PROFIT',
    exitReason: 'Take Profit',
    durationMs: 3_600_000,
    durationText: '1h 0m',
    entryTime: '2024-01-01T00:00:00.000Z',
    exitTime: '2024-01-01T01:00:00.000Z',
    pnl: 10,
  });
  assert.equal(Object.hasOwn(result.trades[0], 'win'), false);
  assert.equal(Object.hasOwn(result.trades[0], 'rMultiple'), false);
  assert.equal(Object.hasOwn(result.trades[0], 'riskReward'), false);
  assert.equal(Object.hasOwn(result, 'averageR'), false);
  assert.equal(Object.hasOwn(result, 'rejections'), false);
  assert.equal(Object.hasOwn(result, 'candlesAnalyzed'), false);
  assert.equal(Object.hasOwn(result, 'calculationTime'), false);
});

test('maps entryPrice and exitPrice to presentation names', () => {
  const result = presentCanonicalReplay(payload());
  assert.equal(result.trades[0].entry, 100);
  assert.equal(result.trades[0].exit, 110);
});

test('maps PENDING, OPEN, and ACTIVE lifecycle outcomes', () => {
  const result = presentCanonicalReplay(payload({
    trades: [
      trade({ status: 'PENDING', pnl: null }),
      trade({ status: 'OPEN', pnl: null }),
      trade({ status: 'ACTIVE', pnl: null }),
    ],
  }));

  assert.deepEqual(result.trades.map(item => item.outcome), ['PENDING', 'OPEN', 'OPEN']);
});

test('rejects unknown lifecycle statuses without case normalization', () => {
  for (const status of ['closed', 'Closed', 'UNKNOWN', 42, {}]) {
    assertInvalid(payload({ trades: [trade({ status })] }));
  }
});

test('keeps null and undefined lifecycle statuses intentionally optional', () => {
  const missingStatus = trade();
  delete missingStatus.status;
  const result = presentCanonicalReplay(payload({
    trades: [trade({ status: null }), missingStatus],
  }));

  assert.deepEqual(result.trades.map(item => item.outcome), [null, null]);
});

test('classifies closed trades from canonical PnL only', () => {
  const result = presentCanonicalReplay(payload({
    trades: [
      trade({ pnl: 1 }),
      trade({ pnl: -1 }),
      trade({ pnl: 0 }),
      trade({ pnl: null }),
    ],
  }));

  assert.deepEqual(result.trades.map(item => item.outcome), ['PROFIT', 'LOSS', 'BREAKEVEN', 'CLOSED']);
});

test('accepts only finite numeric or exact Infinity profit factors', () => {
  for (const value of [0, 2.5, 'Infinity']) {
    assert.equal(
      presentCanonicalReplay(payload({ stats: { profitFactor: value } })).summary.profitFactor,
      value,
    );
  }

  for (const value of ['bogus', 'infinity', 'Infinity ', Infinity, NaN, {}, [], true, null]) {
    assertInvalid(payload({ stats: { profitFactor: value } }));
  }
});

test('rejects sparse trade arrays and continues mapping dense arrays', () => {
  const sparse = [trade()];
  sparse.length = 2;
  assertInvalid(payload({ trades: new Array(1) }));
  assertInvalid(payload({ trades: sparse }));

  const result = presentCanonicalReplay(payload({ trades: [trade(), trade({ tradeId: 'PT-2' })] }));
  assert.deepEqual(result.trades.map(item => item.tradeId), ['PT-1', 'PT-2']);
});

test('formats elapsed duration deterministically', () => {
  assert.equal(formatDuration(45_000), '45s');
  assert.equal(formatDuration(12 * 60_000), '12m');
  assert.equal(formatDuration(3 * 3_600_000 + 25 * 60_000), '3h 25m');
  assert.equal(formatDuration(2 * 86_400_000 + 4 * 3_600_000), '2d 4h');
  assert.equal(formatDuration(0), '0s');
});

test('formats invalid and missing durations as --', () => {
  assert.equal(formatDuration(null), '--');
  assert.equal(formatDuration(undefined), '--');
  assert.equal(formatDuration(-1), '--');
  assert.equal(formatDuration(NaN), '--');
  assert.equal(formatDuration(Infinity), '--');
});

test('formats exact duration boundaries deterministically', () => {
  assert.deepEqual([
    null, undefined, NaN, Infinity, -1, 0, 999, 1000, 59999, 60000,
    3599999, 3600000, 86399999, 86400000,
  ].map(formatDuration), [
    '--', '--', '--', '--', '--', '0s', '0s', '1s', '59s', '1m',
    '59m', '1h 0m', '23h 59m', '1d 0h',
  ]);
});

test('maps missing optional trade values to null', () => {
  const source = trade();
  delete source.exitPrice;
  delete source.exitReason;
  delete source.duration;
  delete source.exitTime;
  const result = presentCanonicalReplay(payload({ trades: [source] }));

  assert.equal(result.trades[0].exit, null);
  assert.equal(result.trades[0].exitReason, null);
  assert.equal(result.trades[0].durationMs, null);
  assert.equal(result.trades[0].durationText, '--');
  assert.equal(result.trades[0].exitTime, null);
});

test('rejects malformed essential payload structure', () => {
  assertInvalid(null);
  assertInvalid([]);
  assertInvalid({});
  assertInvalid({ replay: null });
  assertInvalid({ replay: { stats: {}, trades: {} } });
  assertInvalid({ replay: { stats: null, trades: [] } });
  assertInvalid({ replay: { stats: {}, trades: [null] } });
});

test('does not reconstruct rejection, candle, timing, or realized-R concepts', () => {
  const result = presentCanonicalReplay(payload({
    stats: {
      totalTrades: 1,
      totalPnl: 10,
      byDirection: {},
      totalRejections: 99,
      averageR: 4,
    },
    candlesAnalyzed: 720,
    calculationTime: 12,
    rejections: [{ reason: 'not a canonical field' }],
  }));

  assert.equal(Object.hasOwn(result, 'rejections'), false);
  assert.equal(Object.hasOwn(result, 'totalRejections'), false);
  assert.equal(Object.hasOwn(result, 'netPnl'), false);
  assert.equal(Object.hasOwn(result, 'longs'), false);
  assert.equal(Object.hasOwn(result, 'shorts'), false);
  assert.equal(Object.hasOwn(result, 'candlesAnalyzed'), false);
  assert.equal(Object.hasOwn(result, 'calculationTime'), false);
  assert.equal(Object.hasOwn(result, 'averageR'), false);
  assert.equal(Object.hasOwn(result.trades[0], 'rMultiple'), false);
  assert.equal(Object.hasOwn(result.trades[0], 'riskReward'), false);
});

test('does not mutate the canonical source object', () => {
  const source = payload();
  const snapshot = structuredClone(source);
  const result = presentCanonicalReplay(source);

  assert.deepEqual(source, snapshot);
  assert.notStrictEqual(result.trades, source.replay.trades);
  assert.equal(Object.isFrozen(result), true);
});
