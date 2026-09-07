const test = require('node:test');
const assert = require('node:assert/strict');

const { createExecutionPipeline } = require('../../src/core/executionPipeline');
const { ConfluenceEngine } = require('../../src/engine/confluence');
const { AdvanceRiskEngine } = require('../../src/engine/advanceRisk');
const { bullishCandles } = require('../fixtures/market');
const { fresh } = require('../helpers/fixtures');

const FIXED_ISO = '2024-01-01T00:00:00.000Z';
const FIXED_NOW = Date.parse(FIXED_ISO);

function logger(errors = []) {
  return {
    info() {},
    warn() {},
    error(module, message, data) { errors.push({ module, message, data }); },
  };
}

function config() {
  return { get(key) {
    if (key === 'CONFLUENCE_BULLISH_THRESHOLD') return 65;
    if (key === 'CONFLUENCE_BEARISH_THRESHOLD') return 35;
    return undefined;
  } };
}

function createHarness(overrides = {}) {
  const candles = fresh(bullishCandles, 40);
  const errors = [];
  const state = { signals: [], executionPlans: [], evaluations: 0, closedPnLs: [], candleClosures: 0 };
  const active = overrides.activeCandle ? { ...candles[candles.length - 1], openTime: candles[candles.length - 1].openTime + 3600000 } : null;
  const deps = {
    config: overrides.config || config(),
    logger: logger(errors),
    symbol: 'BTCUSDT',
    clock: { now: () => FIXED_NOW, isoNow: () => FIXED_ISO, localeTime: () => '12:00:00 AM' },
    candleEngine: {
      getCandles: () => active ? [...fresh(() => candles), active] : fresh(() => candles),
      getActive: () => active,
    },
    regimeEngine: { calculate: () => ({ regime: 'TRENDING_BULL', confidence: 80, trendScore: 80, rangeScore: 20, volatility: 'Low', decisionReason: 'Trend' }) },
    confluenceEngine: { calculate: () => ({ score: 80, bias: 'Bullish', confidence: 80, components: {} }) },
    atrEngine: { calculate: () => ({ ready: true, atr: 2, atrPercentage: 1, volatilityLevel: 'Low', volatilityTrend: 'Stable' }) },
    analyzer: { getAnalysis: () => ({ trend: { '1H': 'Bullish' } }) },
    structureEngine: { calculate: () => ({ ready: true, direction: 'bullish', score: 80, structure: 'Bullish' }) },
    indicatorRegistry: { get(name) { return { calculate: () => name === 'RSI' ? { ready: true, value: 70, state: 'Overbought' } : { ready: true, value: 110, trend: 'Above' } }; } },
    macdEngine: { calculate: () => ({ ready: true, macd: 1, signal: 0, histogram: 1, trend: 'Bullish' }) },
    bollingerEngine: { calculate: () => ({ ready: true, middleBand: 100, upperBand: 110, lowerBand: 90, pricePosition: 'Inside Bands', squeeze: false }) },
    regimeDecisionEngine: { evaluate: () => ({ allowTrade: true, preferredDirection: 'BUY', penalty: 0, reason: 'Allowed' }) },
    mtfConfirmationEngine: { evaluate: () => ({ mtfAllowed: true, rejectionReason: null, confidence: 80, alignmentScore: 100 }) },
    advanceRiskEngine: {
      evaluate: ({ direction }) => ({
        tradeAllowed: true,
        positionSize: 1,
        stopLoss: direction === 'BUY' ? 96 : 104,
        takeProfit: direction === 'BUY' ? 112 : 88,
        riskReward: 3,
        session: 'ASIAN',
      }),
      onTradeClosed: pnl => state.closedPnLs.push(pnl),
    },
    mtfEngine: { calculate: () => ({ overallBias: 'Bullish' }) },
    paperTradeEngine: {
      signal: (engines, price, timeframe, direction, executionPlan) => {
        state.executionPlans.push(executionPlan);
        const trade = { tradeId: `T-${state.signals.length + 1}`, direction, entryPrice: price, stopLoss: executionPlan?.stopLoss ?? 96, takeProfit: executionPlan?.takeProfit ?? 112, riskReward: executionPlan?.riskReward ?? 3, positionSize: executionPlan?.positionSize ?? 1, confidence: 80, reason: 'Accepted' };
        state.signals.push(trade);
        return trade;
      },
      evaluateTrades: () => { state.evaluations++; return overrides.closedTrades || []; },
      onCandle: () => { state.candleClosures++; return overrides.candleClosed || { closed: [] }; },
      open: () => [],
      closed: () => [],
      getBalance: () => 10000,
    },
  };
  const pipeline = createExecutionPipeline({ ...deps, ...overrides, logger: deps.logger, clock: deps.clock });
  return { pipeline, state, errors, candles };
}

test('preserves a valid zero bearish threshold in the execution decision', () => {
  const harness = createHarness({
    config: {
      get(key) {
        if (key === 'CONFLUENCE_BULLISH_THRESHOLD') return 65;
        if (key === 'CONFLUENCE_BEARISH_THRESHOLD') return 0;
        return undefined;
      },
    },
  });

  const decision = run(harness);
  assert.deepEqual(decision.thresholds, { bullish: 65, bearish: 0 });
});

function run(harness, price = 100) {
  const originalLog = console.log;
  console.log = () => {};
  try {
    harness.pipeline.run({ symbol: 'BTCUSDT', price, timestamp: FIXED_ISO });
  } finally {
    console.log = originalLog;
  }
  return harness.pipeline.getLastDecision();
}

function malformedConfluenceEngine() {
  const engine = new ConfluenceEngine({
    analyzer: { getAnalysis: () => null },
    indicatorRegistry: { get: () => null },
    structureEngine: { calculate: () => ({ ready: false, reason: 'not ready' }) },
    candleEngine: null,
    logger: logger(),
    config: config(),
    symbol: 'BTCUSDT',
  });

  engine.clearComponents();
  engine.registerComponent('malformed', {
    weight: 1,
    calculate: () => ({ score: NaN, direction: 'bullish', available: true, confidence: 80 }),
  });
  return engine;
}

test('preserves BUY and SELL execution decision fields', () => {
  const buy = createHarness();
  const buyDecision = run(buy);
  assert.deepEqual(buyDecision.verdict.trade, {
    tradeId: 'T-1', direction: 'BUY', entryPrice: 100, stopLoss: 96, takeProfit: 112,
    riskReward: 3, positionSize: 1, confidence: 80, reason: 'Accepted',
  });

  const sell = createHarness({ confluenceEngine: { calculate: () => ({ score: 20, bias: 'Bearish', confidence: 80, components: {} }) } });
  const sellDecision = run(sell);
  assert.equal(sellDecision.verdict.tradeOpened, true);
  assert.equal(sellDecision.verdict.trade.direction, 'SELL');
});

test('passes the approved AdvanceRisk execution plan to the opened trade', () => {
  const plan = { tradeAllowed: true, positionSize: 33.33, stopLoss: 97, takeProfit: 105.4, riskReward: 1.8, session: 'ASIAN' };
  const harness = createHarness({
    advanceRiskEngine: {
      evaluate: () => plan,
      onTradeClosed() {},
    },
  });

  const decision = run(harness);

  assert.equal(harness.state.executionPlans.length, 1);
  assert.strictEqual(harness.state.executionPlans[0], plan);
  assert.deepEqual({
    stopLoss: decision.risk.stopLoss,
    takeProfit: decision.risk.takeProfit,
    riskReward: decision.risk.riskReward,
    positionSize: decision.risk.positionSize,
  }, {
    stopLoss: decision.verdict.trade.stopLoss,
    takeProfit: decision.verdict.trade.takeProfit,
    riskReward: decision.verdict.trade.riskReward,
    positionSize: decision.verdict.trade.positionSize,
  });
});

test('preserves neutral rejection and gate fields', () => {
  const harness = createHarness({ confluenceEngine: { calculate: () => ({ score: 50, bias: 'Neutral', confidence: 50, components: {}, missing: [] }) } });
  const decision = run(harness);

  assert.equal(decision.verdict.rejectionReason, 'Confluence bias: Score 50 is between thresholds (35-65)');
  assert.deepEqual(decision.gates.confluenceBias, { pass: false, value: 'Neutral', detail: 'Score 50 is between thresholds (35-65)' });
  assert.equal(decision.gates.mtfConfirmation.detail, 'Skipped (no direction)');
  assert.equal(decision.gates.advanceRisk.detail, 'Skipped (confluence is Neutral)');
});

test('malformed Confluence scores cannot open a paper trade', () => {
  const harness = createHarness({ confluenceEngine: malformedConfluenceEngine() });
  const decision = run(harness);

  assert.deepEqual(decision.confluence, {
    score: null,
    bias: 'Neutral',
    confidence: 0,
    components: {
      malformed: {
        score: null,
        direction: 'bullish',
        weight: 1,
        available: false,
        confidence: 80,
        reason: null,
      },
    },
  });
  assert.equal(decision.verdict.tradeOpened, false);
  assert.equal(harness.state.signals.length, 0);
  assert.match(decision.verdict.rejectionReason, /^Confluence bias:/);
});

test('preserves regime, MTF, advance-risk, and paper-trade rejection order', () => {
  const regime = createHarness({ regimeDecisionEngine: { evaluate: () => ({ allowTrade: false, reason: 'Wrong regime' }) } });
  assert.equal(run(regime).verdict.rejectionReason, 'Regime Decision: Wrong regime');

  const mtf = createHarness({ mtfConfirmationEngine: { evaluate: () => ({ mtfAllowed: false, rejectionReason: '1h disagrees', confidence: 20, alignmentScore: 25 }) } });
  assert.equal(run(mtf).verdict.rejectionReason, '1h disagrees');

  const risk = createHarness({ advanceRiskEngine: { evaluate: () => ({ tradeAllowed: false, rejectionReason: 'Daily limit reached' }), onTradeClosed() {} } });
  assert.equal(run(risk).verdict.rejectionReason, 'AdvanceRisk: Daily limit reached');
  assert.equal(risk.state.signals.length, 0);

  const paper = createHarness({ paperTradeEngine: { signal: () => null, evaluateTrades: () => [], onCandle: () => ({ closed: [] }), open: () => [], closed: () => [], getBalance: () => 10000 } });
  assert.equal(run(paper).verdict.rejectionReason, 'paperTradeEngine.signal() rejected — internal analysis: direction neutral or confidence < 30%');
});

test('preserves signal cooldown semantics', () => {
  const harness = createHarness();
  assert.equal(run(harness).verdict.tradeOpened, true);
  const second = run(harness);

  assert.equal(second.verdict.rejectionReason, 'Cooldown active — 60s remaining (min 60s between trades)');
  assert.equal(harness.state.signals.length, 1);
});

test('isolates engine exceptions and updates exact pipeline health state', () => {
  const harness = createHarness({ confluenceEngine: { calculate: () => { throw new Error('confluence failed'); } } });
  const decision = run(harness);
  const health = harness.pipeline.getPipelineHealth();

  assert.equal(decision.verdict.rejectionReason, 'Confluence bias: Score 50 is between thresholds (35-65)');
  assert.deepEqual(health, {
    pipelineCycleCount: 1,
    pipelineErrors: 1,
    lastPipelineError: { engine: 'ConfluenceEngine', timestamp: FIXED_ISO, error: 'confluence failed' },
    lastSuccessfulCycle: FIXED_ISO,
    riskSyncFailure: false,
    lastRunStatus: { status: 'COMPLETED', failure: null },
  });
  assert.deepEqual(harness.errors, [{ module: 'Pipeline', message: 'Engine failure: ConfluenceEngine', data: { error: 'confluence failed' } }]);
});

test('preserves successful-cycle state, close notifications, and active-candle handling', () => {
  const harness = createHarness({
    activeCandle: true,
    closedTrades: [{ tradeId: 'closed-1', pnl: 12, exitReason: 'Take Profit', entryPrice: 100, exitPrice: 112, pnlPercent: 12 }],
    candleClosed: { closed: [{ tradeId: 'closed-2', pnl: -4, exitReason: 'Stop Loss', pnlPercent: -4 }] },
  });
  const decision = run(harness);
  const health = harness.pipeline.getPipelineHealth();

  assert.equal(decision.timestamp, FIXED_ISO);
  assert.equal(health.lastSuccessfulCycle, FIXED_ISO);
  assert.equal(harness.state.evaluations, 1);
  assert.equal(harness.state.candleClosures, 1);
  assert.deepEqual(harness.state.closedPnLs, [12, -4]);
});

test('blocks unknown regime output without opening a trade', () => {
  for (const regime of ['UNKNOWN', '', 'UNSUPPORTED']) {
    const harness = createHarness({
      regimeEngine: { calculate: () => ({ regime, confidence: 0 }) },
    });

    const decision = run(harness);

    assert.equal(decision.verdict.tradeOpened, false);
    assert.equal(decision.verdict.rejectionReason, regime === 'UNKNOWN' ? 'REGIME_UNKNOWN' : 'REGIME_INVALID');
    assert.equal(harness.state.signals.length, 0);
  }
});

test('turns regime engine exceptions into a terminal fail-closed cycle', () => {
  const harness = createHarness({
    regimeEngine: { calculate: () => { throw new Error('regime unavailable'); } },
  });

  const decision = run(harness);

  assert.equal(decision.verdict.tradeOpened, false);
  assert.equal(decision.verdict.rejectionReason, 'REGIME_ENGINE_FAILURE');
  assert.equal(harness.pipeline.getLastRunStatus().status, 'FAILED');
  assert.equal(harness.state.signals.length, 0);
});

test('rejects malformed approved risk plans before PaperTrading admission', () => {
  const harness = createHarness({
    advanceRiskEngine: {
      evaluate: () => ({ tradeAllowed: true, positionSize: 1, stopLoss: 101, takeProfit: 102, riskReward: 3 }),
      onTradeClosed() {},
    },
  });

  const decision = run(harness);

  assert.equal(decision.verdict.tradeOpened, false);
  assert.equal(decision.verdict.rejectionReason, 'RISK_INVALID');
  assert.equal(harness.state.signals.length, 0);
});

test('rejects missing and non-finite approved risk outputs before admission', () => {
  const plans = [
    undefined,
    { tradeAllowed: true, positionSize: 1, stopLoss: NaN, takeProfit: 102, riskReward: 3 },
    { tradeAllowed: true, positionSize: 1, stopLoss: 99, takeProfit: Infinity, riskReward: 3 },
    { tradeAllowed: true, positionSize: 1, stopLoss: 99, takeProfit: 102, riskReward: -Infinity },
  ];

  for (const plan of plans) {
    const harness = createHarness({
      advanceRiskEngine: { evaluate: () => plan, onTradeClosed() {} },
    });
    const decision = run(harness);

    assert.equal(decision.verdict.rejectionReason, 'RISK_INVALID');
    assert.equal(harness.state.signals.length, 0);
  }
});

test('turns an AdvanceRisk exception into a terminal no-trade cycle', () => {
  const harness = createHarness({
    advanceRiskEngine: {
      evaluate: () => { throw new Error('risk unavailable'); },
      onTradeClosed() {},
    },
  });

  const decision = run(harness);

  assert.equal(decision.verdict.rejectionReason, 'RISK_ENGINE_FAILURE');
  assert.equal(harness.pipeline.getLastRunStatus().status, 'FAILED');
  assert.equal(harness.state.signals.length, 0);
});

test('blocks signal creation when risk state synchronization fails', () => {
  const harness = createHarness({
    closedTrades: [{ tradeId: 'closed-1', pnl: 12, exitReason: 'Take Profit' }],
    advanceRiskEngine: {
      evaluate: () => ({ tradeAllowed: true, positionSize: 1, stopLoss: 96, takeProfit: 112, riskReward: 3 }),
      onTradeClosed: () => { throw new Error('risk state unavailable'); },
    },
  });

  const decision = run(harness);

  assert.equal(decision.verdict.tradeOpened, false);
  assert.equal(decision.verdict.rejectionReason, 'RISK_STATE_SYNC_FAILURE');
  assert.equal(harness.pipeline.getLastRunStatus().status, 'FAILED');
  assert.equal(harness.state.signals.length, 0);
});

test('malformed lifecycle closure PnL fails closed and blocks later cycles', () => {
  const authority = new AdvanceRiskEngine({
    logger: logger(),
    symbol: 'BTCUSDT',
    paperTradeEngine: null,
    config: {},
    clock: { now: () => FIXED_NOW },
  });
  const harness = createHarness({
    closedTrades: [{ tradeId: 'PT-X', pnl: NaN }],
    advanceRiskEngine: authority,
  });

  const firstDecision = run(harness);
  const laterDecision = run(harness, 101);

  assert.equal(firstDecision.verdict.tradeOpened, false);
  assert.equal(firstDecision.verdict.rejectionReason, 'RISK_STATE_SYNC_FAILURE');
  assert.equal(harness.pipeline.getLastRunStatus().status, 'FAILED');
  assert.equal(authority.isRiskStateHealthy(), false);
  assert.equal(harness.state.signals.length, 0);
  assert.equal(laterDecision.verdict.rejectionReason, 'RISK_STATE_SYNC_FAILURE');
  assert.equal(harness.state.signals.length, 0);
});

test('fails closed when lifecycle processing throws before signal evaluation', () => {
  const harness = createHarness({
    activeCandle: true,
    paperTradeEngine: {
      evaluateTrades: () => { throw new Error('lifecycle unavailable'); },
      onCandle: () => ({ closed: [] }),
      signal: () => { throw new Error('signal must not be called'); },
      open: () => [],
      closed: () => [],
      getBalance: () => 10000,
    },
  });

  const decision = run(harness);

  assert.equal(decision.verdict.tradeOpened, false);
  assert.equal(decision.verdict.rejectionReason, 'LIFECYCLE_ENGINE_FAILURE');
  assert.equal(harness.pipeline.getLastRunStatus().status, 'FAILED');
});

test('pipeline rejects admission when it reuses an untrusted AdvanceRisk authority', () => {
  const authority = new AdvanceRiskEngine({
    logger: { info() { throw new Error('risk notification failed'); }, warn() {}, error() {} },
    symbol: 'BTCUSDT',
    paperTradeEngine: null,
    config: {},
    clock: { nowMs: () => FIXED_NOW, monotonicMs: () => 0 },
  });
  authority.setMaxConsecutiveLosses(1);
  assert.throws(() => authority.onTradeClosed(-100), /risk notification failed/);

  const harness = createHarness({
    advanceRiskEngine: {
      evaluate: params => authority.evaluate(params),
      onTradeClosed: (pnl, context) => authority.onTradeClosed(pnl, context),
    },
  });

  const decision = run(harness);

  assert.equal(decision.verdict.tradeOpened, false);
  assert.equal(decision.verdict.rejectionReason, 'RISK_STATE_UNHEALTHY');
  assert.equal(harness.state.signals.length, 0);
});
