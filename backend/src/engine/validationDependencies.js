const { MarketAnalyzer } = require('./analyzer');
const { createIndicatorRegistry } = require('./indicators');
const { StructureEngine } = require('./structure');
const { ATREngine } = require('./atr');
const { PaperTradingEngine } = require('./paperTrading');
const { RegimeEngine } = require('../market-regime/RegimeEngine');
const { RegimeDecisionEngine } = require('../market-regime/RegimeDecisionEngine');
const { AdvanceRiskEngine } = require('./advanceRisk');
const { MTFConfirmationEngine } = require('./mtfConfirmation');

const TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '4h', '12h', '24h'];

function createValidationLogger() {
  return {
    info() {},
    warn() {},
    error() {},
    system() {},
  };
}

function createValidationCandleProvider() {
  const candlesByTimeframe = new Map();

  return {
    setValidationCandles(timeframe, candles) {
      candlesByTimeframe.set(timeframe.toLowerCase(), candles.map(candle => ({ ...candle })));
    },

    getCandles(timeframe, limit) {
      const candles = candlesByTimeframe.get(timeframe.toLowerCase()) || [];
      const selected = limit && limit > 0 ? candles.slice(-limit) : candles;
      return selected.map(candle => ({ ...candle }));
    },

    getActive() {
      return null;
    },

    getAllTimeframes() {
      return [...TIMEFRAMES];
    },
  };
}

function createValidationDependencies({ config, symbol }) {
  const logger = createValidationLogger();
  const candleEngine = createValidationCandleProvider();
  const indicatorRegistry = createIndicatorRegistry(symbol);
  const analyzer = new MarketAnalyzer(logger, symbol);
  const structureEngine = new StructureEngine(logger, symbol);
  const atrEngine = new ATREngine({ candleEngine, logger, symbol });
  const regimeEngine = new RegimeEngine({
    indicatorRegistry,
    atrEngine,
    candleEngine,
    analyzer,
    logger,
    config,
    symbol,
  });
  const regimeDecisionEngine = new RegimeDecisionEngine({ logger, symbol });
  const paperTradeEngine = new PaperTradingEngine({ logger, symbol });
  const advanceRiskEngine = new AdvanceRiskEngine({ logger, symbol, paperTradeEngine, config });
  const mtfConfirmationEngine = new MTFConfirmationEngine({ logger, symbol, config });

  return {
    analyzer,
    indicatorRegistry,
    structureEngine,
    candleEngine,
    regimeEngine,
    regimeDecisionEngine,
    advanceRiskEngine,
    mtfConfirmationEngine,
    logger,
    symbol,
  };
}

module.exports = { createValidationDependencies, createValidationCandleProvider };
