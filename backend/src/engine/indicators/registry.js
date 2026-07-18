/**
 * Indicator Registry
 *
 * Stores indicator instances and provides uniform access.
 * Indicators are registered by name and looked up by name.
 */
class IndicatorRegistry {
  constructor() {
    this._indicators = new Map();
  }

  /**
   * Register an indicator instance.
   * @param {import('./base').Indicator} indicator
   * @returns {this}
   */
  register(indicator) {
    if (!indicator || !indicator.name) {
      throw new Error('Invalid indicator — must have a name property');
    }
    if (this._indicators.has(indicator.name)) {
      throw new Error(`Indicator '${indicator.name}' is already registered`);
    }
    this._indicators.set(indicator.name, indicator);
    return this;
  }

  /** @param {string} name @returns {import('./base').Indicator|null} */
  get(name) {
    return this._indicators.get(name) || null;
  }

  /** @param {string} name @returns {boolean} */
  has(name) {
    return this._indicators.has(name);
  }

  /** @returns {Array<import('./base').Indicator>} */
  getAll() {
    return Array.from(this._indicators.values());
  }

  /** @returns {Array<string>} */
  getNames() {
    return Array.from(this._indicators.keys());
  }

  /** @returns {number} */
  size() {
    return this._indicators.size;
  }

  /**
   * Run a single indicator on candle data.
   * @param {string} name
   * @param {Array} candles
   * @returns {Object} indicator result
   */
  calculate(name, candles) {
    const indicator = this._indicators.get(name);
    if (!indicator) {
      throw new Error(`Indicator '${name}' not found`);
    }
    return indicator.calculate(candles);
  }

  /**
   * Run all registered indicators on candle data.
   * @param {Array} candles
   * @returns {Object} map of indicator name -> { info, result }
   */
  calculateAll(candles) {
    const results = {};
    for (const [name, indicator] of this._indicators) {
      try {
        results[name] = {
          ...indicator.getInfo(),
          result: indicator.calculate(candles),
        };
      } catch (err) {
        results[name] = {
          ...indicator.getInfo(),
          result: {
            value: null,
            signal: 'Error',
            strength: null,
            timestamp: null,
            error: err.message,
          },
        };
      }
    }
    return results;
  }
}

module.exports = { IndicatorRegistry };
