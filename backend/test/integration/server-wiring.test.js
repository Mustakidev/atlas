const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const BACKEND = path.join(__dirname, '../..');
const NODE_FETCH_ENTRY = path.join(BACKEND, 'node_modules/node-fetch');
const API_KEY = 'server-wiring-test-api-key-32-characters';

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function request(port, requestPath, headers = { 'x-api-key': API_KEY }) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: requestPath, headers }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        let json;
        try {
          json = JSON.parse(body);
        } catch (error) {
          reject(new Error(`Expected JSON from ${requestPath}: ${error.message}; body=${body}`));
          return;
        }
        resolve({ statusCode: res.statusCode, headers: res.headers, body: json });
      });
    });
    req.once('error', reject);
  });
}

function readProbe(probePath) {
  return JSON.parse(fs.readFileSync(probePath, 'utf8'));
}

function waitForCycle(port, probePath, expectedCycle) {
  const deadline = Date.now() + 30000;

  return new Promise((resolve, reject) => {
    const poll = async () => {
      try {
        const statusResponse = await request(port, '/api/status');
        const probe = readProbe(probePath);
        const cycle = statusResponse.body.pipeline?.pipelineCycleCount;
        if (cycle === expectedCycle) {
          resolve({ statusResponse, probe });
          return;
        }
        if (Date.now() >= deadline) {
          reject(new Error(`Expected pipeline cycle ${expectedCycle}, observed ${cycle}`));
          return;
        }
        setTimeout(poll, 50);
      } catch (error) {
        if (Date.now() >= deadline) {
          reject(error);
          return;
        }
        setTimeout(poll, 50);
      }
    };

    poll();
  });
}

async function waitForProbeCondition(port, probePath, condition) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const statusResponse = await request(port, '/api/status');
    const probe = readProbe(probePath);
    if (condition(probe, statusResponse)) return { statusResponse, probe };
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  throw new Error('Timed out waiting for probe condition');
}

function waitForStartup(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`Server did not start. Output: ${output}`)), 30000);

    child.stdout.on('data', chunk => {
      output += chunk.toString();
      if (output.includes('Atlas v1.0 running on port')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.stderr.on('data', chunk => { output += chunk.toString(); });
    child.once('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function stopServer(child) {
  if (child.exitCode !== null) return Promise.resolve();

  return new Promise(resolve => {
    const timeout = setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }, 5000);
    child.once('close', () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

test('production server wires config into route dependencies', async () => {
  const port = await reservePort();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-server-wiring-'));
  const preloadPath = path.join(tempDir, 'mock-fetch.js');
  const probePath = path.join(tempDir, 'pipeline-probe.json');
  const executionPipelineEntry = path.join(BACKEND, 'src/core/executionPipeline.js');
  const paperTradingEntry = path.join(BACKEND, 'src/engine/paperTrading.js');
  const advanceRiskEntry = path.join(BACKEND, 'src/engine/advanceRisk.js');
  const eventBusEntry = path.join(BACKEND, 'src/core/eventBus.js');
  const apiManagerEntry = path.join(BACKEND, 'src/network/apiManager.js');
  const analyzerEntry = path.join(BACKEND, 'src/engine/analyzer.js');
  const signalHistoryEntry = path.join(BACKEND, 'src/engine/signalHistory.js');
  const preload = `
const fs = require('node:fs');
const fetchPath = require.resolve(${JSON.stringify(NODE_FETCH_ENTRY)});
const probePath = ${JSON.stringify(probePath)};
const counters = {
  createExecutionPipeline: 0,
  pipelineRun: 0,
  paperEvaluateTrades: 0,
  paperOnCandle: 0,
  paperSignal: 0,
  advanceRiskEvaluate: 0,
  advanceRiskOnTradeClosed: 0,
  simplePriceFetch: 0,
  marketSnapshotEmitCount: 0,
  marketDataCalls: 0,
};
const pipelineCalls = [];
const marketSnapshotEmits = [];
const order = [];
let lastMarketSnapshotEvent = null;
function saveProbe() {
  fs.writeFileSync(probePath, JSON.stringify({ ...counters, pipelineCalls, marketSnapshotEmits, order }));
}
function count(name) {
  counters[name]++;
  saveProbe();
}

const eventBusPath = require.resolve(${JSON.stringify(eventBusEntry)});
const { EventBus } = require(eventBusPath);
const originalEmit = EventBus.prototype.emit;
EventBus.prototype.emit = function (event, ...args) {
  if (event === 'market:snapshot') {
    counters.marketSnapshotEmitCount++;
    lastMarketSnapshotEvent = { snapshot: args[0], transition: args[1] };
    marketSnapshotEmits.push({
      argumentCount: args.length,
      price: args[0]?.price,
      timestamp: args[0]?.timestamp,
      oneHourOpenTime: args[1]?.finalized?.['1h']?.openTime ?? null,
    });
    saveProbe();
  }
  return originalEmit.apply(this, [event, ...args]);
};

const { MarketAnalyzer } = require(${JSON.stringify(analyzerEntry)});
const originalAnalyze = MarketAnalyzer.prototype.analyze;
MarketAnalyzer.prototype.analyze = function (...args) {
  order.push('analyzer');
  saveProbe();
  return originalAnalyze.apply(this, args);
};

const { SignalHistoryEngine } = require(${JSON.stringify(signalHistoryEntry)});
const originalRecord = SignalHistoryEngine.prototype.record;
SignalHistoryEngine.prototype.record = function (...args) {
  order.push('signalHistory');
  saveProbe();
  return originalRecord.apply(this, args);
};

const executionPipelinePath = require.resolve(${JSON.stringify(executionPipelineEntry)});
const executionPipeline = require(executionPipelinePath);
const createExecutionPipeline = executionPipeline.createExecutionPipeline;
executionPipeline.createExecutionPipeline = dependencies => {
  count('createExecutionPipeline');
  const pipeline = createExecutionPipeline(dependencies);
  const run = pipeline.run;
  pipeline.run = (...args) => {
    count('pipelineRun');
    order.push('pipeline');
    const [snapshot, options] = args;
    const transition = lastMarketSnapshotEvent?.transition;
    const active = dependencies.candleEngine.getActive('1h');
    const candles = dependencies.candleEngine.getCandles('1h');
    const finalized = active && candles[candles.length - 1]?.openTime === active.openTime
      ? candles.slice(0, -1)
      : candles;
    pipelineCalls.push({
      argumentCount: args.length,
      price: snapshot?.price,
      sameSnapshot: snapshot === lastMarketSnapshotEvent?.snapshot,
      lifecycleOpenTime: options?.lifecycleCandle?.openTime ?? null,
      activeOpenTime: active?.openTime ?? null,
      finalizedOpenTimes: finalized.map(candle => candle.openTime),
      sameLifecycle: options?.lifecycleCandle === transition?.finalized?.['1h'],
    });
    saveProbe();
    return run(...args);
  };
  return pipeline;
};

const { PaperTradingEngine } = require(${JSON.stringify(paperTradingEntry)});
const paperMethods = {
  evaluateTrades: 'paperEvaluateTrades',
  onCandle: 'paperOnCandle',
  signal: 'paperSignal',
};
for (const [method, counter] of Object.entries(paperMethods)) {
  const original = PaperTradingEngine.prototype[method];
  PaperTradingEngine.prototype[method] = function (...args) {
    count(counter);
    return original.apply(this, args);
  };
}

const { AdvanceRiskEngine } = require(${JSON.stringify(advanceRiskEntry)});
for (const [method, counter] of Object.entries({ evaluate: 'advanceRiskEvaluate', onTradeClosed: 'advanceRiskOnTradeClosed' })) {
  const original = AdvanceRiskEngine.prototype[method];
  AdvanceRiskEngine.prototype[method] = function (...args) {
    count(counter);
    return original.apply(this, args);
  };
}

const { ApiManager } = require(${JSON.stringify(apiManagerEntry)});
const liveSnapshots = [
  { symbol: 'BTCUSDT', price: 110, volume: 1, timestamp: '2024-01-01T10:00:00.000Z' },
  { symbol: 'BTCUSDT', price: 115, volume: 1, timestamp: '2024-01-01T10:30:00.000Z' },
  { symbol: 'BTCUSDT', price: 120, volume: 1, timestamp: '2024-01-01T11:00:00.000Z' },
];
let liveSnapshotIndex = 0;
function freshResult(snapshot) {
  return {
    status: 'FRESH',
    snapshot,
    provenance: {
      source: 'TestProvider',
      observedAt: snapshot.timestamp,
      sourceTimestamp: null,
      effectiveAgeMs: 0,
      cacheAgeMs: null,
      fallbackReason: null,
    },
  };
}
ApiManager.prototype.fetchMarketData = async function () {
  count('marketDataCalls');
  if (liveSnapshotIndex >= liveSnapshots.length) {
    const cached = this.cache.get();
    return {
      status: 'CACHE_HIT',
      snapshot: cached,
      provenance: {
        source: 'TestProvider',
        observedAt: cached.timestamp,
        sourceTimestamp: null,
        effectiveAgeMs: null,
        cacheAgeMs: this.cache.getAge(),
        fallbackReason: 'PROVIDER_UNAVAILABLE',
      },
    };
  }
  const snapshot = { ...liveSnapshots[Math.min(liveSnapshotIndex++, liveSnapshots.length - 1)] };
  counters.simplePriceFetch++;
  this.cache.store(snapshot);
  saveProbe();
  return freshResult(snapshot);
};

saveProbe();
const mockedFetch = async url => {
  const target = String(url);
  if (target.includes('/simple/price')) {
    counters.simplePriceFetch++;
    saveProbe();
    return {
      ok: true,
      status: 200,
      async json() {
        return { bitcoin: { usd: 50000 + counters.simplePriceFetch, usd_24h_vol: 1000, usd_24h_change: 0 } };
      },
    };
  }
  if (target.includes('/coins/bitcoin/ohlc')) {
    return { ok: true, status: 200, async json() { return []; } };
  }
  if (target.includes('/market_chart')) {
    return { ok: true, status: 200, async json() { return { prices: [], total_volumes: [] }; } };
  }
  throw new Error('Unexpected mocked URL: ' + target);
};
require.cache[fetchPath] = { id: fetchPath, filename: fetchPath, loaded: true, exports: mockedFetch };
`;
  fs.writeFileSync(preloadPath, preload);

  const child = spawn(process.execPath, ['server.js'], {
    cwd: BACKEND,
    env: {
      ...process.env,
      PORT: String(port),
      API_KEY,
      REFRESH_INTERVAL: '1500',
      MIN_API_INTERVAL: '1',
      API_THROTTLE_TTL: '1',
      RATE_LIMIT_MAX_REQUESTS: '500',
      RATE_LIMIT_WINDOW_MS: '60000',
      RATE_LIMIT_EXPENSIVE_MAX: '100',
      NODE_OPTIONS: `--require=${preloadPath}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForStartup(child);

    const healthResponse = await request(port, '/healthz', {});
    assert.equal(healthResponse.statusCode, 200);
    assert.deepEqual(healthResponse.body, { status: 'ok' });

    const configResponse = await request(port, '/api/config');
    assert.equal(configResponse.statusCode, 200);
    assert.match(configResponse.headers['content-type'], /^application\/json/);
    assert.deepEqual(Object.keys(configResponse.body).sort(), [
      'cacheTTL',
      'initialBackoff',
      'logLevel',
      'maxHistory',
      'maxRetries',
      'port',
      'refreshInterval',
      'requestTimeout',
    ].sort());
    assert.equal(configResponse.body.port, port);

    const backtestResponse = await request(port, '/api/backtest?timeframe=1h');
    assert.equal(backtestResponse.statusCode, 200);
    assert.equal(backtestResponse.body.symbol, 'BTCUSDT');
    assert.equal(backtestResponse.body.timeframe, '1h');
    assert.equal(backtestResponse.body.reason, 'No finalized candle data available');
    assert.deepEqual(backtestResponse.body.signals, []);

    const first = await waitForCycle(port, probePath, 1);
    assert.equal(first.statusResponse.statusCode, 200);
    assert.equal(first.probe.createExecutionPipeline, 1);
    assert.equal(first.probe.pipelineRun, 1);
    assert.equal(first.probe.marketSnapshotEmitCount, 1);
    assert.equal(first.probe.marketSnapshotEmits.length, 1);
    assert.deepEqual(first.probe.marketSnapshotEmits[0], {
      argumentCount: 2,
      price: 110,
      timestamp: '2024-01-01T10:00:00.000Z',
      oneHourOpenTime: null,
    });
    assert.deepEqual(first.probe.pipelineCalls, [{
      argumentCount: 1,
      price: 110,
      sameSnapshot: true,
      lifecycleOpenTime: null,
      activeOpenTime: Date.parse('2024-01-01T10:00:00.000Z'),
      finalizedOpenTimes: [],
      sameLifecycle: false,
    }]);
    assert.deepEqual(first.probe.order.slice(-3), ['analyzer', 'signalHistory', 'pipeline']);
    assert.equal(first.probe.simplePriceFetch, 1);
    assert.equal(first.probe.paperEvaluateTrades, 1);
    assert.equal(first.probe.paperOnCandle, 1);
    assert.equal(first.probe.paperSignal, 0);
    assert.equal(first.probe.advanceRiskEvaluate, 0);
    assert.equal(first.probe.advanceRiskOnTradeClosed, 0);
    assert.equal(first.statusResponse.body.pipeline.pipelineCycleCount, 1);
    assert.deepEqual(Object.keys(first.statusResponse.body.pipeline).sort(), [
      'lastPipelineError',
      'lastSuccessfulCycle',
      'pipelineCycleCount',
      'pipelineErrors',
    ].sort());

    const firstInspector = await request(port, '/api/signal/inspector');
    assert.equal(firstInspector.statusCode, 200);
    assert.equal(firstInspector.body.available, true);
    assert.equal(firstInspector.body.cycle, 1);
    assert.equal(firstInspector.body.cycle, first.statusResponse.body.pipeline.pipelineCycleCount);
    assert.equal(firstInspector.body.verdict.rejectionReason, 'Insufficient candles (0/15 minimum)');

    const second = await waitForCycle(port, probePath, 2);
    assert.equal(second.statusResponse.statusCode, 200);
    assert.equal(second.probe.createExecutionPipeline, 1);
    assert.equal(second.probe.pipelineRun, 2);
    assert.equal(second.probe.marketSnapshotEmitCount, 2);
    assert.deepEqual(second.probe.marketSnapshotEmits.map(event => event.argumentCount), [2, 2]);
    assert.deepEqual(second.probe.pipelineCalls.map(call => call.argumentCount), [1, 1]);
    assert.equal(second.probe.simplePriceFetch, 2);
    assert.equal(second.probe.paperEvaluateTrades, 2);
    assert.equal(second.probe.paperOnCandle, 2);
    assert.equal(second.probe.paperSignal, 0);
    assert.equal(second.probe.advanceRiskEvaluate, 0);
    assert.equal(second.probe.advanceRiskOnTradeClosed, 0);
    assert.equal(second.statusResponse.body.pipeline.pipelineCycleCount, 2);
    for (const value of Object.values(second.probe).filter(value => typeof value === 'number')) {
      assert.ok(value <= second.probe.pipelineRun, `counter exceeded authoritative runs: ${value}`);
    }

    const secondInspector = await request(port, '/api/signal/inspector');
    assert.equal(secondInspector.statusCode, 200);
    assert.equal(secondInspector.body.available, true);
    assert.equal(secondInspector.body.cycle, 2);
    assert.equal(secondInspector.body.cycle, second.statusResponse.body.pipeline.pipelineCycleCount);

    const third = await waitForCycle(port, probePath, 3);
    assert.equal(third.probe.pipelineRun, 3);
    assert.deepEqual(third.probe.marketSnapshotEmits[2], {
      argumentCount: 2,
      price: 120,
      timestamp: '2024-01-01T11:00:00.000Z',
      oneHourOpenTime: Date.parse('2024-01-01T10:00:00.000Z'),
    });
    assert.deepEqual(third.probe.pipelineCalls[2], {
      argumentCount: 2,
      price: 120,
      sameSnapshot: true,
      lifecycleOpenTime: Date.parse('2024-01-01T10:00:00.000Z'),
      activeOpenTime: Date.parse('2024-01-01T11:00:00.000Z'),
      finalizedOpenTimes: [Date.parse('2024-01-01T10:00:00.000Z')],
      sameLifecycle: true,
    });
    assert.deepEqual(third.probe.order.slice(-3), ['analyzer', 'signalHistory', 'pipeline']);

    const stable = await waitForProbeCondition(
      port,
      probePath,
      probe => probe.marketDataCalls >= 4,
    );
    assert.equal(stable.probe.pipelineRun, 3);
    assert.equal(stable.probe.marketSnapshotEmitCount, 3);
    assert.equal(stable.probe.marketSnapshotEmits.length, 3);
    assert.equal(stable.probe.pipelineCalls.length, 3);
    assert.equal(stable.probe.simplePriceFetch, 3);
    assert.equal(stable.probe.paperEvaluateTrades, 3);
    assert.equal(stable.probe.paperOnCandle, 3);
    assert.equal(stable.probe.paperSignal, 0);
    assert.equal(stable.probe.advanceRiskEvaluate, 0);
    assert.equal(stable.probe.advanceRiskOnTradeClosed, 0);
    assert.deepEqual(stable.probe.order.slice(-3), ['analyzer', 'signalHistory', 'pipeline']);
    assert.equal(child.exitCode, null);
  } finally {
    await stopServer(child);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
