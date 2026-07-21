/**
 * Candle Utilities — shared helpers for CandleEngine data access
 *
 * Eliminates duplicated "filter active candle" logic across engines and routes.
 *
 * Version: 1.0.0
 */

/**
 * Get finalized candles for a given timeframe, excluding the active (in-progress) candle.
 *
 * @param {object} candleEngine - CandleEngine instance with getCandles() and getActive()
 * @param {string} tf - Timeframe (e.g. '1h', '5m')
 * @param {number} limit - Max candles to retrieve (default 500)
 * @returns {Array} Finalized candles (active candle excluded when present)
 */
function getFinalizedCandles(candleEngine, tf, limit) {
  const allCandles = candleEngine.getCandles(tf, limit || 500);
  const active = candleEngine.getActive(tf);
  if (active && allCandles.length > 0 &&
      allCandles[allCandles.length - 1].openTime === active.openTime) {
    return allCandles.slice(0, -1);
  }
  return allCandles;
}

module.exports = { getFinalizedCandles };
