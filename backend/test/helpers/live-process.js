const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const BACKEND = path.join(__dirname, '../..');
const PRELOAD = path.join(__dirname, 'live-process-preload.js');
const API_KEY = 'ph4f-process-test-api-key-32-characters';
const OPERATOR_HASH = 'scrypt$N=16384$r=8$p=1$MDEyMzQ1Njc4OWFiY2RlZg$tjK03tRvEjqCcPwmgtddMkgjlXrk8U_b9rIvfeBMKCc';
const DEFAULT_RUNTIME_LOG_PATH = path.resolve(BACKEND, 'runtime-data/logs/atlas-events.jsonl');

async function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function waitForClose(child, timeoutMs = 10_000) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Child process did not exit')), timeoutMs);
    child.once('close', code => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function request(port, requestPath, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: requestPath,
      method,
      headers: {
        ...(payload ? {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        } : {}),
        ...headers,
      },
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        let json = null;
        if (text.length > 0) {
          try {
            json = JSON.parse(text);
          } catch (error) {
            reject(new Error(`Invalid JSON from ${requestPath}: ${error.message}; body=${text}`));
            return;
          }
        }
        resolve({ statusCode: res.statusCode, headers: res.headers, body: json, text });
      });
    });
    req.once('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function poll(condition, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await condition();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for child-process condition');
}

async function createLiveProcess({ directory = null } = {}) {
  const stateDirectory = directory || await fs.promises.mkdtemp(path.join(os.tmpdir(), 'atlas-ph4f-'));
  const statePath = path.join(stateDirectory, 'live-execution-state.json');
  const defaultLogPath = path.resolve(stateDirectory, 'atlas-events.jsonl');
  let currentLogPath = defaultLogPath;
  let child = null;
  let port = null;
  let markerPath = null;
  let childExited = true;

  async function start({ mode = 'none', marketMode = 'idle', extraEnv = {} } = {}) {
    if (child && !childExited) throw new Error('Child process is already running');
    const overrides = extraEnv || {};
    const { ATLAS_LOG_FILE_PATH: requestedLogPath, ...childOverrides } = overrides;
    const logPath = typeof requestedLogPath === 'string'
      && path.isAbsolute(requestedLogPath)
      && path.resolve(requestedLogPath) !== DEFAULT_RUNTIME_LOG_PATH
      ? path.resolve(requestedLogPath)
      : defaultLogPath;
    currentLogPath = logPath;
    port = await reservePort();
    markerPath = path.join(stateDirectory, `${mode}-${Date.now()}-${Math.random().toString(16).slice(2)}.barrier`);
    child = spawn(process.execPath, ['server.js'], {
      cwd: BACKEND,
      env: {
        ...process.env,
        PORT: String(port),
        API_KEY,
        ATLAS_OPERATOR_PASSWORD_HASH: OPERATOR_HASH,
        ATLAS_ORIGIN: `http://127.0.0.1:${port}`,
        ATLAS_COOKIE_SECURE: 'false',
        ATLAS_LIVE_STATE_FILE_PATH: statePath,
        ATLAS_LOG_FILE_PATH: logPath,
        REFRESH_INTERVAL: '500',
        MIN_API_INTERVAL: '1',
        API_THROTTLE_TTL: '1',
        RATE_LIMIT_MAX_REQUESTS: '500',
        RATE_LIMIT_WINDOW_MS: '60000',
        RATE_LIMIT_EXPENSIVE_MAX: '100',
        LIVE_TEST_MODE: mode,
        LIVE_TEST_MARKET_MODE: marketMode,
        LIVE_TEST_BARRIER_PATH: markerPath,
        NODE_OPTIONS: `--require=${PRELOAD}`,
        ...childOverrides,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    childExited = false;
    child.once('close', () => { childExited = true; });

    let output = '';
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { output += chunk.toString(); });
    await poll(() => {
      if (child.exitCode !== null) throw new Error(`Child exited before listening (${child.exitCode}): ${output}`);
      return output.includes('Atlas v1.0 running on port');
    }, 60_000);
    return { child, port, statePath, markerPath, logPath };
  }

  async function stopGracefully() {
    if (!child || childExited) return child?.exitCode ?? null;
    child.kill('SIGTERM');
    return waitForClose(child);
  }

  async function killAbruptly() {
    if (!child || childExited) return child?.exitCode ?? null;
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      await waitForClose(killer);
    } else {
      child.kill('SIGKILL');
    }
    return waitForClose(child);
  }

  async function waitForReady() {
    return poll(async () => {
      try {
        const response = await request(port, '/readyz');
        return response.statusCode === 200 ? response : false;
      } catch {
        return false;
      }
    }, 30_000);
  }

  async function waitForLiveState(expectedState) {
    return poll(async () => {
      try {
        const response = await request(port, '/api/status', { headers: { 'x-api-key': API_KEY } });
        return response.body?.liveStateReadiness === expectedState ? response : false;
      } catch {
        return false;
      }
    }, 30_000);
  }

  async function waitForBarrier(markerPath) {
    return poll(() => fs.existsSync(markerPath), 30_000);
  }

  async function waitForState(predicate) {
    return poll(() => {
      if (!fs.existsSync(statePath)) return false;
      try {
        const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        return predicate(state) ? state : false;
      } catch {
        return false;
      }
    }, 30_000);
  }

  async function releaseBarrier(markerPath) {
    await fs.promises.writeFile(`${markerPath}.release`, 'release');
  }

  async function dispose() {
    if (child && !childExited) {
      try {
        await stopGracefully();
      } catch {
        await killAbruptly().catch(() => {});
      }
    }
    await fs.promises.rm(stateDirectory, { recursive: true, force: true });
  }

  return Object.freeze({
    stateDirectory,
    statePath,
    get logPath() { return currentLogPath; },
    get child() { return child; },
    get port() { return port; },
    get markerPath() { return markerPath; },
    start,
    request: (requestPath, options) => request(port, requestPath, options),
    waitForReady,
    waitForLiveState,
    waitForBarrier,
    waitForState,
    releaseBarrier,
    waitForExit: () => waitForClose(child),
    stopGracefully,
    killAbruptly,
    dispose,
  });
}

module.exports = { API_KEY, OPERATOR_HASH, BACKEND, PRELOAD, createLiveProcess };
