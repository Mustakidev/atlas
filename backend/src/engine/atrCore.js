'use strict';

function computeRawAtr(candles, period) {
  if (!Array.isArray(candles)) {
    throw new TypeError('ATR candles must be an array');
  }
  validatePeriod(period);
  if (candles.length < period + 1) {
    throw new RangeError(`Insufficient candle data (${candles.length}/${period + 1})`);
  }

  const trValues = new Array(candles.length);
  trValues[0] = candles[0].high - candles[0].low;

  for (let index = 1; index < candles.length; index += 1) {
    const highLow = candles[index].high - candles[index].low;
    const highPrevClose = Math.abs(candles[index].high - candles[index - 1].close);
    const lowPrevClose = Math.abs(candles[index].low - candles[index - 1].close);
    trValues[index] = Math.max(highLow, highPrevClose, lowPrevClose);
  }

  const atr = calculateWilderAtr(trValues, period);
  const previousAtr = calculateWilderAtr(trValues.slice(0, -1), period);
  const latestClose = candles[candles.length - 1].close;
  const atrPercent = latestClose > 0 ? (atr / latestClose) * 100 : 0;

  return { atr, atrPercent, previousAtr };
}

function calculateWilderAtr(trValues, period) {
  if (trValues.length < period) return 0;

  let atrSum = 0;
  for (let index = 0; index < period; index += 1) {
    atrSum += trValues[index];
  }
  let atr = atrSum / period;

  for (let index = period; index < trValues.length; index += 1) {
    atr = (atr * (period - 1) + trValues[index]) / period;
  }

  return atr;
}

function validatePeriod(period) {
  if (!Number.isFinite(period) || !Number.isInteger(period) || period <= 0) {
    throw new TypeError('ATR period must be a finite positive integer');
  }
}

module.exports = { computeRawAtr };
