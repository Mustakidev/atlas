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

function request(port, requestPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: requestPath }, res => {
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
};
function saveProbe() {
  fs.writeFileSync(probePath, JSON.stringify(counters));
}
function count(name) {
  counters[name]++;
  saveProbe();
}

const executionPipelinePath = require.resolve(${JSON.stringify(executionPipelineEntry)});
const executionPipeline = require(executionPipelinePath);
const createExecutionPipeline = executionPipeline.createExecutionPipeline;
executionPipeline.createExecutionPipeline = dependencies => {
  count('createExecutionPipeline');
  const pipeline = createExecutionPipeline(dependencies);
  const run = pipeline.run;
  pipeline.run = snapshot => {
    count('pipelineRun');
    return run(snapshot);
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
      API_KEY: '',
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
    assert.equal(second.probe.simplePriceFetch, 2);
    assert.equal(second.probe.paperEvaluateTrades, 2);
    assert.equal(second.probe.paperOnCandle, 2);
    assert.equal(second.probe.paperSignal, 0);
    assert.equal(second.probe.advanceRiskEvaluate, 0);
    assert.equal(second.probe.advanceRiskOnTradeClosed, 0);
    assert.equal(second.statusResponse.body.pipeline.pipelineCycleCount, 2);
    for (const value of Object.values(second.probe)) {
      assert.ok(value <= second.probe.pipelineRun, `counter exceeded authoritative runs: ${value}`);
    }

    const secondInspector = await request(port, '/api/signal/inspector');
    assert.equal(secondInspector.statusCode, 200);
    assert.equal(secondInspector.body.available, true);
    assert.equal(secondInspector.body.cycle, 2);
    assert.equal(secondInspector.body.cycle, second.statusResponse.body.pipeline.pipelineCycleCount);
    assert.equal(child.exitCode, null);
  } finally {
    await stopServer(child);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
