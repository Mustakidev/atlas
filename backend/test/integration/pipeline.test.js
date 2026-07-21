const test = require('node:test');
const assert = require('node:assert/strict');

const { CandleEngine } = require('../../src/engine/candles');
const { getFinalizedCandles } = require('../../src/engine/candleUtils');
const { RSIIndicator } = require('../../src/engine/indicators/rsi');
const { EMAIndicator } = require('../../src/engine/indicators/ema');
const { ATREngine } = require('../../src/engine/atr');
const { MACDEngine } = require('../../src/engine/macd');
const { BollingerEngine } = require('../../src/engine/bollinger');
const { StructureEngine } = require('../../src/engine/structure');
const { RiskEngine } = require('../../src/engine/risk');
const { AdvanceRiskEngine } = require('../../src/engine/advanceRisk');
const { PaperTradingEngine } = require('../../src/engine/paperTrading');
const { IndicatorRegistry } = require('../../src/engine/indicators/registry');
const { bullishCandles, rangingCandles } = require('../fixtures/market');
const { fresh } = require('../helpers/fixtures');

function logger() {
  return { info() {}, warn() {}, error() {}, system() {} };
}

function config() {
  return { get(key) { return key === 'MAX_HISTORY' ? 500 : undefined; } };
}

function ingestCandles(candleEngine, candles) {
  for (const candle of candles) {
    candleEngine.ingest({
      symbol: 'BTCUSDT',
      price: candle.close,
      volume: candle.volume,
      timestamp: candle.timestamp,
    });
  }
}

function buildPipeline(candles) {
  const candleEngine = new CandleEngine(config(), logger(), 'BTCUSDT');
  ingestCandles(candleEngine, candles);
  const finalized = getFinalizedCandles(candleEngine, '1h', 500);
  const registry = new IndicatorRegistry();
  registry.register(new RSIIndicator('BTCUSDT'));
  registry.register(new EMAIndicator('BTCUSDT'));
  const engines = {
    candleEngine,
    finalized,
    registry,
    structure: new StructureEngine(logger(), 'BTCUSDT'),
    atr: new ATREngine({ candleEngine, logger: logger(), symbol: 'BTCUSDT' }),
    macd: new MACDEngine({ candleEngine, logger: logger(), symbol: 'BTCUSDT' }),
    bollinger: new BollingerEngine({ candleEngine, logger: logger(), symbol: 'BTCUSDT' }),
    paper: new PaperTradingEngine({ logger: logger(), symbol: 'BTCUSDT' }),
    risk: new RiskEngine({ logger: logger(), symbol: 'BTCUSDT' }),
    advanceRisk: new AdvanceRiskEngine({ logger: logger(), symbol: 'BTCUSDT', paperTradeEngine: null, config: {} }),
  };
  return engines;
}

test('market snapshots create finalized candles before engine calculations', () => {
  const pipeline = buildPipeline(fresh(bullishCandles, 40));

  assert.equal(pipeline.finalized.length, 39);
  assert.equal(pipeline.finalized[0].openTime, fresh(bullishCandles, 1)[0].openTime);
  assert.equal(pipeline.registry.get('RSI').calculate(pipeline.finalized, '1h').ready, true);
  assert.equal(pipeline.registry.get('EMA').calculate(pipeline.finalized, '1h', 20).ready, true);
  assert.equal(pipeline.structure.calculate(pipeline.finalized).ready, true);
  assert.equal(pipeline.atr.calculate('1h', 500).ready, true);
  assert.equal(pipeline.macd.calculate('1h', 500).ready, true);
  assert.equal(pipeline.bollinger.calculate('1h', 500).ready, true);
});

test('neutral signal path creates no paper trade', () => {
  const pipeline = buildPipeline(fresh(rangingCandles, 40));
  const trade = pipeline.paper.signal({}, 100, '1h');

  assert.equal(trade, null);
  assert.equal(pipeline.paper.open().length, 0);
});

test('approved BUY and SELL paths can create deterministic paper trades', () => {
  const buyPipeline = buildPipeline(fresh(bullishCandles, 40));
  const sellPipeline = buildPipeline(fresh(bullishCandles, 40));
  const engines = { atr: { ready: true, atr: 2 }, bollinger: { ready: false } };

  const buy = buyPipeline.paper.signal(engines, 100, '1h', 'BUY');
  const sell = sellPipeline.paper.signal(engines, 100, '1h', 'SELL');

  assert.equal(buy.direction, 'BUY');
  assert.equal(sell.direction, 'SELL');
  assert.equal(buyPipeline.paper.open().length, 1);
  assert.equal(sellPipeline.paper.open().length, 1);
});

test('rejected risk path prevents paper trade creation', () => {
  const pipeline = buildPipeline(fresh(bullishCandles, 40));
  const risk = pipeline.risk.evaluate({
    symbol: 'BTCUSDT', timeframe: '1h', entryPrice: 100, direction: 'BUY',
    atr: { ready: false, atr: null }, confluence: { confidence: 80 },
  });

  assert.equal(risk.tradeAllowed, false);
  assert.ok(risk.rejectionReason);
  assert.equal(pipeline.paper.open().length, 0);
});

test('one indicator failure is isolated into an error result', () => {
  const registry = new IndicatorRegistry();
  registry.register({
    name: 'Broken',
    getInfo: () => ({ name: 'Broken', implemented: true }),
    calculate: () => { throw new Error('deterministic engine failure'); },
  });

  const result = registry.calculateAll([{ close: 100 }]);

  assert.equal(result.Broken.result.signal, 'Error');
  assert.equal(result.Broken.result.error, 'deterministic engine failure');
});
