const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createAtomicJsonStateStore } = require('../../src/state/atomicJsonStateStore');
const { LiveStateError, createConfigFingerprint } = require('../../src/state/liveExecutionStateSchema');

const NOW = Date.parse('2024-01-02T00:00:00.000Z');
const context = {
  expectedFingerprint: createConfigFingerprint({
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
  }),
  expectedSymbol: 'BTCUSDT',
  nowMs: NOW,
};

function state(sequence = 0) {
  return {
    schemaVersion: 1,
    stateType: 'live-execution-state',
    symbol: 'BTCUSDT',
    savedAt: '2024-01-02T00:00:00.000Z',
    mutationSequence: sequence,
    configFingerprint: context.expectedFingerprint,
    paperTrading: { tradeCounter: 0, lastPrice: null, balance: 10000, initialBalance: 10000, peakEquity: 10000, trades: [], closedTrades: [] },
    advanceRisk: { accountBalance: 10000, dailyPnL: 0, dailyHighWater: 10000, consecutiveLosses: 0, lossPauseUntil: 0, dailyLossLimitReached: false, tradingEnabled: true, lastResetDay: '2024-01-02', riskStateHealthy: true },
    executionPipeline: { lastSignalTime: 0, riskSyncFailure: false },
  };
}

async function tempDirectory() {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), 'atlas-ph4b-'));
}

function injectedFs(failure = null, gate = null, trace = []) {
  const api = fs.promises;
  return {
    constants: fs.constants,
    mkdir: (...args) => {
      trace.push({ method: 'mkdir', args });
      return failure === 'mkdir' ? Promise.reject(new Error('mkdir failure')) : api.mkdir(...args);
    },
    readFile: (...args) => api.readFile(...args),
    readdir: (...args) => api.readdir(...args),
    rename: (...args) => {
      trace.push({ method: 'rename', args });
      return failure === 'rename' ? Promise.reject(new Error('rename failure')) : api.rename(...args);
    },
    unlink: (...args) => {
      trace.push({ method: 'unlink', args });
      return failure === 'unlink' ? Promise.reject(new Error('cleanup failure')) : api.unlink(...args);
    },
    open: async (...args) => {
      trace.push({ method: 'open', args });
      const target = args[0];
      if (failure === 'temp-open' && target.endsWith('.tmp')) throw new Error('temp open failure');
      if (failure === 'directory-open' && !target.endsWith('.tmp')) throw new Error('directory open failure');
      const handle = await api.open(...args);
      return {
        async writeFile(bytes) {
          if (failure === 'write') throw new Error('write failure');
          if (gate) await gate;
          return handle.writeFile(bytes);
        },
        async sync() {
          if (failure === 'file-sync' && target.endsWith('.tmp')) throw new Error('file fsync failure');
          if (failure === 'directory-sync' && !target.endsWith('.tmp')) throw new Error('directory fsync failure');
          return handle.sync();
        },
        close: async () => {
          if (failure === 'close' && target.endsWith('.tmp')) {
            await handle.close();
            throw new Error('close failure');
          }
          if (failure === 'directory-close' && !target.endsWith('.tmp')) {
            await handle.close();
            throw new Error('directory close failure');
          }
          return handle.close();
        },
      };
    },
  };
}

async function removeDirectory(directory) {
  await fs.promises.rm(directory, { recursive: true, force: true });
}

test('writes and reads a valid state without changing mutationSequence', async () => {
  const directory = await tempDirectory();
  try {
    const filePath = path.join(directory, 'state.json');
    const store = createAtomicJsonStateStore({ filePath, fsAdapter: injectedFs(), now: () => NOW });
    assert.deepEqual(await store.write(state(17), context), { status: 'WRITTEN' });
    const result = await store.read(context);
    assert.equal(result.status, 'VALID');
    assert.equal(result.state.mutationSequence, 17);
    assert.equal(result.recovery.tempPresent, false);
    assert.equal(Object.isFrozen(result.state), true);
  } finally {
    await removeDirectory(directory);
  }
});

test('returns NOT_FOUND and never creates default state', async () => {
  const directory = await tempDirectory();
  try {
    const filePath = path.join(directory, 'state.json');
    const store = createAtomicJsonStateStore({ filePath, fsAdapter: injectedFs(), now: () => NOW });
    assert.deepEqual(await store.read(context), { status: 'NOT_FOUND' });
    assert.equal(fs.existsSync(filePath), false);
  } finally {
    await removeDirectory(directory);
  }
});

test('classifies parse, schema, and context failures', async () => {
  const directory = await tempDirectory();
  try {
    const filePath = path.join(directory, 'state.json');
    const store = createAtomicJsonStateStore({ filePath, fsAdapter: injectedFs(), now: () => NOW });
    await fs.promises.writeFile(filePath, '');
    await assert.rejects(store.read(context), error => error.code === 'STATE_PARSE_FAILED');
    await fs.promises.writeFile(filePath, JSON.stringify({ ...state(), schemaVersion: 2 }));
    await assert.rejects(store.read(context), error => error.code === 'STATE_SCHEMA_UNSUPPORTED');
    await fs.promises.writeFile(filePath, JSON.stringify({ ...state(), configFingerprint: 'sha256:' + '0'.repeat(64) }));
    await assert.rejects(store.read(context), error => error.code === 'STATE_CONTEXT_MISMATCH');
  } finally {
    await removeDirectory(directory);
  }
});

test('matching stale temp never overrides, promotes, or deletes primary evidence', async () => {
  const directory = await tempDirectory();
  try {
    const filePath = path.join(directory, 'state.json');
    const tempPath = path.join(directory, '.state.json.1.deadbeef.tmp');
    const store = createAtomicJsonStateStore({ filePath, fsAdapter: injectedFs(), now: () => NOW });
    await store.write(state(1), context);
    await fs.promises.writeFile(tempPath, JSON.stringify(state(99)));
    const valid = await store.read(context);
    assert.equal(valid.status, 'VALID');
    assert.equal(valid.state.mutationSequence, 1);
    assert.equal(valid.recovery.tempPresent, true);
    assert.equal(fs.existsSync(tempPath), true);

    await fs.promises.unlink(filePath);
    await assert.rejects(store.read(context), error => error.code === 'STATE_RECOVERY_FAILED');
    assert.equal(fs.existsSync(tempPath), true);

    await fs.promises.writeFile(filePath, '{');
    await assert.rejects(store.read(context), error => error.code === 'STATE_RECOVERY_FAILED');
    assert.equal(fs.existsSync(tempPath), true);
  } finally {
    await removeDirectory(directory);
  }
});

test('unrelated temp files are ignored and writes use exclusive same-directory temps', async () => {
  const directory = await tempDirectory();
  try {
    const filePath = path.join(directory, 'state.json');
    const trace = [];
    const store = createAtomicJsonStateStore({ filePath, fsAdapter: injectedFs(null, null, trace), now: () => NOW });
    const unrelated = path.join(directory, '.other.json.1.deadbeef.tmp');
    await fs.promises.writeFile(unrelated, 'evidence');
    assert.deepEqual(await store.read(context), { status: 'NOT_FOUND' });
    await store.write(state(1), context);
    const tempOpen = trace.find(call => call.method === 'open' && call.args[0].endsWith('.tmp'));
    assert.ok(tempOpen);
    assert.equal(tempOpen.args[1], 'wx');
    assert.equal(path.dirname(tempOpen.args[0]), directory);
    assert.equal(fs.existsSync(unrelated), true);
  } finally {
    await removeDirectory(directory);
  }
});

test('validation happens before disk touch and pre-rename failures preserve primary', async () => {
  const directory = await tempDirectory();
  try {
    const filePath = path.join(directory, 'state.json');
    let touched = false;
    const noTouch = injectedFs();
    for (const method of ['mkdir', 'open', 'rename', 'unlink']) {
      const original = noTouch[method];
      noTouch[method] = (...args) => { touched = true; return original(...args); };
    }
    const store = createAtomicJsonStateStore({ filePath, fsAdapter: noTouch, now: () => NOW });
    await assert.rejects(store.write({ ...state(), mutationSequence: -1 }, context), error => error.code === 'STATE_VALIDATION_FAILED');
    assert.equal(touched, false);

    await store.write(state(1), context);
    for (const failure of ['mkdir', 'temp-open', 'write', 'file-sync', 'close', 'rename']) {
      const failing = createAtomicJsonStateStore({ filePath, fsAdapter: injectedFs(failure), now: () => NOW });
      await assert.rejects(failing.write(state(2), context), error => [
        'STATE_WRITE_FAILED', 'STATE_FSYNC_FAILED', 'STATE_RENAME_FAILED',
      ].includes(error.code));
      const preserved = await store.read(context);
      assert.equal(preserved.state.mutationSequence, 1);
    }

    const cleanupFs = injectedFs('write');
    cleanupFs.unlink = () => Promise.reject(new Error('cleanup failure'));
    const cleanupFailure = createAtomicJsonStateStore({ filePath, fsAdapter: cleanupFs, now: () => NOW });
    await assert.rejects(cleanupFailure.write(state(2), context), error => error.code === 'STATE_WRITE_FAILED');
  } finally {
    await removeDirectory(directory);
  }
});

test('directory open and close failures are reported after rename without rollback', async () => {
  const directory = await tempDirectory();
  try {
    const filePath = path.join(directory, 'state.json');
    for (const failure of ['directory-open', 'directory-close']) {
      const failing = createAtomicJsonStateStore({ filePath, fsAdapter: injectedFs(failure), now: () => NOW });
      await assert.rejects(failing.write(state(2), context), error => error.code === 'STATE_FSYNC_FAILED'
        && error.durability === 'uncertified');
      assert.equal(JSON.parse(await fs.promises.readFile(filePath, 'utf8')).mutationSequence, 2);
      await fs.promises.unlink(filePath);
    }
  } finally {
    await removeDirectory(directory);
  }
});

test('post-rename directory fsync failure is uncertified and guard clears', async () => {
  const directory = await tempDirectory();
  try {
    const filePath = path.join(directory, 'state.json');
    const failing = createAtomicJsonStateStore({ filePath, fsAdapter: injectedFs('directory-sync'), now: () => NOW });
    await assert.rejects(failing.write(state(2), context), error => error.code === 'STATE_FSYNC_FAILED'
      && error.durability === 'uncertified');
    const succeeding = createAtomicJsonStateStore({ filePath, fsAdapter: injectedFs(), now: () => NOW });
    await succeeding.write(state(3), context);
    assert.equal((await succeeding.read(context)).state.mutationSequence, 3);
  } finally {
    await removeDirectory(directory);
  }
});

test('overlapping writes reject instead of queueing', async () => {
  const directory = await tempDirectory();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  try {
    const filePath = path.join(directory, 'state.json');
    const store = createAtomicJsonStateStore({ filePath, fsAdapter: injectedFs(null, gate), now: () => NOW });
    const first = store.write(state(1), context);
    await assert.rejects(store.write(state(2), context), error => error instanceof LiveStateError && error.code === 'STATE_WRITE_IN_PROGRESS');
    release();
    await first;
  } finally {
    release?.();
    await removeDirectory(directory);
  }
});
