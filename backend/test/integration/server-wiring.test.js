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
  const preload = `
const fetchPath = require.resolve(${JSON.stringify(NODE_FETCH_ENTRY)});
const mockedFetch = async url => ({
  ok: true,
  status: 200,
  async json() {
    const target = String(url);
    if (target.includes('/simple/price')) {
      return { bitcoin: { usd: 50000, usd_24h_vol: 1000, usd_24h_change: 0 } };
    }
    if (target.includes('/coins/bitcoin/ohlc')) return [];
    if (target.includes('/market_chart')) return { prices: [], total_volumes: [] };
    throw new Error('Unexpected mocked URL: ' + target);
  },
});
require.cache[fetchPath] = { id: fetchPath, filename: fetchPath, loaded: true, exports: mockedFetch };
`;
  fs.writeFileSync(preloadPath, preload);

  const child = spawn(process.execPath, ['server.js'], {
    cwd: BACKEND,
    env: {
      ...process.env,
      PORT: String(port),
      API_KEY: '',
      REFRESH_INTERVAL: '60000',
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

    const statusResponse = await request(port, '/api/status');
    assert.equal(statusResponse.statusCode, 200);
    assert.equal(child.exitCode, null);
  } finally {
    await stopServer(child);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
