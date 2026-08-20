const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { evaluateChecks } = require('../../verify-pipeline');

const BACKEND_DIR = path.join(__dirname, '..', '..');
const OPENED_AT = '2026-01-01T00:00:00.000Z';
const UNAVAILABLE_MESSAGE = 'No decision data yet — waiting for first pipeline cycle';
const VERIFY_DURATION_MS = 900;
const VERIFY_INTERVAL_MS = 100;
const WATCHDOG_MS = 10000;
const HTTPS_TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCtDkBb2V14OBu7
QSLNRUMuwEVv5k4O7PWWnoiRwLw0t5NP8IoVWeTQyKEMqHd2CR+SS7/Khz7pTD5X
59t8boYYJXOf5BTyERYDxLP55UuLfXMxjg+oZCnh8+EQ8s0PdOCi94c5zypHN9cB
SFv6Y45ZdVtXJhsA8UnrAsr0GeZz2ZqNLC43Py5lqb145U4ou0ZVlloUv6Jf09Bc
6fy2UotJu73akukVsQyByGYVpOxxMTTloGQdAd3fFow1HT9dG+uYHynCxmh4xho0
3OSV8MVesP7MiCiApNvgT90pHaVZVUeMTD1hMSIp+em5zqv7ZI81g8LWvzlcJddn
v06EnN1jAgMBAAECggEAEDaRmQlYVHcNQhHsLMcccDjbSIyPK57Ps3jO2rjv6RB5
4LdseGufoF/rlsAB0TExoAcwxMy+/CSEgr/aNGI2dfSsTIKV48fuBBRduD/fQAZU
0IO6u9AGjIDIyUm2JIiSszH1nVjnYRy+LASXeXHyWDdCg3uyc/gnMLlmQlBa4ueM
cSH6eNOQSRsyNl47Vfl1OPs5pDeE5cSxIdn2SaTIfBMFLPjixkBtActXPReBsJfb
Lot1DaTbANSuhLFHh8XWsPkP99ZfYGQFCoXloITHa73pnPXr3E0T0X6M061cA8Ba
9GgZa/R+mhBoc5CUVSK87meKQu509ylWlGx9If1UoQKBgQDuQAigwAX6cTSONrPp
XhJMIDoBBFecBtHZhIxe7KX11Z+csjF2mE27ASDoGSt8SOy24gQuE6SkFdAhuIPU
qS7q4kR107TaikKkG/RQv5QV4LusKLQ1lCNmsEAa4FlOt+biOPrhIN6TaAtpmzsT
Ig6eWtcO6vJSrYmtKg1gtYWQJwKBgQC58tADwlqtrEQDqj3/YjnFkpHF/diNNxYF
6mpJFRhmDbsDo4qmufXx2QfYXEFz0nsJgT+q5m21oUMbi3Nh/JUtH0Q7fBAWEmU3
HfS+7nGzo8K7wV3WernSpDSE/CA+kZJ5I9OJHI19TmXOgUO3TB2mwiOV9xx1Cmg5
rXkpE93SZQKBgCqJikDRKAAX+C8v+x0+a3vmARUvZkj4Or1gWgOUsujadD3w3r3y
4WXzBKIL5GSzTHg2kFJ9tVaKgneSzw7IChVrwpda7h5asx1D1HIaUmE5l6hcOBic
01lBPKDPz4IreXCIhdpuGO8uk2MOkRSQbxW82ErUjeFPFJazPGI45pjfAoGAGN51
nZsXv5SDgC37nrVHXrosjttVZAWTB3WDg4Szv6pkcackuwmx8AeDuhcUleX3mJzV
pAivcZRAwmVTKC680M0WthHwoNMTAF0cR5DiWhEz0SKaZz4ArkBR2dtSgKu9eEAn
YXYVIkYi7YxyPwiKCqx6T+s9vhWHPPeLdcf3adUCgYApHcOaI93XW09ehPL4Q+d7
1lyYpyE7e5MjlKZc66JUjFempLpP30ouyNnxqxcY675YuMT1vXxxE7WbDFWDmZn2
wBLpterKN1khFzRjBacN6TThlJirQTz73jYfYHQUrGzdOreJFSyysXY+iKZnqace
KBI9orwCosgUe/jGGN5u9Q==
-----END PRIVATE KEY-----`;
const HTTPS_TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIDGjCCAgKgAwIBAgIUaprkpVWaS+fTocPjwwjkIjeNSxwwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDgwMjA2NTIyNVoXDTM2MDcz
MDA2NTIyNVowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEArQ5AW9ldeDgbu0EizUVDLsBFb+ZODuz1lp6IkcC8NLeT
T/CKFVnk0MihDKh3dgkfkku/yoc+6Uw+V+fbfG6GGCVzn+QU8hEWA8Sz+eVLi31z
MY4PqGQp4fPhEPLND3TgoveHOc8qRzfXAUhb+mOOWXVbVyYbAPFJ6wLK9Bnmc9ma
jSwuNz8uZam9eOVOKLtGVZZaFL+iX9PQXOn8tlKLSbu92pLpFbEMgchmFaTscTE0
5aBkHQHd3xaMNR0/XRvrmB8pwsZoeMYaNNzklfDFXrD+zIgogKTb4E/dKR2lWVVH
jEw9YTEiKfnpuc6r+2SPNYPC1r85XCXXZ79OhJzdYwIDAQABo2QwYjAdBgNVHQ4E
FgQUmxrlOJmzTGLaV5DSQG9BlBmk0YcwHwYDVR0jBBgwFoAUmxrlOJmzTGLaV5DS
QG9BlBmk0YcwDwYDVR0TAQH/BAUwAwEB/zAPBgNVHREECDAGhwR/AAABMA0GCSqG
SIb3DQEBCwUAA4IBAQCVjXV1HCw0iLKVY7VEQHZqrPzbzBHlMAkgbE8SGuMelc/W
bb7bphy2nEAjYlM7i/iqmTq5Qq8aD1g4HOiaACmVaXwDBGlZ46vUN9BkUqCdSJs8
+5ftlyyMriPZVGXMOFwza2xQATG23mqOj00hq6h3tivV08eFZvj+qTgCHIrv88z7
ByVh1YobDyfUuVl2Jw/IiwJFd7efanPH3HYRvofkT4I7/fwurf8DBQAHOpTnW9rQ
gz7Fcf+hFmEnvw4/4zPXcyVtjsfPW5P7X2sJvPptACgxrQcfwCgft3wKVVBkO5os
krgVu/QF7eqnr7mMe16TfYNcFb6lvn0QJd75ribB
-----END CERTIFICATE-----`;

function jsonResponse(body, options = {}) {
  return { body, statusCode: 200, ...options };
}

function inspectorGate(pass, value, detail = pass ? 'accepted' : 'rejected') {
  return { pass, value, detail };
}

function canonicalInspector(cycle, overrides = {}) {
  const base = {
    available: true,
    timestamp: `2026-01-01T00:00:${String(cycle).padStart(2, '0')}.000Z`,
    cycle,
    price: 100 + cycle,
    timeframe: '1h',
    confluence: { score: 70, bias: 'Bullish', confidence: 80, components: {} },
    thresholds: { bullish: 65, bearish: 35 },
    gates: {
      trend: inspectorGate(true, 'Bullish'),
      structure: inspectorGate(true, 'bullish'),
      rsi: inspectorGate(true, 70),
      ema: inspectorGate(true, 'Above'),
      macd: inspectorGate(true, 'Bullish'),
      atr: inspectorGate(true, '$2'),
      bollinger: inspectorGate(true, 'Above Upper'),
      confluenceBias: inspectorGate(true, 'Bullish'),
      regimeDecision: inspectorGate(true, 'ALLOWED'),
      mtfConfirmation: inspectorGate(true, 'ALLOWED'),
      advanceRisk: inspectorGate(true, 'ALLOWED'),
    },
    engines: {},
    marketRegime: { regime: 'TRENDING_BULL', confidence: 80 },
    risk: { tradeAllowed: true, positionSize: 10, stopLoss: 95, takeProfit: 110, riskReward: 2 },
    regimeDecision: { allowTrade: true, reason: 'Allowed' },
    mtfConfirmation: { mtfAllowed: true, confidence: 80, alignmentScore: 100 },
    verdict: {
      tradeOpened: true,
      rejectionReason: null,
      trade: {
        tradeId: 'PT-1',
        direction: 'BUY',
        entryPrice: 100,
        stopLoss: 95,
        takeProfit: 110,
        riskReward: 2,
        positionSize: 10,
        confidence: 80,
        reason: 'Accepted',
      },
    },
  };

  return {
    ...base,
    ...overrides,
    gates: { ...base.gates, ...(overrides.gates || {}) },
    verdict: { ...base.verdict, ...(overrides.verdict || {}) },
  };
}

function productionTrade() {
  return {
    tradeId: 'PT-1',
    symbol: 'BTCUSDT',
    timeframe: '1h',
    direction: 'BUY',
    entryPrice: 100,
    entryTime: OPENED_AT,
    stopLoss: 95,
    takeProfit: 110,
    riskReward: 2,
    positionSize: 10,
    currentPrice: 100,
    status: 'OPEN',
    exitPrice: null,
    exitTime: null,
    exitReason: null,
    duration: null,
    pnl: null,
    pnlPercent: null,
    confidence: 80,
    reason: 'Accepted',
    timestamp: OPENED_AT,
  };
}

function canonicalPaperResponse() {
  return {
    open: [productionTrade()],
    closed: [],
    stats: { total: 1, open: 1, closed: 0 },
    performance: { totalPnL: 0 },
    balance: 10000,
  };
}

function unavailableInspector() {
  return { available: false, message: UNAVAILABLE_MESSAGE };
}

function malformedInspector() {
  const malformed = canonicalInspector(1);
  delete malformed.gates;
  return malformed;
}

function unknownGateInspector() {
  return canonicalInspector(1, {
    gates: { extraGate: inspectorGate(true, 'unexpected') },
  });
}

function rejectedInspector(cycle) {
  return canonicalInspector(cycle, {
    verdict: {
      tradeOpened: false,
      rejectionReason: 'Fixture rejection',
      trade: null,
    },
  });
}

function invalidJsonResponse(options = {}) {
  return { body: '{invalid-json', statusCode: 200, ...options };
}

function endpointFailure(statusCode = 503, options = {}) {
  return { body: { error: 'fixture failure' }, statusCode, ...options };
}

function destroyedSocket(options = {}) {
  return { destroy: true, ...options };
}

function responseAt(sequence, index) {
  const selected = sequence[Math.min(index, sequence.length - 1)];
  return typeof selected === 'function' ? selected(index) : selected;
}

async function startFixture({ inspector, paper, secure = false }) {
  const counters = { inspector: 0, paper: 0 };
  const requests = [];
  const sockets = new Set();
  const timers = new Set();

  const handleRequest = (req, res) => {
    const endpoint = req.method === 'GET' && req.url === '/api/signal/inspector'
      ? 'inspector'
      : req.method === 'GET' && req.url === '/api/paper-trades'
        ? 'paper'
        : null;

    if (!endpoint) {
      res.statusCode = 404;
      res.end();
      return;
    }

    const index = counters[endpoint]++;
    const configured = responseAt(endpoint === 'inspector' ? inspector : paper, index);
    requests.push({ endpoint, index, label: configured.label || null, observedAt: Date.now() });

    if (configured.destroy) {
      req.socket.destroy();
      return;
    }

    const body = typeof configured.body === 'string'
      ? configured.body
      : JSON.stringify(configured.body);
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (res.writableEnded) return;
      res.statusCode = configured.statusCode ?? 200;
      res.setHeader('content-type', 'application/json');
      res.setHeader('connection', 'close');
      res.on('error', () => {});
      res.end(body);
    }, configured.delayMs || 0);
    timers.add(timer);
  };

  const server = secure
    ? https.createServer({ key: HTTPS_TEST_KEY, cert: HTTPS_TEST_CERT }, handleRequest)
    : http.createServer(handleRequest);

  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  return {
    url: `${secure ? 'https' : 'http'}://127.0.0.1:${address.port}`,
    requests,
    counters,
    async close() {
      for (const timer of timers) clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
      if (!server.listening) return;
      await new Promise(resolve => server.close(() => resolve()));
    },
    isListening() {
      return server.listening;
    },
  };
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function terminateChild(child, lifecycle, closePromise) {
  if (lifecycle.closed) return closePromise;

  child.kill('SIGTERM');
  await Promise.race([closePromise, wait(500)]);
  if (!lifecycle.closed) child.kill('SIGKILL');
  return closePromise;
}

async function discoverReports(directory) {
  const entries = await fs.readdir(directory);
  const jsonFiles = entries.filter(file => file.endsWith('.json'));
  const markdownFiles = entries.filter(file => file.endsWith('.md'));
  const json = jsonFiles.length === 1
    ? JSON.parse(await fs.readFile(path.join(directory, jsonFiles[0]), 'utf8'))
    : null;
  const markdown = markdownFiles.length === 1
    ? await fs.readFile(path.join(directory, markdownFiles[0]), 'utf8')
    : null;
  return { entries, jsonFiles, markdownFiles, json, markdown };
}

async function runScenario(t, fixtureConfig, options = {}) {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-verify-cli-'));
  let fixture = null;
  let child = null;
  let closePromise = null;
  const lifecycle = { closed: false };

  t.after(async () => {
    if (child && !lifecycle.closed) await terminateChild(child, lifecycle, closePromise);
    if (fixture) await fixture.close();
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
    if (options.assertCleanup) {
      assert.equal(lifecycle.closed, true, 'HTTPS verifier child process closed during cleanup');
      assert.equal(fixture.isListening(), false, 'HTTPS fixture server closed during cleanup');
      await assert.rejects(fs.access(temporaryDirectory), { code: 'ENOENT' });
    }
  });

  fixture = await startFixture(fixtureConfig);
  const childEnv = {
    ...process.env,
    ATLAS_VERIFY_BASE_URL: fixture.url,
    ATLAS_VERIFY_OUTPUT_DIR: temporaryDirectory,
    ATLAS_VERIFY_DURATION_MS: String(options.durationMs || VERIFY_DURATION_MS),
    ATLAS_VERIFY_INTERVAL_MS: String(options.intervalMs || VERIFY_INTERVAL_MS),
    ...(options.environment || {}),
  };

  child = spawn(process.execPath, ['verify-pipeline.js', ...(options.args || [])], {
    cwd: BACKEND_DIR,
    env: childEnv,
    shell: false,
  });

  let stdout = '';
  let stderr = '';
  let spawnError = null;
  child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });

  closePromise = new Promise(resolve => {
    child.once('error', error => { spawnError = error; });
    child.once('close', (code, signal) => {
      lifecycle.closed = true;
      resolve({ code, signal });
    });
  });

  let timedOut = false;
  const watchdog = setTimeout(() => { timedOut = true; }, WATCHDOG_MS);
  await Promise.race([closePromise, wait(WATCHDOG_MS)]);
  clearTimeout(watchdog);
  if (!lifecycle.closed) await terminateChild(child, lifecycle, closePromise);
  const result = await closePromise;
  const reports = await discoverReports(temporaryDirectory);

  return {
    fixture,
    directory: temporaryDirectory,
    stdout,
    stderr,
    spawnError,
    timedOut,
    result,
    reports,
  };
}

function diagnostics(run) {
  return [
    `exit=${run.result.code} signal=${run.result.signal} timedOut=${run.timedOut}`,
    `spawnError=${run.spawnError ? run.spawnError.message : 'none'}`,
    `stdout:\n${run.stdout}`,
    `stderr:\n${run.stderr}`,
    `reports=${JSON.stringify(run.reports.entries)}`,
    `requests=${JSON.stringify(run.fixture.requests)}`,
  ].join('\n');
}

function check(run, condition, message) {
  assert.ok(condition, `${message}\n${diagnostics(run)}`);
}

function equal(run, actual, expected, message) {
  assert.equal(actual, expected, `${message}\n${diagnostics(run)}`);
}

function deepEqual(run, actual, expected, message) {
  assert.deepEqual(actual, expected, `${message}\n${diagnostics(run)}`);
}

function match(run, actual, pattern, message) {
  assert.match(actual, pattern, `${message}\n${diagnostics(run)}`);
}

function completedRun(run) {
  check(run, !run.timedOut, 'verifier completed before watchdog');
  equal(run, run.result.signal, null, 'completed verifier was not signaled');
  equal(run, run.reports.jsonFiles.length, 1, 'exactly one JSON report was created');
  equal(run, run.reports.markdownFiles.length, 1, 'exactly one Markdown report was created');
  check(run, run.reports.json && run.reports.markdown, 'both reports were readable');
  check(run, typeof run.reports.json.startTime === 'number', 'JSON startTime is numeric');
  check(run, typeof run.reports.json.endTime === 'number', 'JSON endTime is numeric');
  check(run, run.reports.json.endTime >= run.reports.json.startTime, 'JSON timestamps are ordered');
  deepEqual(run, Object.keys(run.reports.json).sort(), [
    'cycles', 'endTime', 'startTime', 'trades', 'verification',
  ], 'JSON top-level schema is unchanged');
  check(run, !Object.hasOwn(run.reports.json.verification, 'checks'), 'JSON has no checks field');
  check(run, !Object.hasOwn(run.reports.json.verification, 'allPass'), 'JSON has no allPass field');
}

function checkMap(run) {
  const { json } = run.reports;
  const evaluation = evaluateChecks(json.cycles, json.trades, { metrics: json.verification });
  return {
    evaluation,
    checks: Object.fromEntries(evaluation.checks.map(item => [item.name, item])),
  };
}

function assertFirstFailure(run, category, messagePattern, requestWindow = {}) {
  const { json } = run.reports;
  const failure = json.verification.errors[category];
  check(run, failure.count > 0, `${category} has failures`);
  check(run, typeof failure.firstMessage === 'string' && failure.firstMessage.trim() !== '', `${category} firstMessage is populated`);
  check(run, Number.isFinite(failure.firstTimestamp) && failure.firstTimestamp > 0, `${category} firstTimestamp is populated`);
  check(run, failure.firstTimestamp >= json.startTime && failure.firstTimestamp <= json.endTime, `${category} firstTimestamp is within the run window`);
  if (requestWindow.firstLabel && requestWindow.laterLabel) {
    const firstRequest = run.fixture.requests.find(request => request.label === requestWindow.firstLabel);
    const laterRequest = run.fixture.requests.find(request => request.label === requestWindow.laterLabel);
    check(run, firstRequest && laterRequest, `${category} request window is available`);
    check(run, failure.firstTimestamp >= firstRequest.observedAt, `${category} firstTimestamp follows the first failing request`);
    check(run, failure.firstTimestamp < laterRequest.observedAt, `${category} firstTimestamp is not overwritten by a later failure`);
  }
  if (messagePattern) match(run, failure.firstMessage, messagePattern, `${category} firstMessage preserves the first failure`);
}

function validPaperSequence() {
  return [jsonResponse(canonicalPaperResponse(), { label: 'paper-valid' })];
}

test('CLI environment overrides take precedence over CLI duration and interval arguments', async t => {
  const run = await runScenario(t, {
    inspector: [
      jsonResponse(canonicalInspector(10), { label: 'startup-cycle-10' }),
      jsonResponse(canonicalInspector(10), { label: 'runtime-cycle-10' }),
      jsonResponse(rejectedInspector(12), { label: 'runtime-cycle-12' }),
    ],
    paper: validPaperSequence(),
  }, {
    args: ['--duration', '1', '--interval', '1'],
    environment: {
      ATLAS_VERIFY_DURATION_MS: '900',
      ATLAS_VERIFY_INTERVAL_MS: '100',
    },
  });

  completedRun(run);
  const { json, markdown } = run.reports;
  equal(run, run.result.code, 0, 'valid override precedence run exits zero');
  equal(run, json.verification.runtime.requestedDurationMs, 900, 'duration environment override wins over CLI duration');
  equal(run, json.verification.runtime.runCompleted, true, 'CLI completes under the effective environment duration');
  equal(run, json.verification.polling.expectedPollAttempts, 9, 'interval environment override wins over CLI interval');
  check(run, run.fixture.requests.length > 0, 'base URL override directs requests to the fixture');
  equal(run, run.reports.jsonFiles.length, 1, 'output directory override receives JSON');
  equal(run, run.reports.markdownFiles.length, 1, 'output directory override receives Markdown');
  match(run, markdown, /Requested Duration \| 900ms/, 'Markdown reports the effective duration override');
  match(run, markdown, /\*\*Poll Interval:\*\* 0\.1s/, 'Markdown reports the effective interval override');
});

test('CLI HTTPS run uses the secure fixture and preserves all verification contracts', async t => {
  const parentTlsSetting = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  const run = await runScenario(t, {
    secure: true,
    inspector: [
      jsonResponse(canonicalInspector(10), { label: 'https-startup-cycle-10' }),
      jsonResponse(canonicalInspector(10), { label: 'https-runtime-cycle-10' }),
      jsonResponse(rejectedInspector(12), { label: 'https-runtime-cycle-12' }),
    ],
    paper: validPaperSequence(),
  }, {
    assertCleanup: true,
    environment: { NODE_TLS_REJECT_UNAUTHORIZED: '0' },
  });

  completedRun(run);
  const { json } = run.reports;
  equal(run, run.result.code, 0, 'HTTPS run exits zero');
  equal(run, run.result.signal, null, 'HTTPS run exits without a signal');
  check(run, run.fixture.requests.some(request => request.endpoint === 'inspector'), 'HTTPS fixture receives inspector requests');
  check(run, run.fixture.requests.some(request => request.endpoint === 'paper'), 'HTTPS fixture receives paper requests');
  check(run, run.fixture.requests.some(request => request.label === 'https-startup-cycle-10'), 'HTTPS startup probe succeeds');
  deepEqual(run, json.cycles.map(cycle => cycle.cycle).slice(0, 2), [10, 12], 'HTTPS run observes monotonic source progress');
  deepEqual(run, run.reports.entries.slice().sort(), [...run.reports.jsonFiles, ...run.reports.markdownFiles].sort(), 'HTTPS reports are isolated to the temporary directory');
  equal(run, json.verification.errors.inspectorEndpoint.count, 0, 'HTTPS inspector endpoint errors are zero');
  equal(run, json.verification.errors.inspectorContract.count, 0, 'HTTPS inspector contract errors are zero');
  equal(run, json.verification.errors.paperEndpoint.count, 0, 'HTTPS paper endpoint errors are zero');
  equal(run, json.verification.errors.paperContract.count, 0, 'HTTPS paper contract errors are zero');
  equal(run, json.verification.runtime.runCompleted, true, 'HTTPS runtime check passes');
  equal(run, checkMap(run).evaluation.allPass, true, 'HTTPS verification checks pass');
  equal(run, process.env.NODE_TLS_REJECT_UNAUTHORIZED, parentTlsSetting, 'TLS override remains scoped to the child process');
});

test('CLI classifies HTTPS invalid JSON as a contract failure', async t => {
  const parentTlsSetting = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  const run = await runScenario(t, {
    secure: true,
    inspector: [
      jsonResponse(canonicalInspector(1), { label: 'https-invalid-json-startup' }),
      invalidJsonResponse({ body: '{https-first-invalid-json', label: 'https-invalid-json' }),
      invalidJsonResponse({ body: '[https-later-invalid-json', label: 'https-invalid-json-later' }),
      jsonResponse(canonicalInspector(2), { label: 'https-runtime-cycle-2' }),
    ],
    paper: validPaperSequence(),
  }, {
    assertCleanup: true,
    environment: { NODE_TLS_REJECT_UNAUTHORIZED: '0' },
  });

  completedRun(run);
  const { json } = run.reports;
  equal(run, run.result.code, 1, 'HTTPS invalid JSON exits nonzero');
  equal(run, run.result.signal, null, 'HTTPS invalid JSON exits without a signal');
  assertFirstFailure(run, 'inspectorContract', /JSON parse error/, {
    firstLabel: 'https-invalid-json',
    laterLabel: 'https-invalid-json-later',
  });
  equal(run, json.verification.errors.inspectorEndpoint.count, 0, 'HTTPS invalid JSON is not an endpoint failure');
  check(run, json.verification.polling.successfulPaperPolls > 0, 'HTTPS paper processing continues after invalid JSON');
  equal(run, process.env.NODE_TLS_REJECT_UNAUTHORIZED, parentTlsSetting, 'TLS override remains scoped to the child process');
});

const INVALID_OVERRIDE_CASES = [
  { name: 'ATLAS_VERIFY_BASE_URL', value: 'ftp://example.com', pattern: /ATLAS_VERIFY_BASE_URL.*valid HTTP or HTTPS URL/ },
  { name: 'ATLAS_VERIFY_BASE_URL', value: 'not-a-url', pattern: /ATLAS_VERIFY_BASE_URL.*valid HTTP or HTTPS URL/ },
  { name: 'ATLAS_VERIFY_BASE_URL', value: '', pattern: /ATLAS_VERIFY_BASE_URL.*valid HTTP or HTTPS URL/ },
  { name: 'ATLAS_VERIFY_DURATION_MS', value: '0', pattern: /ATLAS_VERIFY_DURATION_MS.*positive safe integer/ },
  { name: 'ATLAS_VERIFY_DURATION_MS', value: '-1', pattern: /ATLAS_VERIFY_DURATION_MS.*positive safe integer/ },
  { name: 'ATLAS_VERIFY_DURATION_MS', value: '1.5', pattern: /ATLAS_VERIFY_DURATION_MS.*positive safe integer/ },
  { name: 'ATLAS_VERIFY_DURATION_MS', value: 'not-a-number', pattern: /ATLAS_VERIFY_DURATION_MS.*positive safe integer/ },
  { name: 'ATLAS_VERIFY_DURATION_MS', value: '9007199254740992', pattern: /ATLAS_VERIFY_DURATION_MS.*positive safe integer/ },
  { name: 'ATLAS_VERIFY_DURATION_MS', value: '', pattern: /ATLAS_VERIFY_DURATION_MS.*positive safe integer/ },
  { name: 'ATLAS_VERIFY_INTERVAL_MS', value: '0', pattern: /ATLAS_VERIFY_INTERVAL_MS.*positive safe integer/ },
  { name: 'ATLAS_VERIFY_INTERVAL_MS', value: '-1', pattern: /ATLAS_VERIFY_INTERVAL_MS.*positive safe integer/ },
  { name: 'ATLAS_VERIFY_INTERVAL_MS', value: '1.5', pattern: /ATLAS_VERIFY_INTERVAL_MS.*positive safe integer/ },
  { name: 'ATLAS_VERIFY_INTERVAL_MS', value: 'not-a-number', pattern: /ATLAS_VERIFY_INTERVAL_MS.*positive safe integer/ },
  { name: 'ATLAS_VERIFY_INTERVAL_MS', value: '9007199254740992', pattern: /ATLAS_VERIFY_INTERVAL_MS.*positive safe integer/ },
  { name: 'ATLAS_VERIFY_INTERVAL_MS', value: '', pattern: /ATLAS_VERIFY_INTERVAL_MS.*positive safe integer/ },
];

for (const invalidCase of INVALID_OVERRIDE_CASES) {
  test(`CLI rejects invalid ${invalidCase.name}=${JSON.stringify(invalidCase.value)}`, async t => {
    const run = await runScenario(t, {
      inspector: [jsonResponse(canonicalInspector(1), { label: 'not-contacted' })],
      paper: validPaperSequence(),
    }, {
      environment: { [invalidCase.name]: invalidCase.value },
    });

    equal(run, run.result.code, 1, 'invalid override exits nonzero');
    equal(run, run.result.signal, null, 'invalid override exits without a signal');
    const output = `${run.stdout}\n${run.stderr}`;
    match(run, output, new RegExp(invalidCase.name), 'configuration error names the invalid variable');
    match(run, output, invalidCase.pattern, 'configuration error explains the invalid value');
    equal(run, run.fixture.requests.length, 0, 'invalid configuration fails before fixture startup probe');
    equal(run, run.reports.jsonFiles.length, 0, 'invalid configuration creates no JSON report');
    equal(run, run.reports.markdownFiles.length, 0, 'invalid configuration creates no Markdown report');
    equal(run, run.reports.entries.length, 0, 'invalid configuration leaves the temporary directory empty');
  });
}

test('CLI passing run writes reports and preserves diagnostic gap telemetry', async t => {
  const run = await runScenario(t, {
    inspector: [
      jsonResponse(canonicalInspector(10), { label: 'startup-cycle-10' }),
      jsonResponse(canonicalInspector(10), { label: 'runtime-cycle-10', delayMs: 5 }),
      jsonResponse(rejectedInspector(12), { label: 'runtime-cycle-12' }),
      jsonResponse(rejectedInspector(12), { label: 'runtime-duplicate-12' }),
    ],
    paper: validPaperSequence(),
  });

  completedRun(run);
  const { json, markdown } = run.reports;
  equal(run, run.result.code, 0, 'passing run exits zero');
  check(run, json.cycles.length >= 2, 'passing run stores at least two cycles');
  deepEqual(run, json.cycles.map(cycle => cycle.cycle).slice(0, 2), [10, 12], 'stored cycles preserve monotonic progress');
  equal(run, json.trades.length, 1, 'one logical trade is normalized');
  deepEqual(run, {
    id: json.trades[0].id,
    type: json.trades[0].type,
    side: json.trades[0].side,
    entry: json.trades[0].entry,
    sl: json.trades[0].sl,
    tp: json.trades[0].tp,
  }, {
    id: 'PT-1', type: 'opened', side: 'BUY', entry: 100, sl: 95, tp: 110,
  }, 'normalized trade fields are preserved');
  equal(run, json.verification.source.missingSourceCycleCount, 1, 'gap count is exact');
  deepEqual(run, json.verification.source.missingSourceCycleRanges, [{ from: 11, to: 11, count: 1 }], 'gap range is compact');
  equal(run, json.verification.source.sourceCycleRegressions, 0, 'passing run has no regressions');
  check(run, json.verification.source.duplicateSourceObservations > 0, 'duplicate source observations are counted');
  equal(run, json.verification.runtime.runCompleted, true, 'runtime completed');
  equal(run, json.verification.errors.inspectorEndpoint.count, 0, 'inspector endpoint errors are zero');
  equal(run, json.verification.errors.inspectorContract.count, 0, 'inspector contract errors are zero');
  equal(run, json.verification.errors.paperEndpoint.count, 0, 'paper endpoint errors are zero');
  equal(run, json.verification.errors.paperContract.count, 0, 'paper contract errors are zero');

  const { evaluation, checks } = checkMap(run);
  equal(run, evaluation.allPass, true, 'recomputed final checks pass');
  equal(run, checks['Gate coverage contract'].pass, true, 'gate coverage passes');
  equal(run, checks['Source cycle progressed'].pass, true, 'source progress passes');
  equal(run, checks['Source cycle continuity'].pass, true, 'source continuity passes');
  match(run, markdown, /Missing Source Cycle Count \(diagnostic only\) \| 1/, 'Markdown reports the exact gap count');
  match(run, markdown, /Missing Source Cycle Ranges \(diagnostic only\).*"from":11.*"to":11/, 'Markdown reports the compact gap range');
  match(run, markdown, /Polling Drift \(diagnostic only\)/, 'Markdown labels drift diagnostic-only');
  match(run, markdown, /Maximum Observed Source Stall \(diagnostic only\)/, 'Markdown labels maximum stall diagnostic-only');
  match(run, markdown, /Final Source Stall \(diagnostic only\)/, 'Markdown labels final stall diagnostic-only');
  match(run, markdown, /Requested runtime completed \| ✅ PASS/, 'Markdown reports runtime completion');
  match(run, markdown, /Gate coverage contract \| ✅ PASS/, 'Markdown reports gate coverage');
});

test('CLI accepts unavailable startup and records later available progress', async t => {
  const run = await runScenario(t, {
    inspector: [
      jsonResponse(unavailableInspector(), { label: 'startup-unavailable' }),
      jsonResponse(canonicalInspector(1), { label: 'runtime-cycle-1' }),
      jsonResponse(rejectedInspector(2), { label: 'runtime-cycle-2' }),
    ],
    paper: validPaperSequence(),
  });

  completedRun(run);
  const { json } = run.reports;
  equal(run, run.result.code, 0, 'startup transition exits zero');
  equal(run, run.fixture.requests[0].label, 'startup-unavailable', 'startup unavailable response is observed');
  equal(run, json.verification.polling.unavailableInspectorPolls, 0, 'startup unavailability is excluded from runtime polling metrics');
  check(run, json.verification.source.uniqueSourceCycles >= 2, 'later available responses establish progress');
  equal(run, json.verification.source.firstSourceCycle, 1, 'startup unavailable response is not a source cycle');
  equal(run, json.verification.runtime.runCompleted, true, 'transition run completes');
  equal(run, checkMap(run).evaluation.allPass, true, 'transition run checks pass');
});

test('CLI records inspector schema failure while continuing paper processing', async t => {
  const run = await runScenario(t, {
    inspector: [
      jsonResponse(canonicalInspector(1), { label: 'startup-valid' }),
      jsonResponse(malformedInspector(), { label: 'inspector-malformed' }),
      jsonResponse(unknownGateInspector(), { label: 'inspector-malformed-later' }),
      jsonResponse(canonicalInspector(1), { label: 'runtime-cycle-1' }),
      jsonResponse(canonicalInspector(2), { label: 'runtime-cycle-2' }),
    ],
    paper: validPaperSequence(),
  });

  completedRun(run);
  const { json, markdown } = run.reports;
  equal(run, run.result.code, 1, 'inspector schema failure exits nonzero');
  assertFirstFailure(run, 'inspectorContract', /missing gates/, {
    firstLabel: 'inspector-malformed',
    laterLabel: 'inspector-malformed-later',
  });
  check(run, json.verification.errors.inspectorContract.count > 1, 'later inspector contract failures are also counted');
  equal(run, json.verification.errors.inspectorEndpoint.count, 0, 'inspector schema failure is not an endpoint failure');
  check(run, json.verification.polling.successfulPaperPolls > 0, 'paper processing continues');
  equal(run, json.verification.errors.paperContract.count, 0, 'paper contract remains healthy');
  const { checks } = checkMap(run);
  equal(run, checks['Inspector schema integrity'].pass, false, 'inspector schema check fails');
  equal(run, checks['Paper contract integrity'].pass, true, 'paper contract check passes');
  match(run, markdown, /Inspector schema integrity \| ❌ FAIL/, 'Markdown reports inspector schema failure');
});

test('CLI records paper contract failure while preserving inspector metrics', async t => {
  const run = await runScenario(t, {
    inspector: [
      jsonResponse(canonicalInspector(1), { label: 'startup-valid' }),
      jsonResponse(canonicalInspector(1), { label: 'runtime-cycle-1' }),
      jsonResponse(canonicalInspector(2), { label: 'runtime-cycle-2' }),
    ],
    paper: [
      jsonResponse({ open: [] }, { label: 'paper-malformed' }),
      jsonResponse({ open: [], closed: {} }, { label: 'paper-malformed-later' }),
      ...validPaperSequence(),
    ],
  });

  completedRun(run);
  const { json, markdown } = run.reports;
  equal(run, run.result.code, 1, 'paper contract failure exits nonzero');
  assertFirstFailure(run, 'paperContract', /must contain open and closed arrays/, {
    firstLabel: 'paper-malformed',
    laterLabel: 'paper-malformed-later',
  });
  check(run, json.verification.errors.paperContract.count > 1, 'later paper contract failures are also counted');
  equal(run, json.verification.errors.paperEndpoint.count, 0, 'paper schema failure is not an endpoint failure');
  check(run, json.verification.source.uniqueSourceCycles >= 2, 'inspector source metrics remain intact');
  equal(run, json.verification.errors.inspectorContract.count, 0, 'inspector contract remains healthy');
  const { checks } = checkMap(run);
  equal(run, checks['Inspector schema integrity'].pass, true, 'inspector schema check passes');
  equal(run, checks['Paper contract integrity'].pass, false, 'paper contract check fails');
  match(run, markdown, /Paper contract integrity \| ❌ FAIL/, 'Markdown reports paper contract failure');
});

for (const endpoint of ['inspector', 'paper']) {
  test(`CLI classifies ${endpoint} HTTP 200 invalid JSON as a contract failure`, async t => {
    const fixture = {
      inspector: [
        jsonResponse(canonicalInspector(1), { label: 'startup-valid' }),
        ...(endpoint === 'inspector'
          ? [
            invalidJsonResponse({ body: '{first-inspector-invalid-json', label: 'inspector-invalid-json' }),
            invalidJsonResponse({ body: '[later-inspector-invalid-json', label: 'inspector-invalid-json-later' }),
          ]
          : [jsonResponse(canonicalInspector(1), { label: 'runtime-cycle-1' })]),
        jsonResponse(canonicalInspector(2), { label: 'runtime-cycle-2' }),
      ],
      paper: endpoint === 'paper'
        ? [
          invalidJsonResponse({ body: '{first-paper-invalid-json', label: 'paper-invalid-json' }),
          invalidJsonResponse({ body: '[later-paper-invalid-json', label: 'paper-invalid-json-later' }),
          ...validPaperSequence(),
        ]
        : validPaperSequence(),
    };
    const run = await runScenario(t, fixture);

    completedRun(run);
    const { json, markdown } = run.reports;
    equal(run, run.result.code, 1, `${endpoint} invalid JSON exits nonzero`);
    const contractCategory = `${endpoint}Contract`;
    const endpointCategory = `${endpoint}Endpoint`;
    assertFirstFailure(run, contractCategory, /JSON parse error: Expected property name/, {
      firstLabel: `${endpoint}-invalid-json`,
      laterLabel: `${endpoint}-invalid-json-later`,
    });
    check(run, json.verification.errors[contractCategory].count > 1, `${endpoint} later invalid JSON failures are also counted`);
    equal(run, json.verification.errors[endpointCategory].count, 0, `${endpoint} invalid JSON is not an endpoint failure`);
    const opposite = endpoint === 'inspector' ? 'paper' : 'inspector';
    check(run, json.verification.polling[opposite === 'paper' ? 'successfulPaperPolls' : 'validInspectorResponses'] > 0, `${opposite} continues processing`);
    check(run, json.verification.errors[contractCategory].firstMessage.startsWith('JSON parse error'), 'first parsing failure is retained');
    check(run, Number.isFinite(json.verification.errors[contractCategory].firstTimestamp), 'first parsing failure timestamp is retained');
    match(run, markdown, new RegExp(`${endpoint}Contract \\| 2 \\| JSON parse error`), `${endpoint} parsing failure appears in Markdown`);
  });
}

test('CLI isolates an inspector endpoint failure from paper processing', async t => {
  const run = await runScenario(t, {
    inspector: [
      jsonResponse(canonicalInspector(1), { label: 'startup-valid' }),
      endpointFailure(503, { label: 'inspector-http-503' }),
      endpointFailure(502, { label: 'inspector-http-502-later' }),
      jsonResponse(canonicalInspector(1), { label: 'runtime-cycle-1' }),
      jsonResponse(canonicalInspector(2), { label: 'runtime-cycle-2' }),
    ],
    paper: validPaperSequence(),
  });

  completedRun(run);
  const { json, markdown } = run.reports;
  equal(run, run.result.code, 1, 'endpoint failure exits nonzero');
  assertFirstFailure(run, 'inspectorEndpoint', /HTTP 503/, {
    firstLabel: 'inspector-http-503',
    laterLabel: 'inspector-http-502-later',
  });
  check(run, json.verification.errors.inspectorEndpoint.count > 1, 'later inspector endpoint failures are also counted');
  equal(run, json.verification.errors.inspectorContract.count, 0, 'HTTP failure is not an inspector contract failure');
  check(run, json.verification.polling.successfulPaperPolls > 0, 'paper endpoint continues processing');
  equal(run, json.verification.errors.paperEndpoint.count, 0, 'paper endpoint remains healthy');
  const { checks } = checkMap(run);
  equal(run, checks['Inspector endpoint integrity'].pass, false, 'inspector endpoint check fails');
  equal(run, checks['Paper endpoint integrity'].pass, true, 'paper endpoint check passes');
  match(run, markdown, /inspectorEndpoint \| 2 \| HTTP 503/, 'Markdown reports the endpoint failure');
});

test('CLI fails source progress when one cycle is repeatedly observed', async t => {
  const run = await runScenario(t, {
    inspector: [
      jsonResponse(canonicalInspector(7), { label: 'startup-cycle-7' }),
      jsonResponse(canonicalInspector(7), { label: 'runtime-cycle-7' }),
    ],
    paper: validPaperSequence(),
  });

  completedRun(run);
  const { json, markdown } = run.reports;
  equal(run, run.result.code, 1, 'no-progress run exits nonzero');
  equal(run, json.verification.source.uniqueSourceCycles, 1, 'one unique source cycle is retained');
  check(run, json.verification.source.duplicateSourceObservations > 0, 'duplicate observations are counted');
  const { checks } = checkMap(run);
  equal(run, checks['Source cycle progressed'].pass, false, 'source progress is non-passing');
  match(run, checks['Source cycle progressed'].detail, /Inconclusive/, 'source progress explains the inconclusive result');
  equal(run, checks['Source cycle continuity'].pass, true, 'duplicates do not create regressions');
  match(run, markdown, /Source cycle progressed \| ❌ FAIL/, 'Markdown reports source progress failure');
});

test('CLI records source regression without losing later valid progress', async t => {
  const run = await runScenario(t, {
    inspector: [
      jsonResponse(canonicalInspector(8), { label: 'startup-cycle-8' }),
      jsonResponse(canonicalInspector(8), { label: 'runtime-cycle-8' }),
      jsonResponse(canonicalInspector(3), { label: 'runtime-regression-3' }),
      jsonResponse(canonicalInspector(9), { label: 'runtime-cycle-9' }),
    ],
    paper: validPaperSequence(),
  }, {
    durationMs: 5000,
  });

  completedRun(run);
  const { json, markdown } = run.reports;
  equal(run, run.result.code, 1, 'regression run exits nonzero');
  check(run, json.verification.source.sourceCycleRegressions > 0, 'source regression is counted');
  deepEqual(run, json.verification.source.sourceCycleRegressionDetails[0], {
    previousCycle: 8,
    cycle: 3,
    observedAt: json.verification.source.sourceCycleRegressionDetails[0].observedAt,
  }, 'regression details retain the previous and observed cycles');
  check(run, json.verification.source.lastSourceCycle > json.verification.source.sourceCycleRegressionDetails[0].previousCycle, 'later valid progress advances beyond the pre-regression cycle');
  const { checks } = checkMap(run);
  equal(run, checks['Source cycle progressed'].pass, true, 'source progress passes after later progress');
  equal(run, checks['Source cycle continuity'].pass, false, 'source continuity fails after regression');
  match(run, markdown, /Source cycle continuity \| ❌ FAIL/, 'Markdown reports source continuity failure');
});
