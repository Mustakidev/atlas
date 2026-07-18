const { Indicator } = require('./base');

const DEFAULT_SYMBOL = 'BTCUSDT';

class ATRIndicator extends Indicator {
  constructor(symbol) {
    super('ATR', 'Average True Range — volatility measure averaging true range over a period');
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

module.exports = { ATRIndicator };
