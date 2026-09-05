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
const API_KEY = 'live-cycle-test-api-key-32-characters';
const OPERATOR_HASH = 'scrypt$N=16384$r=8$p=1$MDEyMzQ1Njc4OWFiY2RlZg$tjK03tRvEjqCcPwmgtddMkgjlXrk8U_b9rIvfeBMKCc';

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
        try {
          resolve({ statusCode: res.statusCode, body: JSON.parse(body) });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.once('error', reject);
  });
}

function postJson(port, requestPath, body = {}, headers = { 'x-api-key': API_KEY }) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: requestPath,
      method: 'POST',
      headers: {
        ...headers,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    }, res => {
      let responseBody = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { responseBody += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: JSON.parse(responseBody) }));
    });
    req.once('error', reject);
    req.write(payload);
    req.end();
  });
}

function readProbe(probePath) {
  return JSON.parse(fs.readFileSync(probePath, 'utf8'));
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

async function waitForPipelineCycle(port, probePath, expectedCycle) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const status = await request(port, '/api/status');
    const probe = readProbe(probePath);
    if (status.body.pipeline?.pipelineCycleCount === expectedCycle) return { status, probe };
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Expected pipeline cycle ${expectedCycle}`);
}

async function waitForResponse(port, requestPath, expectedStatus) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const response = await request(port, requestPath, {});
    if (response.statusCode === expectedStatus) return response;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${requestPath} to return ${expectedStatus}`);
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

test('only FRESH acquisitions advance the complete live cycle', async () => {
  const port = await reservePort();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-freshness-'));
  const statePath = path.join(tempDir, 'live-execution-state.json');
  fs.rmSync(statePath, { force: true });
  const preloadPath = path.join(tempDir, 'freshness-probe.js');
  const probePath = path.join(tempDir, 'freshness-probe.json');
  const preload = `
const fs = require('node:fs');
const fetchPath = require.resolve(${JSON.stringify(NODE_FETCH_ENTRY)});
const probePath = ${JSON.stringify(probePath)};
const counters = {
  historyAdd: 0,
  candleIngest: 0,
  marketSnapshotEmit: 0,
  analyzer: 0,
  signalHistory: 0,
  pipelineRun: 0,
  paperEvaluateTrades: 0,
  paperOnCandle: 0,
  paperSignal: 0,
};
const statuses = [];
const historySnapshots = [];
const emittedSnapshots = [];
function saveProbe() {
  fs.writeFileSync(probePath, JSON.stringify({ counters, statuses, historySnapshots, emittedSnapshots }));
}
function count(name) { counters[name]++; saveProbe(); }

const historyPath = require.resolve(${JSON.stringify(path.join(BACKEND, 'src/engine/history.js'))});
const { HistoryEngine } = require(historyPath);
const originalHistoryAdd = HistoryEngine.prototype.add;
HistoryEngine.prototype.add = function (snapshot) {
  historySnapshots.push({ ...snapshot });
  count('historyAdd');
  return originalHistoryAdd.call(this, snapshot);
};

const candlesPath = require.resolve(${JSON.stringify(path.join(BACKEND, 'src/engine/candles.js'))});
const { CandleEngine } = require(candlesPath);
const originalCandleIngest = CandleEngine.prototype.ingest;
CandleEngine.prototype.ingest = function (...args) {
  count('candleIngest');
  return originalCandleIngest.apply(this, args);
};

const eventBusPath = require.resolve(${JSON.stringify(path.join(BACKEND, 'src/core/eventBus.js'))});
const { EventBus } = require(eventBusPath);
const originalEmitAsync = EventBus.prototype.emitAsync;
EventBus.prototype.emitAsync = async function (event, ...args) {
  if (event === 'market:snapshot') {
    emittedSnapshots.push({ ...args[0] });
    count('marketSnapshotEmit');
  }
  return originalEmitAsync.apply(this, [event, ...args]);
};

const analyzerPath = require.resolve(${JSON.stringify(path.join(BACKEND, 'src/engine/analyzer.js'))});
const { MarketAnalyzer } = require(analyzerPath);
const originalAnalyze = MarketAnalyzer.prototype.analyze;
MarketAnalyzer.prototype.analyze = function (...args) {
  count('analyzer');
  return originalAnalyze.apply(this, args);
};

const signalHistoryPath = require.resolve(${JSON.stringify(path.join(BACKEND, 'src/engine/signalHistory.js'))});
const { SignalHistoryEngine } = require(signalHistoryPath);
const originalRecord = SignalHistoryEngine.prototype.record;
SignalHistoryEngine.prototype.record = function (...args) {
  count('signalHistory');
  return originalRecord.apply(this, args);
};

const pipelinePath = require.resolve(${JSON.stringify(path.join(BACKEND, 'src/core/executionPipeline.js'))});
const executionPipeline = require(pipelinePath);
const originalCreatePipeline = executionPipeline.createExecutionPipeline;
executionPipeline.createExecutionPipeline = dependencies => {
  const pipeline = originalCreatePipeline(dependencies);
  const originalRun = pipeline.run;
  pipeline.run = (...args) => {
    count('pipelineRun');
    return originalRun(...args);
  };
  return pipeline;
};

const paperPath = require.resolve(${JSON.stringify(path.join(BACKEND, 'src/engine/paperTrading.js'))});
const { PaperTradingEngine } = require(paperPath);
for (const [method, counter] of Object.entries({
  evaluateTrades: 'paperEvaluateTrades',
  onCandle: 'paperOnCandle',
  signal: 'paperSignal',
})) {
  const original = PaperTradingEngine.prototype[method];
  PaperTradingEngine.prototype[method] = function (...args) {
    count(counter);
    return original.apply(this, args);
  };
}

const apiManagerPath = require.resolve(${JSON.stringify(path.join(BACKEND, 'src/network/apiManager.js'))});
const { ApiManager } = require(apiManagerPath);
const first = { symbol: 'BTCUSDT', price: 100, volume: 1, timestamp: '2024-01-01T00:00:00.000Z' };
const second = { symbol: 'BTCUSDT', price: 101, volume: 1, timestamp: '2024-01-01T00:01:00.000Z' };
const acquisitions = [
  { status: 'FRESH', snapshot: first, provenance: { source: 'Test', observedAt: first.timestamp, sourceTimestamp: null, effectiveAgeMs: 0, cacheAgeMs: null, fallbackReason: null } },
  { status: 'CACHE_HIT', snapshot: first, provenance: { source: 'Test', observedAt: first.timestamp, sourceTimestamp: null, effectiveAgeMs: 1, cacheAgeMs: 1, fallbackReason: null } },
  { status: 'STALE_CACHE', snapshot: first, provenance: { source: 'Test', observedAt: first.timestamp, sourceTimestamp: null, effectiveAgeMs: 30001, cacheAgeMs: 30001, fallbackReason: 'PROVIDER_UNAVAILABLE' } },
  { status: 'PROVIDER_UNAVAILABLE', snapshot: null, provenance: { source: 'Test', observedAt: null, sourceTimestamp: null, effectiveAgeMs: null, cacheAgeMs: null, fallbackReason: 'PROVIDER_UNAVAILABLE' } },
  { status: 'INVALID_PROVIDER_DATA', snapshot: null, provenance: { source: 'Test', observedAt: null, sourceTimestamp: null, effectiveAgeMs: null, cacheAgeMs: null, fallbackReason: 'INVALID_PROVIDER_DATA' } },
  { status: 'FRESH', snapshot: second, provenance: { source: 'Test', observedAt: second.timestamp, sourceTimestamp: null, effectiveAgeMs: 0, cacheAgeMs: null, fallbackReason: null } },
];
let acquisitionIndex = 0;
ApiManager.prototype.fetchMarketData = async function () {
  const result = acquisitions[Math.min(acquisitionIndex++, acquisitions.length - 1)];
  statuses.push(result.status);
  saveProbe();
  return result;
};

const mockedFetch = async url => {
  const target = String(url);
  if (target.includes('/coins/bitcoin/ohlc') || target.includes('/market_chart')) {
    return { ok: true, status: 200, async json() { return target.includes('market_chart') ? { prices: [], total_volumes: [] } : []; } };
  }
  throw new Error('Unexpected mocked URL: ' + target);
};
require.cache[fetchPath] = { id: fetchPath, filename: fetchPath, loaded: true, exports: mockedFetch };
saveProbe();
`;
  fs.writeFileSync(preloadPath, preload);

  const child = spawn(process.execPath, ['server.js'], {
    cwd: BACKEND,
    env: {
      ...process.env,
      PORT: String(port),
      API_KEY,
      ATLAS_OPERATOR_PASSWORD_HASH: OPERATOR_HASH,
      ATLAS_ORIGIN: `http://127.0.0.1:${port}`,
      ATLAS_COOKIE_SECURE: 'false',
      ATLAS_LIVE_STATE_FILE_PATH: statePath,
       REFRESH_INTERVAL: '500',
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
    await waitForResponse(port, '/healthz', 200);
    const initialize = await postJson(port, '/api/live-state/initialize');
    assert.equal(initialize.statusCode, 201);
    const result = await waitForPipelineCycle(port, probePath, 2);
    assert.deepEqual(result.probe.statuses.slice(0, 6), [
      'FRESH',
      'CACHE_HIT',
      'STALE_CACHE',
      'PROVIDER_UNAVAILABLE',
      'INVALID_PROVIDER_DATA',
      'FRESH',
    ]);
    assert.deepEqual(result.probe.counters, {
      historyAdd: 2,
      candleIngest: 2,
      marketSnapshotEmit: 2,
      analyzer: 2,
      signalHistory: 2,
      pipelineRun: 2,
      paperEvaluateTrades: 2,
      paperOnCandle: 2,
      paperSignal: 0,
    });
    assert.deepEqual(result.probe.historySnapshots.map(snapshot => snapshot.timestamp), [
      '2024-01-01T00:00:00.000Z',
      '2024-01-01T00:01:00.000Z',
    ]);
    assert.deepEqual(result.probe.emittedSnapshots.map(snapshot => snapshot.timestamp), [
      '2024-01-01T00:00:00.000Z',
      '2024-01-01T00:01:00.000Z',
    ]);
  } finally {
    await stopServer(child);
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(statePath, { force: true });
  }
});
