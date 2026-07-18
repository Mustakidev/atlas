/**
 * Indicator Engine — barrel export
 *
 * Creates a pre-populated IndicatorRegistry with all built-in indicators.
 * Import this single file to get the full indicator system.
 *
 * Usage:
 *   const { createIndicatorRegistry } = require('./engine/indicators');
 *   const registry = createIndicatorRegistry();
 *   const results = registry.calculateAll(candles);
 */
const { IndicatorRegistry } = require('./registry');
const { RSIIndicator } = require('./rsi');
const { EMAIndicator } = require('./ema');
const { SMAIndicator } = require('./sma');
const { MACDIndicator } = require('./macd');
const { ATRIndicator } = require('./atr');
const { VWAPIndicator } = require('./vwap');
const { BollingerIndicator } = require('./bollinger');

function createIndicatorRegistry(symbol) {
  const registry = new IndicatorRegistry();

  registry.register(new RSIIndicator(symbol));
  registry.register(new EMAIndicator(symbol));
  registry.register(new SMAIndicator(symbol));
  registry.register(new MACDIndicator(symbol));
  registry.register(new ATRIndicator(symbol));
  registry.register(new VWAPIndicator(symbol));
  registry.register(new BollingerIndicator(symbol));

  return registry;
}

module.exports = { createIndicatorRegistry, IndicatorRegistry };
