const test = require('node:test');
const assert = require('node:assert/strict');

const { ValidationEngine } = require('../../src/engine/validation');
const { createValidationDependencies } = require('../../src/engine/validationDependencies');
const { createRouter } = require('../../src/routes/routes');
const { HistoryEngine } = require('../../src/engine/history');
const { CandleEngine } = require('../../src/engine/candles');
const { MarketAnalyzer } = require('../../src/engine/analyzer');
const { createIndicatorRegistry } = require('../../src/engine/indicators');
const { StructureEngine } = require('../../src/engine/structure');
const { ConfluenceEngine } = require('../../src/engine/confluence');
const { MTFEngine } = require('../../src/engine/mtf');
const { MACDEngine } = require('../../src/engine/macd');
const { ATREngine } = require('../../src/engine/atr');
const { BollingerEngine } = require('../../src/engine/bollinger');
const { PaperTradingEngine } = require('../../src/engine/paperTrading');
const { RiskEngine } = require('../../src/engine/risk');
const { AdvanceRiskEngine } = require('../../src/engine/advanceRisk');
const { MTFConfirmationEngine } = require('../../src/engine/mtfConfirmation');
const { RegimeEngine } = require('../../src/market-regime/RegimeEngine');
const { RegimeDecisionEngine } = require('../../src/market-regime/RegimeDecisionEngine');
const { createExecutionPipeline } = require('../../src/core/executionPipeline');
const { getFinalizedCandles } = require('../../src/engine/candleUtils');

const SYMBOL = 'BTCUSDT';
const FIXED_NOW = Date.parse('2024-01-01T00:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const VOLATILE_KEYS = new Set([
  'timestamp', 'lastUpdated', 'calculationTime', 'executionTime', 'analysisTime',
  'calculatedAt', 'analyzedAt', 'entryTime', 'exitTime', 'duration',
]);

function config() {
  const values = {
    MAX_HISTORY: 500,
    SYMBOL,
    CONFLUENCE_BULLISH_THRESHOLD: 65,
    CONFLUENCE_BEARISH_THRESHOLD: 35,
  };
  return {
    get(key) { return values[key]; },
    getAll() { return { ...values }; },
  };
}

function recordingLogger(entries) {
  const record = (level, module, message, data) => entries.push({ level, module, message, data });
  return {
    info(module, message, data) { record('info', module, message, data); },
    warn(module, message, data) { record('warn', module, message, data); },
    error(module, message, data) { record('error', module, message, data); },
    system(module, message, data) { record('system', module, message, data); },
  };
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, nested] of Object.entries(value)) {
      if (!VOLATILE_KEYS.has(key)) result[key] = stable(nested);
    }
    return result;
  }
  if (typeof value === 'string') {
    return value
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, '<timestamp>')
      .replace(/\b\d+(?:\.\d+)?ms\b/g, '<duration>');
  }
  return value;
}

function bullishTimeframes() {
  return {
    '1m': { confluence: { bias: 'Bullish', score: 70, confidence: 70 } },
    '5m': { confluence: { bias: 'Bullish', score: 70, confidence: 70 } },
    '15m': { confluence: { bias: 'Bullish', score: 70, confidence: 70 } },
    '1h': { confluence: { bias: 'Bullish', score: 70, confidence: 70 } },
  };
}

function createProductionGraph() {
  const logs = [];
  const graphConfig = config();
  const logger = recordingLogger(logs);
  const history = new HistoryEngine(graphConfig, logger, SYMBOL);
  const candleEngine = new CandleEngine(graphConfig, logger, SYMBOL);
  const analyzer = new MarketAnalyzer(logger, SYMBOL);
  const indicatorRegistry = createIndicatorRegistry(SYMBOL);
  const structureEngine = new StructureEngine(logger, SYMBOL);
  const confluenceEngine = new ConfluenceEngine({ analyzer, indicatorRegistry, structureEngine, candleEngine, logger, config: graphConfig, symbol: SYMBOL });
  const mtfEngine = new MTFEngine({ confluenceEngine, structureEngine, indicatorRegistry, candleEngine, analyzer, logger, config: graphConfig, symbol: SYMBOL });
  const macdEngine = new MACDEngine({ candleEngine, logger, symbol: SYMBOL });
  const atrEngine = new ATREngine({ candleEngine, logger, symbol: SYMBOL });
  const bollingerEngine = new BollingerEngine({ candleEngine, logger, symbol: SYMBOL });
  const paperTradeEngine = new PaperTradingEngine({ logger, symbol: SYMBOL });
  const riskEngine = new RiskEngine({ logger, symbol: SYMBOL });
  const regimeEngine = new RegimeEngine({ indicatorRegistry, atrEngine, candleEngine, analyzer, logger, config: graphConfig, symbol: SYMBOL });
  const regimeDecisionEngine = new RegimeDecisionEngine({ logger, symbol: SYMBOL });
  const advanceRiskEngine = new AdvanceRiskEngine({ logger, symbol: SYMBOL, paperTradeEngine, config: graphConfig });
  const mtfConfirmationEngine = new MTFConfirmationEngine({ logger, symbol: SYMBOL, config: graphConfig });

  let validationFactoryCalls = 0;
  const validationDependencyFactory = () => {
    validationFactoryCalls++;
    return createValidationDependencies({ config: graphConfig, symbol: SYMBOL });
  };
  const validationEngine = new ValidationEngine({
    analyzer,
    indicatorRegistry,
    structureEngine,
    candleEngine,
    regimeEngine,
    regimeDecisionEngine,
    advanceRiskEngine,
    mtfConfirmationEngine,
    logger,
    symbol: SYMBOL,
    dependencyFactory: validationDependencyFactory,
  });

  const clockState = { calls: 0 };
  const pipeline = createExecutionPipeline({
    config: graphConfig,
    logger,
    symbol: SYMBOL,
    candleEngine,
    regimeEngine,
    confluenceEngine,
    atrEngine,
    analyzer,
    structureEngine,
    indicatorRegistry,
    macdEngine,
    bollingerEngine,
    regimeDecisionEngine,
    mtfConfirmationEngine,
    advanceRiskEngine,
    mtfEngine,
    paperTradeEngine,
    clock: {
      now: () => FIXED_NOW + clockState.calls * 60000,
      isoNow: () => '2024-01-01T00:00:00.000Z',
      localeTime: () => '12:00:00 AM',
    },
  });

  return {
    config: graphConfig,
    logs,
    logger,
    history,
    candleEngine,
    analyzer,
    indicatorRegistry,
    structureEngine,
    confluenceEngine,
    mtfEngine,
    macdEngine,
    atrEngine,
    bollingerEngine,
    paperTradeEngine,
    riskEngine,
    regimeEngine,
    regimeDecisionEngine,
    advanceRiskEngine,
    mtfConfirmationEngine,
    validationEngine,
    validationFactoryCalls: () => validationFactoryCalls,
    pipeline,
    clockState,
  };
}

function seedMarket(graph) {
  for (let i = 0; i < 80; i++) {
    const price = 100 + i * 0.35 + Math.sin(i * 0.55) * 3;
    const timestamp = new Date(FIXED_NOW + i * HOUR).toISOString();
    const snapshot = {
      symbol: SYMBOL,
      price,
      volume: 1000 + i,
      change24h: 0.5,
      timestamp,
    };
    graph.history.add(snapshot);
    graph.candleEngine.ingest(snapshot);
  }
  graph.analyzer.analyze(graph.history);
}

function seedPaperTrading(graph) {
  const engines = {
    trend: { trend: { '1H': 'Bullish' } },
    structure: { ready: true, direction: 'bullish', structure: 'Bullish', score: 80 },
    rsi: { ready: true, value: 70, state: 'Overbought' },
    ema: { ready: true, value: 110, trend: 'Above' },
    macd: { ready: true, trend: 'Bullish', histogram: 1 },
    bollinger: { ready: true, pricePosition: 'Inside Bands' },
    confluence: { bias: 'Bullish', score: 80 },
    mtf: { overallBias: 'Bullish', timeframeAgreement: 100 },
    atr: { ready: true, atr: 2 },
  };

  const closedTrade = graph.paperTradeEngine.signal(engines, 100, '1h', 'BUY');
  assert.ok(closedTrade);
  assert.equal(graph.paperTradeEngine.evaluateTrades(107).length, 1);
  const openTrade = graph.paperTradeEngine.signal(engines, 100, '1h', 'BUY');
  assert.ok(openTrade);
  assert.equal(graph.paperTradeEngine.open().length, 1);
  assert.equal(graph.paperTradeEngine.history().length, 1);
}

function createRoute(graph) {
  return createRouter({
    apiManager: { isConnected: () => true },
    history: graph.history,
    analyzer: graph.analyzer,
    candleEngine: graph.candleEngine,
    logger: graph.logger,
    config: graph.config,
    eventBus: {},
    cache: { getAge: () => 0 },
    indicatorRegistry: graph.indicatorRegistry,
    structureEngine: graph.structureEngine,
    confluenceEngine: graph.confluenceEngine,
    validationEngine: graph.validationEngine,
    mtfEngine: graph.mtfEngine,
    macdEngine: graph.macdEngine,
    atrEngine: graph.atrEngine,
    bollingerEngine: graph.bollingerEngine,
    paperTradeEngine: graph.paperTradeEngine,
    riskEngine: graph.riskEngine,
    regimeEngine: graph.regimeEngine,
    regimeDecisionEngine: graph.regimeDecisionEngine,
    advanceRiskEngine: graph.advanceRiskEngine,
    mtfConfirmationEngine: graph.mtfConfirmationEngine,
    symbol: SYMBOL,
    getLastDecision: graph.pipeline.getLastDecision,
    getPipelineHealth: graph.pipeline.getPipelineHealth,
  });
}

function dispatch(router, path, query = {}) {
  return new Promise((resolve, reject) => {
    const request = { method: 'GET', url: path, originalUrl: path, path, query, body: {}, headers: {}, ip: '127.0.0.1' };
    const response = {
      statusCode: 200,
      headers: {},
      setHeader(name, value) { this.headers[name] = value; },
      getHeader(name) { return this.headers[name]; },
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ statusCode: this.statusCode, body }); return this; },
      end(body) { resolve({ statusCode: this.statusCode, body }); },
    };
    router.handle(request, response, reject);
  });
}

function captureProductionState(graph) {
  const finalized = getFinalizedCandles(graph.candleEngine, '1h', 500);
  const rsi = graph.indicatorRegistry.get('RSI');
  const ema = graph.indicatorRegistry.get('EMA');
  rsi.calculate(finalized, '1h');
  ema.calculate(finalized, '1h', 20);
  const structureResult = graph.structureEngine.calculate(finalized);
  const regimeResult = graph.regimeEngine.calculate(finalized, '1h');
  const regimeDecisionResult = graph.regimeDecisionEngine.evaluate({
    regime: regimeResult.regime,
    confidence: regimeResult.confidence,
    direction: 'BUY',
    confluenceScore: 80,
  });
  const mtfResult = graph.mtfConfirmationEngine.evaluate({
    direction: 'BUY',
    timeframe: '1h',
    timeframes: bullishTimeframes(),
  });

  return stable({
    analyzer: graph.analyzer.getAnalysis(),
    rsiCache: rsi._cache,
    emaCache: ema._cache,
    structure: {
      result: structureResult,
      metadata: {
        symbol: graph.structureEngine.symbol,
        version: graph.structureEngine.version,
        dataSource: graph.structureEngine.dataSource,
        lastUpdated: graph.structureEngine.lastUpdated,
        calculationTime: graph.structureEngine.calculationTime,
      },
    },
    regime: {
      result: regimeResult,
      metadata: {
        symbol: graph.regimeEngine.symbol,
        version: graph.regimeEngine.version,
        dataSource: graph.regimeEngine.dataSource,
        lastUpdated: graph.regimeEngine.lastUpdated,
        calculationTime: graph.regimeEngine.calculationTime,
      },
      children: {
        trendStrength: stable({ version: graph.regimeEngine.trendStrength.version, dataSource: graph.regimeEngine.trendStrength.dataSource, lastUpdated: graph.regimeEngine.trendStrength.lastUpdated, calculationTime: graph.regimeEngine.trendStrength.calculationTime }),
        rangeDetector: stable({ version: graph.regimeEngine.rangeDetector.version, dataSource: graph.regimeEngine.rangeDetector.dataSource, lastUpdated: graph.regimeEngine.rangeDetector.lastUpdated, calculationTime: graph.regimeEngine.rangeDetector.calculationTime }),
        volatilityClassifier: stable({ version: graph.regimeEngine.volatilityClassifier.version, dataSource: graph.regimeEngine.volatilityClassifier.dataSource, lastUpdated: graph.regimeEngine.volatilityClassifier.lastUpdated, calculationTime: graph.regimeEngine.volatilityClassifier.calculationTime }),
      },
    },
    regimeDecision: {
      result: regimeDecisionResult,
      metadata: { symbol: graph.regimeDecisionEngine.symbol, version: graph.regimeDecisionEngine.version, lastUpdated: graph.regimeDecisionEngine.lastUpdated, calculationTime: graph.regimeDecisionEngine.calculationTime },
    },
    candles: {
      candles: graph.candleEngine.getCandles('1h'),
      active: graph.candleEngine.getActive('1h'),
      total: graph.candleEngine.getTotalCandles(),
    },
    mtf: {
      aggressive: graph.mtfConfirmationEngine._aggressive,
      result: mtfResult,
      symbol: graph.mtfConfirmationEngine.symbol,
      version: graph.mtfConfirmationEngine.version,
    },
    paperTrading: {
      balance: graph.paperTradeEngine.getBalance(),
      open: graph.paperTradeEngine.open(),
      history: graph.paperTradeEngine.history(),
      stats: graph.paperTradeEngine.stats(),
      tradeCounter: graph.paperTradeEngine._tradeCounter,
      lastPrice: graph.paperTradeEngine._lastPrice,
      closedIds: [...graph.paperTradeEngine._closedIds],
    },
  });
}

function pipelineOutcome(decision) {
  return stable({
    confluence: decision.confluence,
    marketRegime: decision.marketRegime,
    regimeDecision: decision.regimeDecision,
    regimeGate: decision.gates.regimeDecision,
    mtfConfirmation: decision.mtfConfirmation,
    mtfGate: decision.gates.mtfConfirmation,
    advancedRisk: decision.risk,
    tradeOpened: decision.verdict.tradeOpened,
    rejectionReason: decision.verdict.rejectionReason,
    trade: decision.verdict.trade ? { ...decision.verdict.trade, tradeId: '<trade>' } : null,
  });
}

function runPipeline(graph, snapshot) {
  const originalLog = console.log;
  console.log = () => {};
  try {
    graph.pipeline.run(snapshot);
  } finally {
    console.log = originalLog;
  }
  return graph.pipeline.getLastDecision();
}

test('validation preserves actual production-like dependency state and route analysis contract', async () => {
  const graph = createProductionGraph();
  seedMarket(graph);
  seedPaperTrading(graph);
  const aggressiveMtfResult = graph.mtfConfirmationEngine.evaluate({ direction: 'BUY', aggressive: true, timeframes: bullishTimeframes() });

  const router = createRoute(graph);
  const analysisBefore = (await dispatch(router, '/analysis')).body;
  const stateBefore = captureProductionState(graph);
  assert.ok(stateBefore.analyzer);
  // Indicator result caching is intentionally disabled; compatibility caches stay empty.
  assert.equal(Object.keys(stateBefore.rsiCache).length, 0);
  assert.equal(Object.keys(stateBefore.emaCache).length, 0);
  assert.equal(stateBefore.structure.result.ready, true);
  assert.ok(stateBefore.regime.result.regime);
  assert.ok(stateBefore.regimeDecision.result.reason);
  assert.ok(stateBefore.candles.candles.length > 0);
  assert.equal(aggressiveMtfResult.aggressive, true);
  assert.equal(stateBefore.mtf.aggressive, false);
  assert.ok(stateBefore.paperTrading.balance > 10000);
  assert.equal(stateBefore.paperTrading.open.length, 1);
  assert.equal(stateBefore.paperTrading.history.length, 1);
  assert.ok(stateBefore.paperTrading.stats.totalTrades > 0);
  const logCountBeforeValidation = graph.logs.length;
  const result = graph.validationEngine.runAll(false);

  assert.equal(result.overall, 'PASS');
  assert.deepEqual(captureProductionState(graph), stateBefore);
  assert.deepEqual(stable((await dispatch(router, '/analysis')).body), stable(analysisBefore));
  assert.equal(graph.logs.length, logCountBeforeValidation);

  const logCountBeforeRoute = graph.logs.length;
  const routeResult = await dispatch(router, '/validation');
  const routeLogs = graph.logs.slice(logCountBeforeRoute);
  assert.equal(routeResult.statusCode, 200);
  assert.equal(routeLogs.length, 1);
  assert.equal(routeLogs[0].level, 'info');
  assert.equal(routeLogs[0].module, 'Validation');
  assert.match(routeLogs[0].message, /^Validation \| overall=PASS \|/);
  assert.equal(routeLogs.some(entry => entry.module === 'MarketAnalyzer'), false);
  assert.equal(routeLogs.some(entry => entry.module === 'Validation' && entry !== routeLogs[0]), false);
});

test('forced validation runs use fresh graphs and remain semantically deterministic', () => {
  const graph = createProductionGraph();
  seedMarket(graph);

  const first = graph.validationEngine.runAll(false);
  const cached = graph.validationEngine.runAll(false);
  const forcedOne = graph.validationEngine.runAll(true);
  const forcedTwo = graph.validationEngine.runAll(true);

  assert.strictEqual(cached, first);
  assert.equal(graph.validationFactoryCalls(), 3);
  assert.deepEqual(stable(forcedOne), stable(forcedTwo));
  assert.equal(forcedOne.overall, 'PASS');
  assert.deepEqual(Object.keys(forcedOne.engines), Object.keys(forcedTwo.engines));
  for (const group of Object.keys(forcedOne.engines)) {
    assert.equal(forcedOne.engines[group].status, forcedTwo.engines[group].status, group);
    assert.deepEqual(stable(forcedOne.details[group]), stable(forcedTwo.details[group]), group);
  }
});

test('queued synchronous validation requests preserve cache semantics and production state', async () => {
  const graph = createProductionGraph();
  seedMarket(graph);
  graph.mtfConfirmationEngine.evaluate({ direction: 'BUY', aggressive: true, timeframes: bullishTimeframes() });
  const router = createRoute(graph);
  const stateBefore = captureProductionState(graph);
  const logCountBefore = graph.logs.length;

  const responses = await Promise.all([
    dispatch(router, '/validation'),
    dispatch(router, '/validation', { rerun: 'true' }),
    dispatch(router, '/validation', { rerun: 'true' }),
    dispatch(router, '/validation'),
  ]);

  assert.deepEqual(responses.map(response => response.statusCode), [200, 200, 200, 200]);
  assert.equal(graph.validationFactoryCalls(), 3);
  assert.strictEqual(responses[2].body, responses[3].body);
  assert.deepEqual(stable(responses[1].body), stable(responses[2].body));
  assert.deepEqual(stable(responses[0].body), stable(responses[1].body));
  assert.deepEqual(captureProductionState(graph), stateBefore);
  const routeLogs = graph.logs.slice(logCountBefore);
  assert.equal(routeLogs.length, 4);
  assert.equal(routeLogs.every(entry => entry.module === 'Validation'), true);
});

test('pipeline decision outcome is unchanged by isolated validation', () => {
  const graph = createProductionGraph();
  seedMarket(graph);
  const snapshot = { symbol: SYMBOL, price: 128, timestamp: '2024-01-01T04:00:00.000Z' };
  const before = pipelineOutcome(runPipeline(graph, snapshot));

  graph.validationEngine.runAll(false);
  graph.clockState.calls = 1;
  const after = pipelineOutcome(runPipeline(graph, snapshot));

  assert.deepEqual(after, before);
});
