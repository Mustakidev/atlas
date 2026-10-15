'use strict';

// Strategy research runner.
//
//   node research/run.js [--risk 2] [--fee 0.05] [--slip 0.02] [--lev 5] [--json out.json]
//
// Three views per strategy, all with futures costs and funding:
//   1. Defaults over the full history (no tuning at all).
//   2. Tune on 2020-2023 only, then test the chosen settings on 2024-now.
//   3. Rolling walk-forward: each year is traded with settings chosen on the
//      two years before it. This is the most honest estimate of live results.
const fs = require('node:fs');
const { loadKlines, loadFunding } = require('./data');
const { simulate, summarize, DEFAULT_COSTS, DEFAULT_RISK } = require('./engine');
const { STRATEGIES, createContext, gridOf } = require('./strategies');

const MIN_TRADES = 20;

function parseArgs(argv) {
  const args = {};
  for (let k = 0; k < argv.length; k += 2) args[argv[k].replace(/^--/, '')] = argv[k + 1];
  return args;
}

function score(stats) {
  return stats.trades >= MIN_TRADES ? stats.mar : -Infinity;
}

function tune(ctx, strategy, run, from, to) {
  const results = gridOf(strategy).map(params => ({
    params,
    stats: summarize(run(strategy.build(ctx, params), from, to)),
  }));
  results.sort((a, b) => score(b.stats) - score(a.stats));
  const profitable = results.filter(r => r.stats.totalReturnPct > 0).length;
  return { best: results[0], profitableShare: `${profitable}/${results.length}`, results };
}

function line(label, s) {
  return `${label.padEnd(26)} trades ${String(s.trades).padStart(4)} | win ${String(s.winRate).padStart(5)}%`
    + ` | PF ${String(s.profitFactor).padStart(5)} | avgR ${String(s.avgR).padStart(6)}`
    + ` | return ${String(s.totalReturnPct).padStart(7)}% | CAGR ${String(s.cagrPct).padStart(6)}%`
    + ` | maxDD ${String(s.maxDrawdownPct).padStart(5)}% | B&H ${s.buyHoldPct}%`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const costs = { ...DEFAULT_COSTS, feePct: +(args.fee ?? DEFAULT_COSTS.feePct), slippagePct: +(args.slip ?? DEFAULT_COSTS.slippagePct) };
  const risk = { ...DEFAULT_RISK, riskPct: +(args.risk ?? DEFAULT_RISK.riskPct), maxLeverage: +(args.lev ?? DEFAULT_RISK.maxLeverage) };

  const [h1, h4, funding] = await Promise.all([loadKlines({ interval: '1h' }), loadKlines({ interval: '4h' }), loadFunding()]);
  const ctx = createContext(h1, h4);
  const run = (strategy, from, to) => simulate({ h1, funding, strategy, from, to, costs, risk });
  const lastYear = new Date(h1.at(-1).openTime).getUTCFullYear();
  const end = h1.at(-1).openTime + 3_600_000;
  const Y = y => Date.UTC(y, 0, 1);

  console.log(`Data: ${h1.length} 1h bars, ${h4.length} 4h bars, ${funding.length} funding events`);
  console.log(`      ${new Date(h1[0].openTime).toISOString()} → ${new Date(end).toISOString()}`);
  console.log(`Costs: fee ${costs.feePct}%/side, slippage ${costs.slippagePct}%/side, funding charged | Risk ${risk.riskPct}%/trade, max leverage ${risk.maxLeverage}x\n`);

  const report = { generatedAt: new Date().toISOString(), costs, risk, strategies: {} };

  for (const strategy of STRATEGIES) {
    console.log(`=== ${strategy.name}: ${strategy.summary}`);
    const full = summarize(run(strategy.build(ctx, strategy.defaults), Y(2020), end));
    console.log(line('defaults 2020→now', full));
    console.log(`${''.padEnd(26)} by year: ${JSON.stringify(full.byYear)}  long ${JSON.stringify(full.long)} short ${JSON.stringify(full.short)}`);

    const is = tune(ctx, strategy, run, Y(2020), Y(2024));
    const oos = summarize(run(strategy.build(ctx, is.best.params), Y(2024), end));
    console.log(line('tuned 2020-23 (in-sample)', is.best.stats) + `  params ${JSON.stringify(is.best.params)}`);
    console.log(line('→ tested 2024→now (OOS)', oos) + `  by year ${JSON.stringify(oos.byYear)}`);
    const oosGrid = tune(ctx, strategy, run, Y(2024), end);
    console.log(`${''.padEnd(26)} settings profitable: in-sample ${is.profitableShare}, out-of-sample ${oosGrid.profitableShare}`);

    let equity = risk.initialEquity;
    const walk = [];
    for (let y = 2022; y <= lastYear; y++) {
      const chosen = tune(ctx, strategy, run, Y(y - 2), Y(y)).best.params;
      const result = simulate({ h1, funding, strategy: strategy.build(ctx, chosen), from: Y(y), to: Math.min(Y(y + 1), end), costs, risk: { ...risk, initialEquity: equity } });
      const s = summarize(result);
      equity = result.curve.length ? result.curve.at(-1).equity : equity;
      walk.push({ year: y, params: chosen, returnPct: s.totalReturnPct, trades: s.trades, maxDrawdownPct: s.maxDrawdownPct, buyHoldPct: s.buyHoldPct });
    }
    const walkReturn = Math.round((equity / risk.initialEquity - 1) * 1000) / 10;
    console.log(`walk-forward 2022→now:     return ${walkReturn}%`);
    for (const w of walk) {
      console.log(`   ${w.year}: ${String(w.returnPct).padStart(7)}% (${w.trades} trades, maxDD ${w.maxDrawdownPct}%, B&H ${w.buyHoldPct}%) params ${JSON.stringify(w.params)}`);
    }
    console.log('');
    report.strategies[strategy.name] = { defaults: full, inSample: is.best, outOfSample: oos, walkForward: { returnPct: walkReturn, years: walk } };
  }

  if (args.json) fs.writeFileSync(args.json, JSON.stringify(report, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
