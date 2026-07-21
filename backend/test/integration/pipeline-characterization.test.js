const test = require('node:test');
const assert = require('node:assert/strict');

const { createExecutionPipeline } = require('../../src/core/executionPipeline');
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
  const state = { signals: [], evaluations: 0, closedPnLs: [], candleClosures: 0 };
  const active = overrides.activeCandle ? { ...candles[candles.length - 1], openTime: candles[candles.length - 1].openTime + 3600000 } : null;
  const deps = {
    config: config(),
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
      evaluate: () => ({ tradeAllowed: true, positionSize: 1, stopLoss: 96, takeProfit: 112, riskReward: 3, session: 'ASIAN' }),
      onTradeClosed: pnl => state.closedPnLs.push(pnl),
    },
    mtfEngine: { calculate: () => ({ overallBias: 'Bullish' }) },
    paperTradeEngine: {
      signal: (engines, price, timeframe, direction) => {
        const trade = { tradeId: `T-${state.signals.length + 1}`, direction, entryPrice: price, stopLoss: 96, takeProfit: 112, riskReward: 3, positionSize: 1, confidence: 80, reason: 'Accepted' };
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

test('preserves neutral rejection and gate fields', () => {
  const harness = createHarness({ confluenceEngine: { calculate: () => ({ score: 50, bias: 'Neutral', confidence: 50, components: {}, missing: [] }) } });
  const decision = run(harness);

  assert.equal(decision.verdict.rejectionReason, 'Confluence bias: Score 50 is between thresholds (35-65)');
  assert.deepEqual(decision.gates.confluenceBias, { pass: false, value: 'Neutral', detail: 'Score 50 is between thresholds (35-65)' });
  assert.equal(decision.gates.mtfConfirmation.detail, 'Skipped (no direction)');
  assert.equal(decision.gates.advanceRisk.detail, 'Skipped (confluence is Neutral)');
});

test('preserves regime, MTF, advance-risk, and paper-trade rejection order', () => {
  const regime = createHarness({ regimeDecisionEngine: { evaluate: () => ({ allowTrade: false, reason: 'Wrong regime' }) } });
  assert.equal(run(regime).verdict.rejectionReason, 'Regime Decision: Wrong regime');

  const mtf = createHarness({ mtfConfirmationEngine: { evaluate: () => ({ mtfAllowed: false, rejectionReason: '1h disagrees', confidence: 20, alignmentScore: 25 }) } });
  assert.equal(run(mtf).verdict.rejectionReason, '1h disagrees');

  const risk = createHarness({ advanceRiskEngine: { evaluate: () => ({ tradeAllowed: false, rejectionReason: 'Daily limit reached' }), onTradeClosed() {} } });
  assert.equal(run(risk).verdict.rejectionReason, 'AdvanceRisk: Daily limit reached');

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
