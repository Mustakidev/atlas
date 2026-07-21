const test = require('node:test');
const assert = require('node:assert/strict');

const { RSIIndicator } = require('../../src/engine/indicators/rsi');
const { EMAIndicator } = require('../../src/engine/indicators/ema');
const { ATREngine } = require('../../src/engine/atr');
const { MACDEngine } = require('../../src/engine/macd');
const { BollingerEngine } = require('../../src/engine/bollinger');
const { StructureEngine } = require('../../src/engine/structure');
const { RiskEngine } = require('../../src/engine/risk');
const { PaperTradingEngine } = require('../../src/engine/paperTrading');

function logger() {
  return { info() {}, warn() {}, error() {}, system() {} };
}

function candleEngine(candles) {
  return {
    getCandles() { return candles; },
    getActive() { return null; },
  };
}

test('indicator and structure engines return safe not-ready results for missing candle fields', () => {
  const malformed = [{}];
  const engines = [
    [new RSIIndicator('BTCUSDT'), result => result.ready === false && result.value === null],
    [new EMAIndicator('BTCUSDT'), result => result.ready === false && result.value === null],
    [new ATREngine({ candleEngine: candleEngine(malformed), logger: logger() }), result => result.ready === false && result.atr === null],
    [new MACDEngine({ candleEngine: candleEngine(malformed), logger: logger() }), result => result.ready === false && result.macd === null],
    [new BollingerEngine({ candleEngine: candleEngine(malformed), logger: logger() }), result => result.ready === false && result.middleBand === null],
  ];

  for (const [engine, predicate] of engines) {
    const result = engine instanceof RSIIndicator || engine instanceof EMAIndicator
      ? engine.calculate(malformed, 'malformed')
      : engine.calculate('1h', 1);
    assert.equal(predicate(result), true, `${engine.constructor.name} malformed-input contract failed`);
  }

  const structure = new StructureEngine(logger(), 'BTCUSDT').calculate(malformed);
  assert.equal(structure.ready, false);
  assert.equal(structure.structure, null);
});

test('risk and paper trading safely reject missing or invalid inputs', () => {
  const risk = new RiskEngine({ logger: logger(), symbol: 'BTCUSDT' });
  const paper = new PaperTradingEngine({ logger: logger(), symbol: 'BTCUSDT' });

  const riskResult = risk.evaluate({ entryPrice: 0, direction: 'BUY' });
  const paperResult = paper.signal({}, 0, '1h');

  assert.equal(riskResult.tradeAllowed, false);
  assert.ok(riskResult.rejectionReason);
  assert.equal(paperResult, null);
  assert.equal(paper.open().length, 0);
});
