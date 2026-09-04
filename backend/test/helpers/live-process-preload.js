const fs = require('node:fs');
const path = require('node:path');

const mode = process.env.LIVE_TEST_MODE || 'none';
const marketMode = process.env.LIVE_TEST_MARKET_MODE || 'idle';
const barrierPath = process.env.LIVE_TEST_BARRIER_PATH;

function signalBarrier() {
  if (barrierPath) fs.writeFileSync(barrierPath, 'reached');
}

function blockBarrier() {
  signalBarrier();
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}

async function waitForRelease() {
  signalBarrier();
  while (!fs.existsSync(`${barrierPath}.release`)) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

const mockedFetch = async url => {
  const target = String(url);
  if (target.includes('/coins/bitcoin/ohlc')) {
    return { ok: true, status: 200, async json() { return []; } };
  }
  if (target.includes('/market_chart')) {
    return { ok: true, status: 200, async json() { return { prices: [], total_volumes: [] }; } };
  }
  if (target.includes('/simple/price')) {
    return {
      ok: true,
      status: 200,
      async json() {
        return { bitcoin: { usd: 100, usd_24h_vol: 1, usd_24h_change: 0 } };
      },
    };
  }
  throw new Error(`Unexpected test URL: ${target}`);
};

const fetchPath = require.resolve('node-fetch');
require.cache[fetchPath] = {
  id: fetchPath,
  filename: fetchPath,
  loaded: true,
  exports: mockedFetch,
};

const apiManagerPath = require.resolve('../../src/network/apiManager');
const { ApiManager } = require(apiManagerPath);
let marketCall = 0;
ApiManager.prototype.fetchMarketData = async function () {
  if (marketMode === 'open' && marketCall++ === 0) {
    const timestamp = new Date(Date.now()).toISOString();
    const snapshot = { symbol: 'BTCUSDT', price: 100, volume: 1, timestamp };
    return {
      status: 'FRESH',
      snapshot,
      provenance: {
        source: 'PH-4F', observedAt: timestamp, sourceTimestamp: null,
        effectiveAgeMs: 0, cacheAgeMs: null, fallbackReason: null,
      },
    };
  }
  return {
    status: 'PROVIDER_UNAVAILABLE',
    snapshot: null,
    provenance: {
      source: 'PH-4F', observedAt: null, sourceTimestamp: null,
      effectiveAgeMs: null, cacheAgeMs: null, fallbackReason: 'PROVIDER_UNAVAILABLE',
    },
  };
};

if (marketMode === 'open') {
  const pipelinePath = require.resolve('../../src/core/executionPipeline');
  const pipelineModule = require(pipelinePath);
  const createExecutionPipeline = pipelineModule.createExecutionPipeline;
  pipelineModule.createExecutionPipeline = dependencies => {
    const pipeline = createExecutionPipeline(dependencies);
    const run = pipeline.run;
    pipeline.run = (...args) => {
      const result = run(...args);
      if (dependencies.paperTradeEngine.all().length === 0) {
        const price = args[0]?.price || 100;
        dependencies.paperTradeEngine.signal({}, price, '1h', 'BUY', {
          stopLoss: price - 4,
          takeProfit: price + 6,
          positionSize: 25,
          riskReward: 2.5,
        });
      }
      return result;
    };
    return pipeline;
  };
}

const storePath = require.resolve('../../src/state/atomicJsonStateStore');
const storeModule = require(storePath);
const createAtomicJsonStateStore = storeModule.createAtomicJsonStateStore;
storeModule.createAtomicJsonStateStore = options => {
  const store = createAtomicJsonStateStore(options);
  let read = store.read;
  let write = store.write;
  if (mode === 'before-write' || mode === 'deferred-write' || mode === 'init-after-write') {
    write = async (...args) => {
      if (mode === 'before-write') blockBarrier();
      if (mode === 'deferred-write') await waitForRelease();
      const result = await store.write(...args);
      if (mode === 'init-after-write') blockBarrier();
      return result;
    };
  }
  if (mode === 'delayed-read') {
    read = async (...args) => {
      await waitForRelease();
      return store.read(...args);
    };
  }
  return Object.freeze({ ...store, read, write });
};

if (mode === 'after-commit') {
  const coordinatorPath = require.resolve('../../src/state/liveStateCommitCoordinator');
  const coordinatorModule = require(coordinatorPath);
  const createCoordinator = coordinatorModule.createLiveStateCommitCoordinator;
  coordinatorModule.createLiveStateCommitCoordinator = options => {
    const coordinator = createCoordinator(options);
    const runMutation = coordinator.runMutation;
    const wrappedRunMutation = mutation => {
      const result = runMutation(mutation);
      if (mutation?.name !== 'manual-close') return result;
      return result.then(value => {
        blockBarrier();
        return value;
      });
    };
    return Object.freeze({ ...coordinator, runMutation: wrappedRunMutation });
  };
}
