/**
 * Base Indicator
 *
 * Abstract base class for all Atlas indicators.
 * Every indicator must extend this class and implement calculate(candles).
 *
 * @interface
 *   calculate(candles: Array<Object>) => {
 *     value: number|null,
 *     signal: string,
 *     strength: number|null,
 *     timestamp: number|null,
 *   }
 */
class Indicator {
  constructor(name, description) {
    if (new.target === Indicator) {
      throw new Error('Indicator is abstract — instantiate a subclass');
    }
    this.name = name;
    this.description = description;
  }

  /**
   * Compute the indicator from candle history.
   * @param {Array} candles - OHLCV candle array (ascending time order)
   * @returns {{ value: *, signal: string, strength: *, timestamp: * }}
   */
  calculate(candles) {
    throw new Error(`Indicator '${this.name}' must implement calculate()`);
  }

  /** Return metadata about this indicator. */
  getInfo() {
    return {
      name: this.name,
      description: this.description,
      implemented: typeof this._implemented === 'boolean' ? this._implemented : false,
    };
  }
}

module.exports = { Indicator };
