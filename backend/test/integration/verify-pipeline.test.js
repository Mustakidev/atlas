const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const {
  createVerificationMetrics,
  evaluateChecks,
  evaluateGateCoverage,
  fetchJSON,
  buildCycleRecord,
  finalizeVerificationMetrics,
  generateReport,
  mergeTradeObservation,
  normalizeInspectorResponse,
  normalizePaperTradeResponse,
  processPollResults,
  recordPollAttempt,
  recordInspectorResponse,
  recordSuccessfulInspectorPoll,
  recordSuccessfulPaperPoll,
  recordSourceObservation,
  recordVerificationFailure,
  serializeVerificationMetrics,
} = require('../../verify-pipeline');

const OPENED_AT = '2026-01-01T00:00:00.000Z';
const CLOSED_AT = '2026-01-01T00:05:00.000Z';

function productionTrade(overrides = {}) {
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
    reason: 'test',
    timestamp: OPENED_AT,
    ...overrides,
  };
}

function closedTrade(overrides = {}) {
  return productionTrade({
    status: 'CLOSED',
    exitPrice: 110,
    exitTime: CLOSED_AT,
    exitReason: 'Take Profit',
    duration: 300000,
    pnl: 100,
    pnlPercent: 10,
    currentPrice: 110,
    ...overrides,
  });
}

function inspectorGate(pass, value, detail = pass ? 'accepted' : 'rejected') {
  return { pass, value, detail };
}

function inspectorResponse(overrides = {}) {
  const base = {
    available: true,
    timestamp: OPENED_AT,
    cycle: 1,
    price: 100,
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

function removeGates(response, names) {
  const excluded = new Set(names);
  const gates = Object.fromEntries(Object.entries(response.gates).filter(([name]) => !excluded.has(name)));
  return { ...response, gates };
}

function neutralInspector() {
  const response = inspectorResponse({
    confluence: { score: 50, bias: 'Neutral', confidence: 50, components: {} },
    gates: {
      confluenceBias: inspectorGate(false, 'Neutral', 'Score 50 is between thresholds (35-65)'),
      mtfConfirmation: inspectorGate(false, '--', 'Skipped (no direction)'),
      advanceRisk: inspectorGate(false, '--', 'Skipped (confluence is Neutral)'),
      regimeDecision: inspectorGate(true, 'NEUTRAL', '[TRENDING_BULL] Neutral'),
    },
    verdict: { tradeOpened: false, rejectionReason: 'Confluence bias: Score 50 is between thresholds (35-65)', trade: null },
  });
  const { regimeDecision, ...gatesWithoutRegime } = response.gates;
  return { ...response, gates: { ...gatesWithoutRegime, regimeDecision } };
}

function earlyInspector(overrides = {}) {
  const response = inspectorResponse({
    confluence: null,
    marketRegime: null,
    risk: null,
    verdict: { tradeOpened: false, rejectionReason: 'early rejection', trade: null },
    ...overrides,
  });
  response.gates = {};
  delete response.regimeDecision;
  delete response.mtfConfirmation;
  return response;
}

function regimeRejectedInspector() {
  return removeGates(inspectorResponse({
    gates: { regimeDecision: inspectorGate(false, 'BLOCKED', 'Wrong regime') },
    verdict: { tradeOpened: false, rejectionReason: 'Regime Decision: Wrong regime', trade: null },
  }), ['mtfConfirmation', 'advanceRisk']);
}

function mtfRejectedInspector() {
  return removeGates(inspectorResponse({
    gates: { mtfConfirmation: inspectorGate(false, 'BLOCKED', '1h disagrees') },
    verdict: { tradeOpened: false, rejectionReason: '1h disagrees', trade: null },
  }), ['advanceRisk']);
}

function advanceRiskRejectedInspector() {
  return inspectorResponse({
    gates: { advanceRisk: inspectorGate(false, 'BLOCKED', 'Daily limit reached') },
    risk: { tradeAllowed: false, rejectionReason: 'Daily limit reached' },
    verdict: { tradeOpened: false, rejectionReason: 'AdvanceRisk: Daily limit reached', trade: null },
  });
}

function verificationMetrics() {
  return createVerificationMetrics({
    startTime: 1000,
    requestedDurationMs: 9000,
    pollIntervalMs: 3000,
  });
}

function sourceObservation(cycle) {
  return { cycle, timestamp: `2026-01-01T00:00:${String(cycle).padStart(2, '0')}.000Z` };
}

function pollContext() {
  return {
    metrics: verificationMetrics(),
    verificationState: {
      inspectorFailed: false,
      paperContractFailed: false,
      firstInspectorFailure: null,
      firstPaperFailure: null,
    },
    cycles: [],
    tradesById: new Map(),
  };
}

function fulfilled(value) {
  return { status: 'fulfilled', value };
}

function rejected(error) {
  return { status: 'rejected', reason: error };
}

function invalidJsonError() {
  const error = new Error('JSON parse error');
  error.code = 'INVALID_JSON_RESPONSE';
  return error;
}

function processPoll(inspectorResult, paperTradesResult, context = pollContext()) {
  processPollResults({
    ...context,
    inspectorResult,
    paperTradesResult,
    inspectorReceiptTimestamp: 2000,
    paperReceiptTimestamp: 2100,
  });
  return context;
}

function mergeResponse(map, response) {
  const normalized = normalizePaperTradeResponse(response);
  normalized.open.forEach(trade => mergeTradeObservation(map, trade));
  normalized.closed.forEach(trade => mergeTradeObservation(map, trade));
}

function startResponseServer(response, statusCode = 200) {
  const server = http.createServer((req, res) => {
    res.statusCode = statusCode;
    res.setHeader('content-type', 'application/json');
    res.setHeader('connection', 'close');
    res.end(typeof response === 'string' ? response : JSON.stringify(response));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(3000, '127.0.0.1', () => resolve(server));
  });
}

async function stopServer(server) {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

test('valid zero-trade response is accepted', () => {
  assert.deepEqual(normalizePaperTradeResponse({ open: [], closed: [] }), { open: [], closed: [] });
});

test('one open trade is normalized with the existing verifier fields', () => {
  const normalized = normalizePaperTradeResponse({ open: [productionTrade()], closed: [] });

  assert.deepEqual(normalized.open[0], {
    id: 'PT-1',
    type: 'opened',
    side: 'BUY',
    entry: 100,
    exit: null,
    sl: 95,
    tp: 110,
    size: 10,
    rr: 2,
    pnl: null,
    openedAt: OPENED_AT,
    closedAt: null,
    timestamp: OPENED_AT,
  });
});

test('one closed trade is normalized with closure fields', () => {
  const normalized = normalizePaperTradeResponse({ open: [], closed: [closedTrade()] });

  assert.equal(normalized.closed[0].type, 'closed');
  assert.equal(normalized.closed[0].exit, 110);
  assert.equal(normalized.closed[0].pnl, 100);
  assert.equal(normalized.closed[0].closedAt, CLOSED_AT);
});

test('open-to-closed transition updates one logical trade', () => {
  const trades = new Map();
  mergeResponse(trades, { open: [productionTrade()], closed: [] });
  mergeResponse(trades, { open: [], closed: [closedTrade()] });

  assert.equal(trades.size, 1);
  assert.deepEqual(trades.get('PT-1'), {
    id: 'PT-1',
    type: 'closed',
    side: 'BUY',
    entry: 100,
    exit: 110,
    sl: 95,
    tp: 110,
    size: 10,
    rr: 2,
    pnl: 100,
    openedAt: OPENED_AT,
    closedAt: CLOSED_AT,
    timestamp: OPENED_AT,
  });
});

test('repeated open and closed observations are deduplicated', () => {
  const trades = new Map();
  const openResponse = { open: [productionTrade()], closed: [] };
  const closedResponse = { open: [], closed: [closedTrade()] };

  mergeResponse(trades, openResponse);
  mergeResponse(trades, openResponse);
  mergeResponse(trades, closedResponse);
  mergeResponse(trades, closedResponse);

  assert.equal(trades.size, 1);
  assert.equal(trades.get('PT-1').pnl, 100);
});

test('multiple distinct trades remain separate', () => {
  const trades = new Map();
  mergeResponse(trades, {
    open: [productionTrade(), productionTrade({ tradeId: 'PT-2', direction: 'SELL' })],
    closed: [],
  });

  assert.deepEqual([...trades.keys()], ['PT-1', 'PT-2']);
});

test('closed observation wins when a trade is present in both arrays', () => {
  const trades = new Map();
  mergeResponse(trades, { open: [productionTrade()], closed: [closedTrade()] });

  assert.equal(trades.size, 1);
  assert.equal(trades.get('PT-1').type, 'closed');
});

test('conflicting immutable fields fail instead of being silently merged', () => {
  const trades = new Map();
  mergeResponse(trades, { open: [productionTrade()], closed: [] });

  assert.throws(() => mergeResponse(trades, {
    open: [],
    closed: [closedTrade({ entryPrice: 101 })],
  }), /Conflicting paper trade entry/);
});

test('missing tradeId and malformed numeric fields fail validation', () => {
  assert.throws(() => normalizePaperTradeResponse({
    open: [productionTrade({ tradeId: '' })],
    closed: [],
  }), /missing tradeId/);
  assert.throws(() => normalizePaperTradeResponse({
    open: [productionTrade({ positionSize: '10' })],
    closed: [],
  }), /Invalid paper trade positionSize/);
});

test('incompatible paper response shapes fail validation', () => {
  for (const response of [null, [], {}, { open: [], closed: null }, { open: {}, closed: [] }]) {
    assert.throws(() => normalizePaperTradeResponse(response));
  }
});

test('valid available inspector response is accepted with the canonical advanceRisk gate', () => {
  const response = inspectorResponse();
  const normalized = normalizeInspectorResponse(response);
  const coverage = evaluateGateCoverage(normalized);

  assert.equal(normalized.available, true);
  assert.equal(normalized.gates.advanceRisk.value, 'ALLOWED');
  assert.equal(coverage.valid, true);
  assert.equal(coverage.path, 'advance-risk');
});

test('exact unavailable inspector response is accepted as unavailable', () => {
  const response = {
    available: false,
    message: 'No decision data yet — waiting for first pipeline cycle',
  };

  assert.deepEqual(normalizeInspectorResponse(response), response);
});

test('malformed available inspector response is rejected', () => {
  const { gates, ...malformed } = inspectorResponse();
  assert.throws(() => normalizeInspectorResponse(malformed), /missing gates/);
});

test('riskEngine-only and riskEngine-plus-advanceRisk responses are rejected', () => {
  const response = inspectorResponse();
  const { advanceRisk, ...staleGates } = response.gates;
  assert.throws(() => normalizeInspectorResponse({
    ...response,
    gates: { ...staleGates, riskEngine: inspectorGate(true, 'ALLOWED') },
  }), /unknown gate riskEngine/);
  assert.throws(() => normalizeInspectorResponse({
    ...response,
    gates: { ...response.gates, riskEngine: inspectorGate(true, 'ALLOWED') },
  }), /unknown gate riskEngine/);
});

test('successful verdict.trade is captured in tradeDetails without mutating the inspector', () => {
  const response = inspectorResponse();
  response.gates.trend.diagnostics = { values: [1, { source: 'inspector' }] };
  response.verdict.audit = { flags: ['opened'] };
  response.verdict.trade.metadata = { tags: ['live'] };
  const record = buildCycleRecord(normalizeInspectorResponse(response));

  assert.deepEqual(record.tradeDetails, response.verdict.trade);
  assert.notStrictEqual(record.gates, response.gates);
  assert.notStrictEqual(record.gates.trend, response.gates.trend);
  assert.notStrictEqual(record.verdict, response.verdict);
  assert.notStrictEqual(record.verdict.trade, response.verdict.trade);
  assert.notStrictEqual(record.tradeDetails, response.verdict.trade);
  assert.notStrictEqual(record.gates.trend.diagnostics, response.gates.trend.diagnostics);
  assert.notStrictEqual(record.verdict.audit, response.verdict.audit);
  assert.notStrictEqual(record.verdict.trade.metadata, response.verdict.trade.metadata);

  record.tradeDetails.direction = 'SELL';
  record.gates.trend.diagnostics.values[1].source = 'record';
  record.verdict.audit.flags[0] = 'record';
  record.verdict.trade.metadata.tags[0] = 'record';
  assert.equal(response.verdict.trade.direction, 'BUY');
  assert.equal(response.gates.trend.diagnostics.values[1].source, 'inspector');
  assert.equal(response.verdict.audit.flags[0], 'opened');
  assert.equal(response.verdict.trade.metadata.tags[0], 'live');

  response.gates.trend.diagnostics.values[0] = 2;
  response.verdict.audit.flags.push('inspector');
  response.verdict.trade.metadata.tags.push('inspector');
  assert.equal(record.gates.trend.diagnostics.values[0], 1);
  assert.deepEqual(record.verdict.audit.flags, ['record']);
  assert.deepEqual(record.verdict.trade.metadata.tags, ['record']);
});

test('no-trade cycle records preserve null tradeDetails and isolate verdict data', () => {
  const response = neutralInspector();
  const record = buildCycleRecord(normalizeInspectorResponse(response));

  assert.equal(record.tradeDetails, null);
  assert.notStrictEqual(record.gates, response.gates);
  assert.notStrictEqual(record.verdict, response.verdict);
  record.verdict.rejectionReason = 'record';
  assert.equal(response.verdict.rejectionReason, 'Confluence bias: Score 50 is between thresholds (35-65)');
});

test('contradictory opened-trade verdicts are rejected', () => {
  assert.throws(() => normalizeInspectorResponse(inspectorResponse({
    verdict: { tradeOpened: true, rejectionReason: null, trade: null },
  })), /verdict\.trade must be an object/);
  assert.throws(() => normalizeInspectorResponse(inspectorResponse({
    verdict: { tradeOpened: true, rejectionReason: 'blocked' },
  })), /tradeOpened true requires a null rejectionReason/);
});

test('contradictory rejected-trade verdicts are rejected', () => {
  assert.throws(() => normalizeInspectorResponse(inspectorResponse({
    verdict: { tradeOpened: false, rejectionReason: 'blocked', trade: inspectorResponse().verdict.trade },
  })), /tradeOpened false requires a null trade/);
  assert.throws(() => normalizeInspectorResponse(inspectorResponse({
    verdict: { tradeOpened: false, rejectionReason: null, trade: null },
  })), /tradeOpened false requires a non-empty rejectionReason/);
});

test('invalid-price and insufficient-candle early paths require no gates', () => {
  const response = earlyInspector({
    price: null,
    verdict: { tradeOpened: false, rejectionReason: 'No valid price data', trade: null },
  });
  assert.equal(evaluateGateCoverage(normalizeInspectorResponse(response)).path, 'early-rejection');

  const changedPriceWording = earlyInspector({
    price: null,
    verdict: { tradeOpened: false, rejectionReason: 'price feed unavailable', trade: null },
  });
  assert.equal(evaluateGateCoverage(normalizeInspectorResponse(changedPriceWording)).valid, true);

  const insufficient = earlyInspector({
    verdict: { tradeOpened: false, rejectionReason: 'Insufficient candles (10/15 minimum)', trade: null },
  });
  assert.equal(evaluateGateCoverage(normalizeInspectorResponse(insufficient)).valid, true);

  const changedInsufficientWording = earlyInspector({
    verdict: { tradeOpened: false, rejectionReason: 'Data warm-up is still in progress', trade: null },
  });
  assert.equal(evaluateGateCoverage(normalizeInspectorResponse(changedInsufficientWording)).valid, true);
});

test('early structural coverage rejects empty reasons, trades, and progressed state', () => {
  assert.throws(() => normalizeInspectorResponse(earlyInspector({
    verdict: { tradeOpened: false, rejectionReason: '', trade: null },
  })), /non-empty rejectionReason/);

  const opened = earlyInspector({
    verdict: { tradeOpened: true, rejectionReason: null },
  });
  assert.equal(evaluateGateCoverage(normalizeInspectorResponse(opened)).valid, false);

  assert.throws(() => normalizeInspectorResponse(earlyInspector({
    verdict: { tradeOpened: false, rejectionReason: 'blocked', trade: inspectorResponse().verdict.trade },
  })), /tradeOpened false requires a null trade/);

  const progressedRisk = earlyInspector({
    risk: { tradeAllowed: false },
    verdict: { tradeOpened: false, rejectionReason: 'risk state present', trade: null },
  });
  assert.equal(evaluateGateCoverage(normalizeInspectorResponse(progressedRisk)).valid, false);

  const progressedDecision = earlyInspector({
    verdict: { tradeOpened: false, rejectionReason: 'decision state present', trade: null },
  });
  progressedDecision.regimeDecision = { allowTrade: false };
  assert.equal(evaluateGateCoverage(normalizeInspectorResponse(progressedDecision)).valid, false);
});

test('poll accounting records attempts, expected attempts, and positive schedule drift', () => {
  const metrics = verificationMetrics();

  recordPollAttempt(metrics, 1000);
  recordPollAttempt(metrics, 4050);
  recordPollAttempt(metrics, 7250);

  assert.equal(metrics.polling.pollAttempts, 3);
  assert.equal(metrics.polling.expectedPollAttempts, 3);
  assert.equal(metrics.polling.pollingDriftMs, 250);
});

test('failure accounting keeps independent counts and first details', () => {
  const metrics = verificationMetrics();

  recordVerificationFailure(metrics, 'inspectorEndpoint', 'HTTP 503', 1100);
  recordVerificationFailure(metrics, 'inspectorEndpoint', 'timeout', 1200);
  recordVerificationFailure(metrics, 'inspectorContract', 'missing gates', 1300);
  recordVerificationFailure(metrics, 'paperEndpoint', 'HTTP 502', 1400);
  recordVerificationFailure(metrics, 'paperContract', 'closed must be an array', 1500);

  assert.equal(metrics.errors.inspectorEndpoint.count, 2);
  assert.deepEqual(metrics.errors.inspectorEndpoint, {
    count: 2,
    firstMessage: 'HTTP 503',
    firstTimestamp: 1100,
  });
  assert.equal(metrics.errors.inspectorContract.count, 1);
  assert.equal(metrics.errors.paperEndpoint.count, 1);
  assert.equal(metrics.errors.paperContract.count, 1);
});

test('inspector and paper response accounting separates success, availability, and startup', () => {
  const metrics = verificationMetrics();

  recordSuccessfulInspectorPoll(metrics);
  recordInspectorResponse(metrics, { available: false }, 1100);
  recordSuccessfulInspectorPoll(metrics);
  recordInspectorResponse(metrics, { available: true, cycle: 1 }, 1200);
  recordSuccessfulPaperPoll(metrics);

  assert.equal(metrics.polling.successfulInspectorPolls, 2);
  assert.equal(metrics.polling.validInspectorResponses, 2);
  assert.equal(metrics.polling.unavailableInspectorPolls, 1);
  assert.equal(metrics.polling.availableInspectorPolls, 1);
  assert.equal(metrics.polling.successfulPaperPolls, 1);
  assert.equal(metrics.source.uniqueSourceCycles, 1);
});

test('source identity uses cycle ID and repeated timestamps or wording remain duplicates', () => {
  const metrics = verificationMetrics();

  recordSourceObservation(metrics, sourceObservation(7), 1000);
  recordSourceObservation(metrics, { ...sourceObservation(7), timestamp: 'changed' }, 2000);
  recordSourceObservation(metrics, sourceObservation(7), 3000);

  assert.equal(metrics.source.uniqueSourceCycles, 1);
  assert.equal(metrics.source.duplicateSourceObservations, 2);
  assert.equal(metrics.source.firstSourceCycle, 7);
  assert.equal(metrics.source.lastSourceCycle, 7);
  assert.equal(metrics.source.firstUniqueSourceObservedAt, 1000);
  assert.equal(metrics.source.lastUniqueSourceObservedAt, 1000);
});

test('slower source progress records gaps without comparing against poll attempts', () => {
  const metrics = verificationMetrics();
  recordSourceObservation(metrics, sourceObservation(10), 1000);
  recordSourceObservation(metrics, sourceObservation(13), 11000);

  assert.equal(metrics.source.uniqueSourceCycles, 2);
  assert.equal(metrics.source.missingSourceCycleCount, 2);
  assert.deepEqual(metrics.source.missingSourceCycleRanges, [{ from: 11, to: 12, count: 2 }]);
  assert.equal(metrics.source.maximumObservedSourceStallMs, 10000);

  const result = evaluateChecks([], [], { metrics });
  const checks = Object.fromEntries(result.checks.map(check => [check.name, check]));
  assert.equal(checks['Source cycle progressed'].pass, true);
  assert.equal(checks['Source cycle continuity'].pass, true);
  assert.equal(metrics.polling.expectedPollAttempts, 3);
  assert.equal(metrics.source.uniqueSourceCycles, 2);
});

test('lower source cycle IDs record a regression and fail continuity', () => {
  const metrics = verificationMetrics();
  recordSourceObservation(metrics, sourceObservation(8), 1000);
  const result = recordSourceObservation(metrics, sourceObservation(3), 2000);

  assert.equal(result.type, 'regression');
  assert.equal(metrics.source.uniqueSourceCycles, 1);
  assert.equal(metrics.source.lastSourceCycle, 8);
  assert.equal(metrics.source.sourceCycleRegressions, 1);
  assert.deepEqual(metrics.source.sourceCycleRegressionDetails, [{
    previousCycle: 8,
    cycle: 3,
    observedAt: 2000,
  }]);
  const checks = Object.fromEntries(evaluateChecks([], [], { metrics }).checks.map(check => [check.name, check]));
  assert.equal(checks['Source cycle continuity'].pass, false);
});

test('source stall and final stall use explicit receipt timestamps', () => {
  const metrics = verificationMetrics();
  recordSourceObservation(metrics, sourceObservation(1), 1000);
  recordSourceObservation(metrics, sourceObservation(2), 4500);
  finalizeVerificationMetrics(metrics, 8000);

  assert.equal(metrics.source.maximumObservedSourceStallMs, 3500);
  assert.equal(metrics.source.finalSourceStallMs, 3500);
  assert.equal(metrics.runtime.actualElapsedMs, 7000);
  assert.equal(metrics.runtime.runCompleted, false);
});

test('zero and one source cycles are non-passing with explicit progress details', () => {
  const zero = verificationMetrics();
  const one = verificationMetrics();
  recordSourceObservation(one, sourceObservation(1), 1000);

  const zeroCheck = evaluateChecks([], [], { metrics: zero }).checks.find(check => check.name === 'Source cycle progressed');
  const oneCheck = evaluateChecks([], [], { metrics: one }).checks.find(check => check.name === 'Source cycle progressed');
  assert.equal(zeroCheck.pass, false);
  assert.match(zeroCheck.detail, /No unique/);
  assert.equal(oneCheck.pass, false);
  assert.match(oneCheck.detail, /Inconclusive/);
});

test('two monotonic source cycles pass progress and exact runtime boundary passes', () => {
  const metrics = verificationMetrics();
  recordSourceObservation(metrics, sourceObservation(1), 1000);
  recordSourceObservation(metrics, sourceObservation(2), 2000);
  finalizeVerificationMetrics(metrics, 10000);

  const checks = Object.fromEntries(evaluateChecks([], [], { metrics }).checks.map(check => [check.name, check]));
  assert.equal(checks['Source cycle progressed'].pass, true);
  assert.equal(checks['Requested runtime completed'].pass, true);
  assert.equal(metrics.runtime.actualElapsedMs, metrics.runtime.requestedDurationMs);
});

test('runtime below the requested boundary fails completion', () => {
  const metrics = verificationMetrics();
  finalizeVerificationMetrics(metrics, 9999);

  const check = evaluateChecks([], [], { metrics }).checks.find(item => item.name === 'Requested runtime completed');
  assert.equal(metrics.runtime.runCompleted, false);
  assert.equal(check.pass, false);
});

test('endpoint and contract integrity checks fail independently', () => {
  const metrics = verificationMetrics();
  recordVerificationFailure(metrics, 'inspectorEndpoint', 'timeout', 1);
  recordVerificationFailure(metrics, 'paperContract', 'bad paper shape', 2);
  const checks = Object.fromEntries(evaluateChecks([], [], { metrics }).checks.map(check => [check.name, check]));

  assert.equal(checks['Inspector endpoint integrity'].pass, false);
  assert.equal(checks['Inspector schema integrity'].pass, true);
  assert.equal(checks['Paper endpoint integrity'].pass, true);
  assert.equal(checks['Paper contract integrity'].pass, false);
});

test('serialized verification metrics are additive and omit internal state', () => {
  const metrics = verificationMetrics();
  recordSourceObservation(metrics, sourceObservation(4), 1000);
  const serialized = serializeVerificationMetrics(metrics);

  assert.ok(serialized.polling);
  assert.ok(serialized.errors);
  assert.ok(serialized.source);
  assert.ok(serialized.runtime);
  assert.equal(Object.hasOwn(serialized, '_seenSourceCycles'), false);
  assert.equal(Object.hasOwn(serialized.source, 'missingSourceCycleIds'), false);
  assert.deepEqual(serialized.source.missingSourceCycleRanges, []);
});

test('compact gap diagnostics record exact ranges without enumerating IDs', () => {
  const metrics = verificationMetrics();
  recordSourceObservation(metrics, sourceObservation(10), 1000);
  recordSourceObservation(metrics, sourceObservation(12), 2000);

  assert.equal(metrics.source.missingSourceCycleCount, 1);
  assert.deepEqual(metrics.source.missingSourceCycleRanges, [{ from: 11, to: 11, count: 1 }]);
  assert.equal(Object.hasOwn(metrics.source, 'missingSourceCycleIds'), false);
});

test('large source gaps remain compact, constant-time in representation, and diagnostic only', () => {
  const metrics = verificationMetrics();
  recordSourceObservation(metrics, { cycle: 10 }, 1000);
  recordSourceObservation(metrics, { cycle: 10000000 }, 2000);

  assert.equal(metrics.source.missingSourceCycleCount, 9999989);
  assert.deepEqual(metrics.source.missingSourceCycleRanges, [{ from: 11, to: 9999999, count: 9999989 }]);
  assert.equal(metrics.source.missingSourceCycleRanges.length, 1);
  assert.equal(Object.hasOwn(metrics.source, 'missingSourceCycleIds'), false);

  const checks = Object.fromEntries(evaluateChecks([], [], { metrics }).checks.map(check => [check.name, check]));
  assert.equal(checks['Source cycle progressed'].pass, true);
  assert.equal(checks['Source cycle continuity'].pass, true);
  assert.equal(JSON.stringify(serializeVerificationMetrics(metrics).source.missingSourceCycleRanges).length < 100, true);
});

test('regressions preserve the monotonic baseline and source timing', () => {
  const metrics = verificationMetrics();
  recordSourceObservation(metrics, sourceObservation(8), 1000);
  recordSourceObservation(metrics, sourceObservation(3), 9000);

  assert.equal(metrics.source.uniqueSourceCycles, 1);
  assert.equal(metrics.source.lastSourceCycle, 8);
  assert.equal(metrics.source.sourceCycleRegressions, 1);
  assert.equal(metrics.source.lastUniqueSourceObservedAt, 1000);
  assert.equal(metrics.source.maximumObservedSourceStallMs, 0);
  assert.deepEqual(metrics.source.missingSourceCycleRanges, []);
});

test('progress after a regression uses the original baseline without a false gap', () => {
  const metrics = verificationMetrics();
  recordSourceObservation(metrics, sourceObservation(8), 1000);
  recordSourceObservation(metrics, sourceObservation(3), 2000);
  recordSourceObservation(metrics, sourceObservation(9), 3000);

  assert.equal(metrics.source.firstSourceCycle, 8);
  assert.equal(metrics.source.lastSourceCycle, 9);
  assert.equal(metrics.source.uniqueSourceCycles, 2);
  assert.equal(metrics.source.missingSourceCycleCount, 0);
  assert.deepEqual(metrics.source.missingSourceCycleRanges, []);
  const checks = Object.fromEntries(evaluateChecks([], [], { metrics }).checks.map(check => [check.name, check]));
  assert.equal(checks['Source cycle progressed'].pass, true);
  assert.equal(checks['Source cycle continuity'].pass, false);
});

test('progress after a regression records only the true forward gap', () => {
  const metrics = verificationMetrics();
  recordSourceObservation(metrics, sourceObservation(8), 1000);
  recordSourceObservation(metrics, sourceObservation(3), 2000);
  recordSourceObservation(metrics, sourceObservation(10), 3000);

  assert.equal(metrics.source.lastSourceCycle, 10);
  assert.equal(metrics.source.missingSourceCycleCount, 1);
  assert.deepEqual(metrics.source.missingSourceCycleRanges, [{ from: 9, to: 9, count: 1 }]);
  assert.equal(metrics.source.sourceCycleRegressions, 1);
});

test('repeated regressed cycles remain deterministic and do not reset progress timing', () => {
  const metrics = verificationMetrics();
  recordSourceObservation(metrics, sourceObservation(8), 1000);
  recordSourceObservation(metrics, sourceObservation(3), 2000);
  recordSourceObservation(metrics, sourceObservation(3), 3000);

  assert.equal(metrics.source.sourceCycleRegressions, 2);
  assert.equal(metrics.source.uniqueSourceCycles, 1);
  assert.equal(metrics.source.lastSourceCycle, 8);
  assert.equal(metrics.source.lastUniqueSourceObservedAt, 1000);
  assert.equal(metrics.source.maximumObservedSourceStallMs, 0);
});

test('inspector contract failure does not prevent paper success processing', () => {
  const context = processPoll(fulfilled(removeGates(inspectorResponse(), ['trend'])), fulfilled({ open: [], closed: [] }));

  assert.equal(context.metrics.errors.inspectorContract.count, 1);
  assert.equal(context.metrics.polling.successfulPaperPolls, 1);
  assert.equal(context.metrics.errors.paperContract.count, 0);
});

test('paper contract failure does not prevent inspector success processing', () => {
  const context = processPoll(fulfilled(inspectorResponse()), fulfilled({ open: [] }));

  assert.equal(context.metrics.polling.validInspectorResponses, 1);
  assert.equal(context.metrics.source.uniqueSourceCycles, 1);
  assert.equal(context.metrics.errors.paperContract.count, 1);
  assert.equal(context.metrics.polling.successfulPaperPolls, 0);
});

test('inspector endpoint failure does not prevent paper success processing', () => {
  const context = processPoll(rejected(new Error('inspector timeout')), fulfilled({ open: [], closed: [] }));

  assert.equal(context.metrics.errors.inspectorEndpoint.count, 1);
  assert.equal(context.metrics.polling.successfulPaperPolls, 1);
  assert.equal(context.metrics.errors.paperContract.count, 0);
});

test('paper endpoint failure does not prevent inspector success processing', () => {
  const context = processPoll(fulfilled(inspectorResponse()), rejected(new Error('paper connection refused')));

  assert.equal(context.metrics.polling.validInspectorResponses, 1);
  assert.equal(context.metrics.source.uniqueSourceCycles, 1);
  assert.equal(context.metrics.errors.paperEndpoint.count, 1);
});

test('both contract failures are recorded independently in one poll', () => {
  const context = processPoll(
    fulfilled(removeGates(inspectorResponse(), ['trend'])),
    fulfilled({ open: [] }),
  );

  assert.equal(context.metrics.errors.inspectorContract.count, 1);
  assert.equal(context.metrics.errors.paperContract.count, 1);
  assert.equal(context.metrics.polling.successfulPaperPolls, 0);
  assert.equal(context.metrics.polling.validInspectorResponses, 0);
});

test('inspector endpoint and paper contract failures remain separate', () => {
  const context = processPoll(rejected(new Error('inspector refused')), fulfilled({ open: [] }));

  assert.equal(context.metrics.errors.inspectorEndpoint.count, 1);
  assert.equal(context.metrics.errors.paperContract.count, 1);
  assert.equal(context.metrics.errors.inspectorContract.count, 0);
  assert.equal(context.metrics.errors.paperEndpoint.count, 0);
});

test('inspector contract and paper endpoint failures remain separate', () => {
  const context = processPoll(fulfilled(removeGates(inspectorResponse(), ['trend'])), rejected(new Error('paper timeout')));

  assert.equal(context.metrics.errors.inspectorContract.count, 1);
  assert.equal(context.metrics.errors.paperEndpoint.count, 1);
  assert.equal(context.metrics.errors.inspectorEndpoint.count, 0);
  assert.equal(context.metrics.errors.paperContract.count, 0);
});

test('invalid JSON is a contract failure for inspector and paper independently', () => {
  const inspectorContext = processPoll(rejected(invalidJsonError()), fulfilled({ open: [], closed: [] }));
  assert.equal(inspectorContext.metrics.errors.inspectorContract.count, 1);
  assert.equal(inspectorContext.metrics.errors.inspectorEndpoint.count, 0);
  assert.equal(inspectorContext.metrics.polling.successfulPaperPolls, 1);

  const paperContext = processPoll(fulfilled(inspectorResponse()), rejected(invalidJsonError()));
  assert.equal(paperContext.metrics.errors.paperContract.count, 1);
  assert.equal(paperContext.metrics.errors.paperEndpoint.count, 0);
  assert.equal(paperContext.metrics.polling.validInspectorResponses, 1);
});

test('timeouts and non-2xx responses remain endpoint failures', () => {
  const timeout = processPoll(rejected(new Error('Request timeout')), fulfilled({ open: [], closed: [] }));
  assert.equal(timeout.metrics.errors.inspectorEndpoint.count, 1);
  assert.equal(timeout.metrics.errors.inspectorContract.count, 0);

  const httpFailure = processPoll(fulfilled(inspectorResponse()), rejected(new Error('HTTP 503 for /api/paper-trades')));
  assert.equal(httpFailure.metrics.errors.paperEndpoint.count, 1);
  assert.equal(httpFailure.metrics.errors.paperContract.count, 0);
});

test('inspector valid counters are recorded only after full validation', () => {
  const invalid = processPoll(fulfilled(removeGates(inspectorResponse(), ['trend'])), fulfilled({ open: [], closed: [] }));
  assert.equal(invalid.metrics.polling.validInspectorResponses, 0);
  assert.equal(invalid.metrics.polling.availableInspectorPolls, 0);
  assert.equal(invalid.metrics.source.uniqueSourceCycles, 0);

  const available = processPoll(fulfilled(inspectorResponse()), fulfilled({ open: [], closed: [] }));
  assert.equal(available.metrics.polling.validInspectorResponses, 1);
  assert.equal(available.metrics.polling.availableInspectorPolls, 1);
  assert.equal(available.metrics.source.uniqueSourceCycles, 1);

  const unavailable = processPoll(fulfilled({
    available: false,
    message: 'No decision data yet — waiting for first pipeline cycle',
  }), fulfilled({ open: [], closed: [] }));
  assert.equal(unavailable.metrics.polling.validInspectorResponses, 1);
  assert.equal(unavailable.metrics.polling.unavailableInspectorPolls, 1);
  assert.equal(unavailable.metrics.polling.availableInspectorPolls, 0);
  assert.equal(unavailable.metrics.source.uniqueSourceCycles, 0);
});

test('report serializes compact diagnostics, failures, and truthful labels without mutation', () => {
  const metrics = verificationMetrics();
  recordSourceObservation(metrics, sourceObservation(10), 1000);
  recordSourceObservation(metrics, sourceObservation(12), 2000);
  recordVerificationFailure(metrics, 'inspectorEndpoint', 'timeout', 3000);
  finalizeVerificationMetrics(metrics, 10000);
  const before = JSON.stringify(serializeVerificationMetrics(metrics));

  const report = generateReport([], [], 1000, 10000, { metrics });
  evaluateChecks([], [], { metrics });
  const after = JSON.stringify(serializeVerificationMetrics(metrics));

  assert.equal(after, before);
  assert.match(report, /Missing Source Cycle Count \(diagnostic only\) \| 1/);
  assert.match(report, /Missing Source Cycle Ranges \(diagnostic only\).*\"from\":11.*\"to\":11/);
  assert.match(report, /Maximum Observed Source Stall \(diagnostic only\)/);
  assert.match(report, /Final Source Stall \(diagnostic only\)/);
  assert.match(report, /Polling Drift \(diagnostic only\)/);
  assert.match(report, /do not independently fail verification/);
  assert.match(report, /inspectorEndpoint \| 1 \| timeout \| 3000/);
  assert.doesNotMatch(report, /missingSourceCycleIds/);
});

test('neutral path accepts explicitly skipped downstream gates', () => {
  const coverage = evaluateGateCoverage(normalizeInspectorResponse(neutralInspector()));
  assert.equal(coverage.valid, true);
  assert.equal(coverage.path, 'neutral');
  assert.equal(coverage.statuses.mtfConfirmation, 'skipped');
  assert.equal(coverage.statuses.advanceRisk, 'skipped');
});

test('regime rejection accepts legitimate downstream gate absence', () => {
  const coverage = evaluateGateCoverage(normalizeInspectorResponse(regimeRejectedInspector()));
  assert.equal(coverage.valid, true);
  assert.equal(coverage.path, 'regime-rejection');
  assert.equal(coverage.statuses.mtfConfirmation, 'legitimately-absent');
  assert.equal(coverage.statuses.advanceRisk, 'legitimately-absent');
});

test('MTF rejection accepts missing AdvanceRisk', () => {
  const coverage = evaluateGateCoverage(normalizeInspectorResponse(mtfRejectedInspector()));
  assert.equal(coverage.valid, true);
  assert.equal(coverage.path, 'mtf-rejection');
  assert.equal(coverage.statuses.advanceRisk, 'legitimately-absent');
});

test('AdvanceRisk rejection is an evaluated rejection', () => {
  const coverage = evaluateGateCoverage(normalizeInspectorResponse(advanceRiskRejectedInspector()));
  assert.equal(coverage.valid, true);
  assert.equal(coverage.statuses.advanceRisk, 'evaluated-fail');
});

test('fully evaluated opened-trade path accepts all canonical gates', () => {
  const response = inspectorResponse();
  const coverage = evaluateGateCoverage(normalizeInspectorResponse(response));
  assert.equal(coverage.valid, true);
  assert.deepEqual(Object.keys(response.gates), [
    'trend', 'structure', 'rsi', 'ema', 'macd', 'atr', 'bollinger',
    'confluenceBias', 'regimeDecision', 'mtfConfirmation', 'advanceRisk',
  ]);
});

test('missing mandatory and downstream gates fail coverage', () => {
  const missingBase = removeGates(inspectorResponse(), ['trend']);
  assert.equal(evaluateGateCoverage(normalizeInspectorResponse(missingBase)).valid, false);

  const missingDownstream = removeGates(inspectorResponse(), ['mtfConfirmation']);
  const coverage = evaluateGateCoverage(normalizeInspectorResponse(missingDownstream));
  assert.equal(coverage.valid, false);
  assert.match(coverage.errors.join(' '), /requires mtfConfirmation/);
});

test('unknown extra gates and malformed gate objects fail validation', () => {
  assert.throws(() => normalizeInspectorResponse({
    ...inspectorResponse(),
    gates: { ...inspectorResponse().gates, extraGate: inspectorGate(true, 'ALLOWED') },
  }), /unknown gate extraGate/);
  assert.throws(() => normalizeInspectorResponse({
    ...inspectorResponse(),
    gates: { ...inspectorResponse().gates, advanceRisk: { pass: 'true', value: 'ALLOWED', detail: 'bad' } },
  }), /malformed gate advanceRisk/);
});

test('pass:false is evaluated, while not-ready diagnostic values remain valid', () => {
  const response = advanceRiskRejectedInspector();
  response.gates.rsi = inspectorGate(false, '--', 'Not ready');
  response.gates.ema = inspectorGate(false, 'N/A', 'Not ready');
  response.gates.macd = inspectorGate(false, 'Neutral', 'Not ready');
  response.gates.atr = inspectorGate(false, '--', 'Not ready');
  response.gates.bollinger = inspectorGate(false, 'Inside Bands', 'Not ready');
  const coverage = evaluateGateCoverage(normalizeInspectorResponse(response));

  assert.equal(coverage.valid, true);
  assert.equal(coverage.statuses.advanceRisk, 'evaluated-fail');
  assert.equal(coverage.statuses.rsi, 'evaluated-fail');
});

test('report uses canonical gate names and the gate coverage check', () => {
  const cycle = buildCycleRecord(normalizeInspectorResponse(neutralInspector()));
  const report = generateReport([cycle], [], Date.parse(OPENED_AT), Date.parse(CLOSED_AT), { failed: false });

  assert.match(report, /\| advanceRisk \|/);
  assert.match(report, /\| regimeDecision \|/);
  assert.match(report, /\| mtfConfirmation \|/);
  assert.doesNotMatch(report, /\| riskEngine \|/);
  assert.match(report, /Gate coverage contract/);
  assert.doesNotMatch(report, /All gates evaluated \(no stale --\)/);
});

test('gate coverage does not depend only on confluenceBias', () => {
  const response = removeGates(inspectorResponse(), ['trend']);
  const coverage = evaluateGateCoverage(normalizeInspectorResponse(response));

  assert.equal(response.gates.confluenceBias.pass, true);
  assert.equal(coverage.valid, false);
  assert.match(coverage.errors.join(' '), /Missing mandatory gate trend/);
});

test('open trade disappearance does not delete the logical record', () => {
  const trades = new Map();
  mergeResponse(trades, { open: [productionTrade()], closed: [] });

  assert.equal(trades.size, 1);
  assert.equal(trades.get('PT-1').type, 'opened');
});

test('HTTP and JSON failures reject fetchJSON', async () => {
  const previousApiKey = process.env.ATLAS_VERIFY_API_KEY;
  process.env.ATLAS_VERIFY_API_KEY = 'verifier-test-api-key-32-characters';
  try {
    const httpServer = await startResponseServer({ error: 'unavailable' }, 503);
    try {
      await assert.rejects(fetchJSON('/api/paper-trades'), /HTTP 503/);
    } finally {
      await stopServer(httpServer);
    }

    const jsonServer = await startResponseServer('{invalid}');
    try {
      await assert.rejects(fetchJSON('/api/paper-trades'), /JSON parse error/);
    } finally {
      await stopServer(jsonServer);
    }
  } finally {
    if (previousApiKey === undefined) delete process.env.ATLAS_VERIFY_API_KEY;
    else process.env.ATLAS_VERIFY_API_KEY = previousApiKey;
  }
});

test('report preserves existing headings and logical trade counts', () => {
  const cycles = [{
    price: 100,
    confluenceScore: 70,
    bias: 'Bullish',
    gates: {},
    tradeOpened: false,
    rejectionReason: 'test',
  }];
  const trades = [{
    id: 'PT-1',
    type: 'closed',
    side: 'BUY',
    entry: 100,
    exit: 110,
    sl: 95,
    tp: 110,
    size: 10,
    rr: 2,
    pnl: 100,
    openedAt: OPENED_AT,
    closedAt: CLOSED_AT,
    timestamp: OPENED_AT,
  }];

  const report = generateReport(cycles, trades, Date.parse(OPENED_AT), Date.parse(CLOSED_AT), { failed: false });

  assert.match(report, /## Summary/);
  assert.match(report, /## Trade Performance/);
  assert.match(report, /## Verification Checks/);
  assert.match(report, /Total Trade Opened \| 1/);
  assert.match(report, /Inspector endpoint integrity/);
  assert.match(report, /Paper contract integrity/);
  assert.doesNotMatch(report, /Consistent cycle count/);
  assert.doesNotMatch(report, /Maximum source stall check/);
});

function endpointContractChecks(verificationState) {
  const result = evaluateChecks([], [], verificationState);
  return Object.fromEntries(
    result.checks
      .filter(check => check.name === 'Inspector endpoint integrity' || check.name === 'Paper endpoint integrity')
      .map(check => [check.name, check.pass])
  );
}

test('inspector failure only fails the pipeline endpoint contract', () => {
  assert.deepEqual(endpointContractChecks({
    inspectorFailed: true,
    paperContractFailed: false,
  }), {
    'Inspector endpoint integrity': false,
    'Paper endpoint integrity': true,
  });
});

test('paper failure only fails the paper trades response contract', () => {
  assert.deepEqual(endpointContractChecks({
    inspectorFailed: false,
    paperContractFailed: true,
  }), {
    'Inspector endpoint integrity': true,
    'Paper endpoint integrity': false,
  });
});

test('both endpoint failures fail both endpoint contracts', () => {
  assert.deepEqual(endpointContractChecks({
    inspectorFailed: true,
    paperContractFailed: true,
  }), {
    'Inspector endpoint integrity': false,
    'Paper endpoint integrity': false,
  });
});

test('no endpoint failures pass both endpoint contracts', () => {
  assert.deepEqual(endpointContractChecks({
    inspectorFailed: false,
    paperContractFailed: false,
  }), {
    'Inspector endpoint integrity': true,
    'Paper endpoint integrity': true,
  });
});
