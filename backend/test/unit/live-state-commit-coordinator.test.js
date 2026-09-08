const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { AdvanceRiskEngine } = require('../../src/engine/advanceRisk');
const { PaperTradingEngine } = require('../../src/engine/paperTrading');
const { createLiveExecutionStateAggregate } = require('../../src/state/liveExecutionStateAggregate');
const { createConfigFingerprint } = require('../../src/state/liveExecutionStateSchema');
const {
  DURABILITY_UNAVAILABLE,
  STATE_QUEUE_FULL,
  MUTATION_UNCERTIFIED,
  createLiveStateCommitCoordinator,
} = require('../../src/state/liveStateCommitCoordinator');

const NOW = Date.parse('2024-01-02T00:00:00.000Z');
const logger = { info() {}, warn() {}, error() {}, system() {} };
const configFingerprint = createConfigFingerprint({
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

function realGraph() {
  const clock = { nowMs: () => NOW, monotonicMs: () => 0 };
  const paperTrading = new PaperTradingEngine({ logger, symbol: 'BTCUSDT', clock });
  const advanceRisk = new AdvanceRiskEngine({ logger, symbol: 'BTCUSDT', paperTradeEngine: paperTrading, config: null, clock });
  const executionPipeline = {
    exportDurableState: () => ({ lastSignalTime: 0, riskSyncFailure: false }),
    prepareDurableState: state => ({ ...state }),
    applyDurableState() {},
  };
  const aggregate = createLiveExecutionStateAggregate({
    symbol: 'BTCUSDT',
    configFingerprint,
    paperTrading,
    advanceRisk,
    executionPipeline,
    now: () => new Date(NOW),
  });
  return { paperTrading, advanceRisk, aggregate };
}

function openRealTrade(paperTrading, price, context = { nowMs: NOW }) {
  return paperTrading.signal({}, price, '1h', 'BUY', {
    stopLoss: price - 4,
    takeProfit: price + 6,
    positionSize: 25,
    riskReward: 2.5,
  }, context);
}

function harness({ write } = {}) {
  let domain = { value: 0 };
  let sequence = 0;
  const writes = [];
  const aggregate = {
    captureDurableDomainState() {
      return structuredClone({ paperTrading: domain });
    },
    captureSnapshotForSequence(nextSequence) {
      return {
        symbol: 'BTCUSDT',
        savedAt: '2024-01-01T00:00:00.000Z',
        mutationSequence: nextSequence,
        configFingerprint: 'sha256:' + 'a'.repeat(64),
        paperTrading: { ...domain },
        advanceRisk: {},
        executionPipeline: {},
      };
    },
    getMutationSequence() {
      return sequence;
    },
    setMutationSequence(nextSequence) {
      sequence = nextSequence;
    },
  };
  const stateStore = {
    async write(snapshot, context) {
      writes.push({ snapshot, context });
      return write ? write(snapshot, context) : { status: 'WRITTEN' };
    },
  };
  return {
    aggregate,
    stateStore,
    writes,
    get domain() { return domain; },
    set domain(next) { domain = next; },
    get sequence() { return sequence; },
  };
}

function auditLogger({ failIntent = false, failCompletion = false } = {}) {
  const events = [];
  let health = 'HEALTHY';
  return {
    events,
    getHealth: () => health,
    async record(event) {
      events.push(event);
      if (event.event.endsWith('_INTENT') && failIntent) {
        health = 'UNSAFE';
        throw Object.assign(new Error('audit intent failed'), { code: 'LOG_FSYNC_FAILED' });
      }
      if (event.event.endsWith('_COMMITTED') && failCompletion) {
        health = 'UNSAFE';
        throw Object.assign(new Error('audit completion failed'), { code: 'LOG_FSYNC_FAILED' });
      }
      return { status: 'DURABLE_CRITICAL_CERTIFIED', record: event };
    },
  };
}

test('starts healthy and serializes queued mutations in invocation order', async () => {
  const state = harness();
  const coordinator = createLiveStateCommitCoordinator(state);
  const order = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  state.stateStore.write = async snapshot => {
    state.writes.push({ snapshot });
    if (snapshot.mutationSequence === 1) await gate;
    return { status: 'WRITTEN' };
  };

  const first = coordinator.runMutation({
    name: 'first',
    mutate: () => {
      order.push('first-start');
      state.domain = { value: 1 };
      order.push('first-end');
    },
  });
  const second = coordinator.runMutation({
    name: 'second',
    mutate: () => {
      order.push('second-start');
      state.domain = { value: 2 };
      order.push('second-end');
    },
  });

  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['first-start', 'first-end']);
  assert.equal(state.writes.length, 1);
  assert.equal(coordinator.isDurabilityHealthy(), true);

  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first-start', 'first-end', 'second-start', 'second-end']);
  assert.deepEqual(state.writes.map(write => write.snapshot.mutationSequence), [1, 2]);
  assert.equal(state.sequence, 2);
});

test('rejects the sixth admitted coordinator item before retaining or invoking it', async () => {
  const state = harness();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  state.stateStore.write = async () => gate.then(() => ({ status: 'WRITTEN' }));
  const coordinator = createLiveStateCommitCoordinator(state);

  const first = coordinator.runMutation({
    name: 'active',
    mutate: () => { state.domain = { value: 1 }; },
  });
  await new Promise(resolve => setImmediate(resolve));

  const waiting = Array.from({ length: 4 }, (_, index) => coordinator.runMutation({
    name: `waiting-${index}`,
    mutate: () => undefined,
  }));
  let called = false;
  await assert.rejects(
    coordinator.runMutation({
      name: 'sixth',
      mutate: () => { called = true; },
    }),
    error => error.code === STATE_QUEUE_FULL,
  );
  assert.equal(called, false);
  assert.equal(coordinator.getStatus().queueDepth, 5);
  assert.equal(coordinator.getStatus().commitQueueRejects, 1);

  release();
  await Promise.all([first, ...waiting]);
  assert.equal(coordinator.getStatus().queueDepth, 0);
});

test('queue-full committed reads do not execute their callback', async () => {
  const state = harness();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  state.stateStore.write = async () => gate.then(() => ({ status: 'WRITTEN' }));
  const coordinator = createLiveStateCommitCoordinator(state);

  const active = coordinator.runMutation({
    name: 'active',
    mutate: () => { state.domain = { value: 1 }; },
  });
  await new Promise(resolve => setImmediate(resolve));
  const waiting = Array.from({ length: 4 }, () => coordinator.readCommitted(() => 'waiting'));
  let called = false;
  await assert.rejects(
    coordinator.readCommitted(() => {
      called = true;
      return 'rejected';
    }),
    error => error.code === STATE_QUEUE_FULL,
  );
  assert.equal(called, false);
  release();
  assert.deepEqual(await Promise.all([active, ...waiting]), [undefined, 'waiting', 'waiting', 'waiting', 'waiting']);
});

test('no-op mutations do not write or advance the sequence', async () => {
  const state = harness();
  const coordinator = createLiveStateCommitCoordinator(state);

  const result = await coordinator.runMutation({
    name: 'no-op',
    mutate: () => 'unchanged',
  });

  assert.equal(result, 'unchanged');
  assert.equal(state.writes.length, 0);
  assert.equal(state.sequence, 0);
  assert.equal(coordinator.isDurabilityHealthy(), true);
});

test('changed mutations write N+1 and advance only after certified success', async () => {
  const state = harness();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  state.stateStore.write = async snapshot => {
    state.writes.push({ snapshot });
    await gate;
    return { status: 'WRITTEN' };
  };
  const coordinator = createLiveStateCommitCoordinator(state);

  const pending = coordinator.runMutation({
    name: 'changed',
    mutate: () => { state.domain = { value: 4 }; },
  });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(state.writes[0].snapshot.mutationSequence, 1);
  assert.equal(state.sequence, 0);
  release();
  await pending;
  assert.equal(state.sequence, 1);
});

test('a non-mutating callback error preserves health and does not write', async () => {
  const state = harness();
  const coordinator = createLiveStateCommitCoordinator(state);
  const error = new Error('validation rejected');

  await assert.rejects(
    coordinator.runMutation({ name: 'validation', mutate: () => { throw error; } }),
    cause => cause === error,
  );
  assert.equal(state.writes.length, 0);
  assert.equal(state.sequence, 0);
  assert.equal(coordinator.isDurabilityHealthy(), true);
});

test('a partial callback error latches unsafe without speculative write', async () => {
  const state = harness();
  const coordinator = createLiveStateCommitCoordinator(state);

  await assert.rejects(
    coordinator.runMutation({
      name: 'partial',
      mutate: () => {
        state.domain = { value: 9 };
        throw new Error('partial mutation');
      },
    }),
    error => error.code === MUTATION_UNCERTIFIED,
  );
  assert.equal(state.writes.length, 0);
  assert.equal(state.sequence, 0);
  assert.equal(coordinator.isDurabilityHealthy(), false);

  let called = false;
  await assert.rejects(
    coordinator.runMutation({ name: 'later', mutate: () => { called = true; } }),
    error => error.code === DURABILITY_UNAVAILABLE,
  );
  assert.equal(called, false);
  await assert.rejects(coordinator.readCommitted(() => state.domain), error => error.code === DURABILITY_UNAVAILABLE);
});

test('a failed durable write latches unsafe and rejects later work', async () => {
  const state = harness({
    write: async () => {
      const error = new Error('fsync failed');
      error.code = 'STATE_FSYNC_FAILED';
      throw error;
    },
  });
  const coordinator = createLiveStateCommitCoordinator(state);

  await assert.rejects(
    coordinator.runMutation({ name: 'write-failure', mutate: () => { state.domain = { value: 2 }; } }),
    error => error.code === DURABILITY_UNAVAILABLE && error.cause.code === 'STATE_FSYNC_FAILED',
  );
  assert.equal(state.sequence, 0);
  assert.equal(coordinator.getStatus().durabilityHealthy, false);
  await assert.rejects(coordinator.runMutation({ name: 'later', mutate: () => {} }), error => error.code === DURABILITY_UNAVAILABLE);
});

test('a queued mutation rechecks the unsafe latch before invoking its callback', async () => {
  const state = harness();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  state.stateStore.write = async () => {
    await gate;
    const error = new Error('rename failed');
    error.code = 'STATE_RENAME_FAILED';
    throw error;
  };
  const coordinator = createLiveStateCommitCoordinator(state);
  const first = coordinator.runMutation({ name: 'first', mutate: () => { state.domain = { value: 1 }; } });
  let secondCalled = false;
  const second = coordinator.runMutation({ name: 'second', mutate: () => { secondCalled = true; } });

  release();
  await assert.rejects(first, error => error.code === DURABILITY_UNAVAILABLE);
  await assert.rejects(second, error => error.code === DURABILITY_UNAVAILABLE);
  assert.equal(secondCalled, false);
});

test('a post-write sequence apply failure latches unsafe after certified storage', async () => {
  const state = harness();
  state.aggregate.setMutationSequence = () => { throw new Error('sequence apply failed'); };
  const coordinator = createLiveStateCommitCoordinator(state);

  await assert.rejects(
    coordinator.runMutation({ name: 'sequence-apply', mutate: () => { state.domain = { value: 3 }; } }),
    error => error.code === DURABILITY_UNAVAILABLE && error.cause.message === 'sequence apply failed',
  );
  assert.equal(state.writes.length, 1);
  assert.equal(coordinator.isDurabilityHealthy(), false);
});

test('committed reads wait behind a successful mutation', async () => {
  const state = harness();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  state.stateStore.write = async snapshot => {
    state.writes.push({ snapshot });
    await gate;
    return { status: 'WRITTEN' };
  };
  const coordinator = createLiveStateCommitCoordinator(state);
  const mutation = coordinator.runMutation({
    name: 'read-barrier',
    mutate: () => { state.domain = { value: 7 }; },
  });
  const read = coordinator.readCommitted(() => state.domain.value);

  let settled = false;
  read.then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  release();
  await mutation;
  assert.equal(await read, 7);
});

test('thenable mutation callbacks are rejected without allowing async interleaving', async () => {
  const state = harness();
  const coordinator = createLiveStateCommitCoordinator(state);

  await assert.rejects(
    coordinator.runMutation({ name: 'async-callback', mutate: () => Promise.resolve() }),
    error => error instanceof TypeError,
  );
  assert.equal(state.writes.length, 0);
  assert.equal(coordinator.isDurabilityHealthy(), true);
});

test('commits a real PaperTrading open exactly once', async () => {
  const graph = realGraph();
  const writes = [];
  const coordinator = createLiveStateCommitCoordinator({
    aggregate: graph.aggregate,
    stateStore: { write: async snapshot => { writes.push(snapshot); return { status: 'WRITTEN' }; } },
  });

  const trade = await coordinator.runMutation({ name: 'real-paper-open', mutate: () => openRealTrade(graph.paperTrading, 100) });

  assert.equal(trade.tradeId, 'PT-1');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].mutationSequence, 1);
  assert.equal(writes[0].paperTrading.trades[0].tradeId, 'PT-1');
});

test('commits real overflow closure, risk sync, and replacement as one write', async () => {
  const graph = realGraph();
  graph.paperTrading._maxTrades = 1;
  const first = openRealTrade(graph.paperTrading, 100);
  const writes = [];
  const coordinator = createLiveStateCommitCoordinator({
    aggregate: graph.aggregate,
    stateStore: { write: async snapshot => { writes.push(snapshot); return { status: 'WRITTEN' }; } },
  });

  await coordinator.runMutation({
    name: 'real-overflow-replacement',
    mutate: () => openRealTrade(graph.paperTrading, 110, {
      nowMs: NOW,
      beforeOpen: prepareOverflow => {
        for (const closed of prepareOverflow()) graph.advanceRisk.onTradeClosed(closed.pnl, { nowMs: NOW });
      },
    }),
  });

  assert.equal(writes.length, 1);
  assert.equal(writes[0].paperTrading.trades.length, 1);
  assert.equal(writes[0].paperTrading.trades[0].tradeId, 'PT-2');
  assert.equal(writes[0].paperTrading.closedTrades.length, 1);
  assert.equal(writes[0].advanceRisk.dailyPnL, 0);
  assert.equal(first.status, 'OPEN');
});

test('audited mutations certify intent before callback and completion after state commit', async () => {
  const state = harness();
  const audit = auditLogger();
  const order = [];
  const coordinator = createLiveStateCommitCoordinator({ ...state, logger: audit });

  await coordinator.runMutation({
    name: 'audited-close',
    audit: {
      intent: {
        event: 'PAPER_TRADE_CLOSE_INTENT',
        source: 'test',
        category: 'audit',
        message: 'intent',
        context: { tradeId: 'PT-1', reason: 'Manual', operation: 'audited-close' },
      },
      completion: ({ mutationSequence }) => ({
        event: 'PAPER_TRADE_CLOSE_COMMITTED',
        source: 'test',
        category: 'audit',
        message: 'completion',
        context: {
          tradeId: 'PT-1',
          reason: 'Manual',
          operation: 'audited-close',
          outcome: 'CLOSED',
          pnl: 5,
          mutationSequence,
        },
      }),
    },
    mutate: () => {
      order.push('mutation');
      state.domain = { value: 1 };
      order.push('state');
    },
  });

  assert.deepEqual(audit.events.map(event => event.event), [
    'PAPER_TRADE_CLOSE_INTENT',
    'PAPER_TRADE_CLOSE_COMMITTED',
  ]);
  assert.equal(audit.events[0].correlationId, audit.events[1].correlationId);
  assert.deepEqual(order, ['mutation', 'state']);
  assert.equal(audit.events[1].context.mutationSequence, 1);
});

test('audit intent failure prevents the domain callback', async () => {
  const state = harness();
  const audit = auditLogger({ failIntent: true });
  const coordinator = createLiveStateCommitCoordinator({ ...state, logger: audit });
  let called = false;

  await assert.rejects(
    coordinator.runMutation({
      name: 'audited-intent-failure',
      audit: {
        intent: {
          event: 'PAPER_TRADE_CLOSE_INTENT',
          source: 'test',
          category: 'audit',
          message: 'intent',
          context: { tradeId: 'PT-1', reason: 'Manual', operation: 'audited-intent-failure' },
        },
        completion: { event: 'PAPER_TRADE_CLOSE_COMMITTED', source: 'test', category: 'audit', message: 'completion', context: {} },
      },
      mutate: () => { called = true; },
    }),
    error => error.code === 'AUDIT_INTENT_FAILED',
  );
  assert.equal(called, false);
  assert.equal(state.writes.length, 0);
});

test('audit completion failure leaves committed state and gates later audited work', async () => {
  const state = harness();
  const audit = auditLogger({ failCompletion: true });
  const coordinator = createLiveStateCommitCoordinator({ ...state, logger: audit });
  const descriptor = {
    intent: { event: 'PAPER_TRADE_CLOSE_INTENT', source: 'test', category: 'audit', message: 'intent', context: { tradeId: 'PT-1', reason: 'Manual', operation: 'completion-failure' } },
    completion: { event: 'PAPER_TRADE_CLOSE_COMMITTED', source: 'test', category: 'audit', message: 'completion', context: { tradeId: 'PT-1', reason: 'Manual', operation: 'completion-failure', outcome: 'CLOSED', pnl: 1, mutationSequence: 1 } },
  };

  await assert.rejects(
    coordinator.runMutation({ name: 'completion-failure', audit: descriptor, mutate: () => { state.domain = { value: 3 }; } }),
    error => error.code === 'AUDIT_COMPLETION_FAILED',
  );
  assert.equal(state.writes.length, 1);
  assert.equal(state.sequence, 1);
  assert.equal(coordinator.isDurabilityHealthy(), true);

  let called = false;
  await assert.rejects(
    coordinator.runMutation({ name: 'later-audited', audit: descriptor, mutate: () => { called = true; } }),
    error => error.code === 'AUDIT_UNSAFE',
  );
  assert.equal(called, false);
});

test('PH-4E is active in the current server composition', () => {
  const serverPath = path.join(__dirname, '../../server.js');
  const source = fs.readFileSync(serverPath, 'utf8');

  assert.match(source, /createAtomicJsonStateStore/);
  assert.match(source, /createLiveExecutionStateAggregate/);
  assert.match(source, /createLiveStateCommitCoordinator/);
  assert.match(source, /recoverLiveState/);
  assert.match(source, /emitAsync\(/);
});
