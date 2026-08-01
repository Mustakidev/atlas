const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const {
  evaluateChecks,
  fetchJSON,
  generateReport,
  mergeTradeObservation,
  normalizePaperTradeResponse,
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

test('open trade disappearance does not delete the logical record', () => {
  const trades = new Map();
  mergeResponse(trades, { open: [productionTrade()], closed: [] });

  assert.equal(trades.size, 1);
  assert.equal(trades.get('PT-1').type, 'opened');
});

test('HTTP and JSON failures reject fetchJSON', async () => {
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
  assert.match(report, /Pipeline endpoint contract/);
  assert.match(report, /Paper trades response contract/);
});

function endpointContractChecks(verificationState) {
  const result = evaluateChecks([], [], verificationState);
  return Object.fromEntries(
    result.checks
      .filter(check => check.name.endsWith('endpoint contract') || check.name === 'Paper trades response contract')
      .map(check => [check.name, check.pass])
  );
}

test('inspector failure only fails the pipeline endpoint contract', () => {
  assert.deepEqual(endpointContractChecks({
    inspectorFailed: true,
    paperContractFailed: false,
  }), {
    'Pipeline endpoint contract': false,
    'Paper trades response contract': true,
  });
});

test('paper failure only fails the paper trades response contract', () => {
  assert.deepEqual(endpointContractChecks({
    inspectorFailed: false,
    paperContractFailed: true,
  }), {
    'Pipeline endpoint contract': true,
    'Paper trades response contract': false,
  });
});

test('both endpoint failures fail both endpoint contracts', () => {
  assert.deepEqual(endpointContractChecks({
    inspectorFailed: true,
    paperContractFailed: true,
  }), {
    'Pipeline endpoint contract': false,
    'Paper trades response contract': false,
  });
});

test('no endpoint failures pass both endpoint contracts', () => {
  assert.deepEqual(endpointContractChecks({
    inspectorFailed: false,
    paperContractFailed: false,
  }), {
    'Pipeline endpoint contract': true,
    'Paper trades response contract': true,
  });
});
