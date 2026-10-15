'use strict';

// Bar-by-bar futures backtester on 1h bars.
//
// Timing rules (no look-ahead):
//   - A strategy sees bar i only after it closes. Entries and signal exits fill
//     at the OPEN of bar i+1, with adverse slippage.
//   - Stops are resting orders: a gap through the stop fills at the open,
//     otherwise at the stop price, both with slippage.
//   - If a bar touches both stop and target, the stop is assumed to fill first.
//   - Targets are limit orders: no slippage.
//   - Every fill pays the taker fee. Funding is charged on open positions at each
//     funding timestamp (longs pay positive rates, shorts receive them).

const HOUR = 3_600_000;

const DEFAULT_COSTS = Object.freeze({ feePct: 0.05, slippagePct: 0.02 });
const DEFAULT_RISK = Object.freeze({ riskPct: 2, maxLeverage: 5, initialEquity: 10_000 });

function simulate({
  h1,
  funding = [],
  strategy,
  from = -Infinity,
  to = Infinity,
  costs = DEFAULT_COSTS,
  risk = DEFAULT_RISK,
}) {
  const fee = costs.feePct / 100;
  const slip = costs.slippagePct / 100;
  let equity = risk.initialEquity;
  let pos = null;
  let pendingEntry = null;
  let pendingExit = false;
  let fi = 0;
  const trades = [];
  const curve = [];
  const fundingEvents = funding.map(f => ({ time: Math.round(f.time / 60_000) * 60_000, rate: f.rate }));

  const adverse = (price, dir, isEntry) => price * (1 + (isEntry ? dir : -dir) * slip);

  function close(price, reason, time) {
    const gross = pos.dir * (price - pos.entry) * pos.qty;
    const exitFee = pos.qty * price * fee;
    equity += gross - exitFee;
    const net = gross - pos.entryFee - exitFee - pos.funding;
    trades.push({
      dir: pos.dir,
      entryTime: pos.entryTime,
      exitTime: time,
      entry: pos.entry,
      exit: price,
      initialStop: pos.initialStop,
      target: pos.target,
      qty: pos.qty,
      riskAmount: pos.riskAmount,
      fees: pos.entryFee + exitFee,
      funding: pos.funding,
      net,
      r: net / pos.riskAmount,
      reason,
      bars: pos.bars,
      meta: pos.meta,
    });
    pos = null;
  }

  for (let i = 0; i < h1.length; i++) {
    const bar = h1[i];
    const barEnd = bar.openTime + HOUR;
    const inWindow = bar.openTime >= from && barEnd <= to;

    // 1. Fills at this bar's open.
    if (pendingExit && pos) close(adverse(bar.open, pos.dir, false), 'SIGNAL', bar.openTime);
    pendingExit = false;
    if (pendingEntry && !pos && inWindow) {
      const { dir, stop, target = null, meta } = pendingEntry;
      const entry = adverse(bar.open, dir, true);
      const stopDistance = dir * (entry - stop);
      const targetOk = target === null || dir * (target - entry) > 0;
      if (stopDistance > 0 && targetOk && equity > 0) {
        const riskAmount = equity * (risk.riskPct / 100);
        const qty = Math.min(riskAmount / stopDistance, (equity * risk.maxLeverage) / entry);
        const entryFee = qty * entry * fee;
        equity -= entryFee;
        pos = {
          dir, entry, qty, stop, target, initialStop: stop,
          riskAmount: qty * stopDistance, entryTime: bar.openTime,
          entryFee, funding: 0, bars: 0, signalIndex: pendingEntry.signalIndex, meta,
        };
      }
    }
    pendingEntry = null;

    // 2. Resting stop / target orders during the bar.
    if (pos) {
      pos.bars++;
      const { dir, stop, target } = pos;
      if (dir * (bar.open - stop) <= 0) {
        close(adverse(bar.open, dir, false), 'STOP', bar.openTime);
      } else if (dir === 1 ? bar.low <= stop : bar.high >= stop) {
        close(adverse(stop, dir, false), 'STOP', barEnd);
      } else if (target !== null && (dir === 1 ? bar.high >= target : bar.low <= target)) {
        close(target, 'TARGET', barEnd);
      }
    }

    // 3. Funding at timestamps inside (open, close].
    while (fi < fundingEvents.length && fundingEvents[fi].time <= barEnd) {
      const ev = fundingEvents[fi++];
      if (pos && ev.time > bar.openTime) {
        const payment = pos.dir * pos.qty * bar.close * ev.rate;
        equity -= payment;
        pos.funding += payment;
      }
    }

    if (!inWindow) {
      if (pos && bar.openTime >= to) close(bar.open, 'END', bar.openTime);
      continue;
    }

    // 4. Strategy decisions at the close of bar i.
    const isLast = i === h1.length - 1 || h1[i + 1].openTime + HOUR > to;
    if (pos && isLast) {
      close(bar.close, 'END', barEnd);
    } else if (pos) {
      const action = strategy.manage ? strategy.manage(i, pos) : null;
      if (action?.stop !== undefined && pos.dir * (action.stop - pos.stop) > 0
        && pos.dir * (bar.close - action.stop) > 0) {
        pos.stop = action.stop;
      }
      if (action?.exit) pendingExit = true;
    }
    if (!isLast && (!pos || pendingExit)) {
      const signal = strategy.signal(i);
      if (signal && (!pos || signal.dir !== pos.dir)) pendingEntry = { ...signal, signalIndex: i };
    }

    const unrealized = pos ? pos.dir * (bar.close - pos.entry) * pos.qty : 0;
    curve.push({ time: barEnd, equity: equity + unrealized, close: bar.close });
  }

  return { trades, curve, finalEquity: equity, initialEquity: risk.initialEquity };
}

function summarize({ trades, curve, initialEquity }) {
  const wins = trades.filter(t => t.net > 0);
  const losses = trades.filter(t => t.net <= 0);
  const grossWin = wins.reduce((s, t) => s + t.net, 0);
  const grossLoss = -losses.reduce((s, t) => s + t.net, 0);
  const finalEquity = curve.length ? curve.at(-1).equity : initialEquity;

  let peak = initialEquity;
  let maxDd = 0;
  for (const p of curve) {
    peak = Math.max(peak, p.equity);
    maxDd = Math.max(maxDd, (peak - p.equity) / peak);
  }

  const years = curve.length ? (curve.at(-1).time - curve[0].time + HOUR) / (365.25 * 24 * HOUR) : 0;
  const totalReturn = finalEquity / initialEquity - 1;
  const cagr = years > 0 && finalEquity > 0 ? (finalEquity / initialEquity) ** (1 / years) - 1 : -1;
  const exposureBars = trades.reduce((s, t) => s + t.bars, 0);
  const byYear = {};
  let yearStart = initialEquity;
  for (let k = 0; k < curve.length; k++) {
    const y = new Date(curve[k].time - 1).getUTCFullYear();
    const next = curve[k + 1];
    if (!next || new Date(next.time - 1).getUTCFullYear() !== y) {
      byYear[y] = pct(curve[k].equity / yearStart - 1);
      yearStart = curve[k].equity;
    }
  }
  const side = dir => {
    const t = trades.filter(x => x.dir === dir);
    return { trades: t.length, netR: round(t.reduce((s, x) => s + x.r, 0), 1) };
  };

  return {
    trades: trades.length,
    winRate: trades.length ? pct(wins.length / trades.length) : 0,
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss, 2) : (grossWin > 0 ? Infinity : 0),
    avgR: trades.length ? round(trades.reduce((s, t) => s + t.r, 0) / trades.length, 3) : 0,
    totalReturnPct: pct(totalReturn),
    cagrPct: pct(cagr),
    maxDrawdownPct: pct(maxDd),
    mar: maxDd > 0 ? round(cagr / maxDd, 2) : 0,
    exposurePct: curve.length ? pct(exposureBars / curve.length) : 0,
    feesPaid: round(trades.reduce((s, t) => s + t.fees, 0), 0),
    fundingPaid: round(trades.reduce((s, t) => s + t.funding, 0), 0),
    buyHoldPct: curve.length ? pct(curve.at(-1).close / curve[0].close - 1) : 0,
    long: side(1),
    short: side(-1),
    byYear,
  };
}

function pct(x) { return round(x * 100, 1); }
function round(x, d) { const f = 10 ** d; return Math.round(x * f) / f; }

module.exports = { simulate, summarize, DEFAULT_COSTS, DEFAULT_RISK, HOUR };
