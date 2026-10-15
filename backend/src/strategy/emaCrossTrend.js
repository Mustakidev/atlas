'use strict';

// EMA-cross trend strategy, validated in research/ (`npm run research`).
//
// Rules, evaluated only on CLOSED candles of the strategy timeframe:
//   - Trend is UP while EMA(fast) > EMA(slow), DOWN otherwise.
//   - When the trend flips on a candle close, that candle is the signal. Entry is
//     the next candle's open, in the new trend direction.
//   - Protective stop: signal close -/+ atrMult x ATR(atrPeriod), fixed for the trade.
//   - The trade ends at the next opposite flip (reverse) or when the stop is hit.
//     After a stop-out the strategy stays flat until the next flip.
// The research backtester builds its signals from emaCrossSeries() so the
// dashboard and the backtest cannot drift apart.
const { ema, atr } = require('./indicators');

const STRATEGY_ID = 'ema-cross-4h';
const EMA_CROSS_DEFAULTS = Object.freeze({ timeframe: '4h', fast: 20, slow: 100, atrPeriod: 20, atrMult: 3 });
const TIMEFRAME_MS = Object.freeze({ '1h': 3_600_000, '4h': 14_400_000, '12h': 43_200_000, '24h': 86_400_000 });

function emaCrossSeries(candles, params = EMA_CROSS_DEFAULTS) {
  const closes = candles.map(c => c.close);
  const fast = ema(closes, params.fast);
  const slow = ema(closes, params.slow);
  const atrValues = atr(candles, params.atrPeriod);
  const side = closes.map((_, i) => {
    if (Number.isNaN(slow[i])) return 0;
    return fast[i] > slow[i] ? 1 : -1;
  });
  return { fast, slow, atr: atrValues, side };
}

// Direction (+1/-1) of a trend flip confirmed at the close of candle i, or 0.
function crossAt(series, i) {
  if (i < 1 || series.side[i - 1] === 0 || series.side[i] === series.side[i - 1]) return 0;
  return series.atr[i] > 0 ? series.side[i] : 0;
}

function stopFor(series, candles, i, dir, params) {
  return candles[i].close - dir * params.atrMult * series.atr[i];
}

function isValidCandle(c) {
  return Boolean(c) && Number.isFinite(c.openTime)
    && [c.open, c.high, c.low, c.close].every(v => Number.isFinite(v) && v > 0)
    && c.high >= c.low;
}

const directionName = dir => (dir === 1 ? 'LONG' : 'SHORT');
const round = (x, d = 2) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null);

function evaluateEmaCrossTrend(candles, { params = EMA_CROSS_DEFAULTS, historyLimit = 10 } = {}) {
  const barMs = TIMEFRAME_MS[params.timeframe];
  const minCandles = params.slow + 2;
  const base = { strategy: STRATEGY_ID, timeframe: params.timeframe, params: { ...params } };

  if (!Array.isArray(candles) || !candles.every(isValidCandle)) {
    return { ...base, ready: false, reason: 'Invalid candle data' };
  }
  if (candles.length < minCandles) {
    return { ...base, ready: false, reason: `Insufficient ${params.timeframe} candles (${candles.length}/${minCandles})` };
  }

  const series = emaCrossSeries(candles, params);
  const closeTime = i => candles[i].openTime + barMs;
  const trades = [];
  let pos = null;
  let pending = null;

  const closeTrade = (price, reason, time) => {
    const riskPerUnit = Math.abs(pos.entryPrice - pos.stop);
    trades.push({
      direction: directionName(pos.dir),
      signalTime: pos.signalTime,
      entryTime: pos.entryTime,
      entryPrice: round(pos.entryPrice),
      stop: round(pos.stop),
      exitTime: time,
      exitPrice: round(price),
      exitReason: reason,
      r: round((pos.dir * (price - pos.entryPrice)) / riskPerUnit, 2),
    });
    pos = null;
  };

  for (let i = 0; i < candles.length; i++) {
    const bar = candles[i];
    if (pending) {
      if (pos) closeTrade(bar.open, 'REVERSE', bar.openTime);
      // A gap past the stop at the open voids the entry, as in the backtest.
      if (pending.dir * (bar.open - pending.stop) > 0) {
        pos = { ...pending, entryPrice: bar.open, entryTime: bar.openTime };
      }
      pending = null;
    }
    if (pos) {
      if (pos.dir === 1 ? bar.low <= pos.stop : bar.high >= pos.stop) {
        closeTrade(pos.stop, 'STOP', closeTime(i));
      }
    }
    const dir = crossAt(series, i);
    if (dir !== 0 && (!pos || pos.dir !== dir)) {
      pending = {
        dir,
        signalIndex: i,
        signalTime: closeTime(i),
        signalPrice: bar.close,
        stop: stopFor(series, candles, i, dir, params),
      };
    }
  }

  const last = candles.length - 1;
  const trend = series.side[last] === 1 ? 'UP' : 'DOWN';
  let action;
  let direction = null;
  let signal = null;

  if (pending) {
    direction = directionName(pending.dir);
    action = pos ? `REVERSE_TO_${direction}` : `ENTER_${direction}`;
    signal = {
      time: pending.signalTime,
      price: round(pending.signalPrice),
      stop: round(pending.stop),
      entryPrice: null,
      entryTime: null,
      barsAgo: 0,
    };
  } else if (pos) {
    direction = directionName(pos.dir);
    action = `HOLD_${direction}`;
    signal = {
      time: pos.signalTime,
      price: round(pos.signalPrice),
      stop: round(pos.stop),
      entryPrice: round(pos.entryPrice),
      entryTime: pos.entryTime,
      barsAgo: last - pos.signalIndex,
    };
  } else {
    action = 'WAIT';
  }

  return {
    ...base,
    ready: true,
    asOf: closeTime(last),
    nextCheckAt: closeTime(last) + barMs,
    candleCount: candles.length,
    trend,
    action,
    direction,
    signal,
    indicators: {
      close: round(candles[last].close),
      emaFast: round(series.fast[last]),
      emaSlow: round(series.slow[last]),
      atr: round(series.atr[last]),
    },
    history: trades.slice(-historyLimit).reverse(),
  };
}

module.exports = { STRATEGY_ID, EMA_CROSS_DEFAULTS, emaCrossSeries, crossAt, stopFor, evaluateEmaCrossTrend };
