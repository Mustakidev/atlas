const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const BACKEND = path.join(__dirname, '../..');
const API_KEY = 'ph6-startup-test-api-key-32-characters';
const OPERATOR_HASH = 'scrypt$N=16384$r=8$p=1$MDEyMzQ1Njc4OWFiY2RlZg$tjK03tRvEjqCcPwmgtddMkgjlXrk8U_b9rIvfeBMKCc';

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function waitForClose(child) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('invalid-config child did not exit')), 10000);
    child.once('close', code => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function assertPortClosed(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.close(error => error ? reject(error) : resolve());
    });
  });
}

async function runInvalidConfiguration(overrides) {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'atlas-ph6-config-'));
  const port = await reservePort();
  const statePath = path.join(tempDir, 'live-execution-state.json');
  const env = {
    ...process.env,
    PORT: String(port),
    API_KEY,
    ATLAS_OPERATOR_PASSWORD_HASH: OPERATOR_HASH,
    ATLAS_ORIGIN: `http://127.0.0.1:${port}`,
    ATLAS_COOKIE_SECURE: 'false',
    ATLAS_LIVE_STATE_FILE_PATH: statePath,
    ...overrides,
  };
  delete env.NODE_OPTIONS;

  const child = spawn(process.execPath, ['server.js'], {
    cwd: BACKEND,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });

  try {
    const code = await waitForClose(child);
    await assertPortClosed(port);
    assert.equal(code, 1, output);
    assert.equal(fs.existsSync(statePath), false);
    return output;
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}

for (const scenario of [
  { key: 'SYMBOL', value: 'ETHUSDT' },
  { key: 'CONFLUENCE_BEARISH_THRESHOLD', value: '70', extra: { CONFLUENCE_BULLISH_THRESHOLD: '60' } },
  { key: 'MAX_BODY_SIZE', value: '16kbjunk' },
  { key: 'REQUEST_TIMEOUT', value: '30000', extra: { MAX_RETRIES: '10', INITIAL_BACKOFF: '5000' } },
  { key: 'ATLAS_LIVE_STATE_FILE_PATH', value: 'relative/state.json' },
  { key: 'PORT', value: '3000abc' },
  { key: 'REFRESH_INTERVAL', value: '100' },
]) {
  test(`invalid ${scenario.key} exits before listen, state recovery, or provider work`, async () => {
    const output = await runInvalidConfiguration({
      ...(scenario.extra || {}),
      [scenario.key]: scenario.value,
    });
    assert.match(output, new RegExp(scenario.key));
  });
}

test('invalid secret configuration is identified without echoing the secret', async () => {
  const secret = 'ph6-secret-never-echoed';
  const output = await runInvalidConfiguration({ API_KEY: secret });
  assert.match(output, /API_KEY/);
  assert.equal(output.includes(secret), false);
});
