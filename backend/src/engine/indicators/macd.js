const { Indicator } = require('./base');

const DEFAULT_SYMBOL = 'BTCUSDT';

class MACDIndicator extends Indicator {
  constructor(symbol) {
    super('MACD', 'Moving Average Convergence Divergence — trend-following momentum indicator');
    this._implemented = false;
    this._symbol = symbol || DEFAULT_SYMBOL;
  }

  calculate(candles) {
    if (!candles || candles.length === 0) {
      return { value: null, signal: 'No Data', strength: null, timestamp: null };
    }
    return {
      value: null,
      signal: 'Not Implemented',
      strength: null,
      timestamp: candles[candles.length - 1].openTime,
    };
  }
}

module.exports = { MACDIndicator };
