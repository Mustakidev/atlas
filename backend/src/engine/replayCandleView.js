const SECONDARY_TIMEFRAMES = new Set(['1m', '5m', '15m']);
const ALL_TIMEFRAMES = Object.freeze(['1m', '5m', '15m', '1h']);

function assertOwner(owner, name) {
  if (!owner || typeof owner !== 'object' || Array.isArray(owner)) {
    throw new TypeError(`${name} must be a non-null object`);
  }
  for (const method of ['getCandles', 'getActive']) {
    if (typeof owner[method] !== 'function') {
      throw new TypeError(`${name}.${method} must be a function`);
    }
  }
}

function createReplayCandleView({ primaryEngine, secondaryAdapter } = {}) {
  assertOwner(primaryEngine, 'primaryEngine');
  assertOwner(secondaryAdapter, 'secondaryAdapter');

  function getCandles(timeframe, limit) {
    const owner = SECONDARY_TIMEFRAMES.has(timeframe) ? secondaryAdapter : primaryEngine;
    return owner.getCandles(timeframe, limit);
  }

  function getActive(timeframe) {
    const owner = SECONDARY_TIMEFRAMES.has(timeframe) ? secondaryAdapter : primaryEngine;
    return owner.getActive(timeframe);
  }

  function getAllTimeframes() {
    return [...ALL_TIMEFRAMES];
  }

  return Object.freeze({ getCandles, getActive, getAllTimeframes });
}

module.exports = { createReplayCandleView };
