'use strict';

function computeRawRsiFromCloses(closes, period) {
  if (!Array.isArray(closes)) {
    throw new TypeError('RSI closes must be an array');
  }
  validatePeriod(period);
  if (closes.length < period + 1) {
    throw new RangeError(`Insufficient close data (${closes.length}/${period + 1})`);
  }

  const deltas = new Array(closes.length - 1);
  for (let index = 1; index < closes.length; index += 1) {
    deltas[index - 1] = closes[index] - closes[index - 1];
  }

  const gains = new Array(deltas.length);
  const losses = new Array(deltas.length);
  for (let index = 0; index < deltas.length; index += 1) {
    gains[index] = deltas[index] > 0 ? deltas[index] : 0;
    losses[index] = deltas[index] < 0 ? -deltas[index] : 0;
  }

  let avgGain = 0;
  let avgLoss = 0;
  for (let index = 0; index < period; index += 1) {
    avgGain += gains[index];
    avgLoss += losses[index];
  }
  avgGain /= period;
  avgLoss /= period;

  for (let index = period; index < gains.length; index += 1) {
    avgGain = (avgGain * (period - 1) + gains[index]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[index]) / period;
  }

  if (avgLoss === 0 && avgGain === 0) return 50;
  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;

  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function validatePeriod(period) {
  if (!Number.isFinite(period) || !Number.isInteger(period) || period <= 0) {
    throw new TypeError('RSI period must be a finite positive integer');
  }
}

module.exports = { computeRawRsiFromCloses };
