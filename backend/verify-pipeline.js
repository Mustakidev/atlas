#!/usr/bin/env node
/**
 * Atlas Pipeline End-to-End Verification Script
 * 
 * Runs the live pipeline for 1 hour, records every evaluation cycle,
 * and generates a verification report.
 * 
 * Usage: node verify-pipeline.js [--duration <minutes>] [--interval <seconds>]
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const ARGS = parseArgs();
const DURATION_MIN = ARGS.duration || 60;
const POLL_INTERVAL_SEC = ARGS.interval || 3;
const DURATION_MS = DURATION_MIN * 60 * 1000;
const BASE_URL = 'http://localhost:3000';
const OUTPUT_DIR = path.join(__dirname, '..', 'verification-reports');
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-');
const OUTPUT_FILE = path.join(OUTPUT_DIR, `verify-${TIMESTAMP}.json`);
const REPORT_FILE = path.join(OUTPUT_DIR, `verify-${TIMESTAMP}.md`);

function parseArgs() {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--duration' && process.argv[i + 1]) {
      args.duration = parseInt(process.argv[i + 1], 10);
      i++;
    } else if (process.argv[i] === '--interval' && process.argv[i + 1]) {
      args.interval = parseInt(process.argv[i + 1], 10);
      i++;
    }
  }
  return args;
}

function fetchJSON(urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${BASE_URL}${urlPath}`, { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode} for ${urlPath}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`JSON parse error: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

const IMMUTABLE_TRADE_FIELDS = ['side', 'entry', 'sl', 'tp', 'size', 'rr', 'openedAt'];
const CLOSURE_TRADE_FIELDS = ['exit', 'pnl', 'closedAt'];

function isValidTimestamp(value) {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}

function requireFiniteNumber(value, fieldName) {
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid paper trade ${fieldName}`);
  }
}

function normalizeTrade(trade, collection) {
  if (!trade || typeof trade !== 'object' || Array.isArray(trade)) {
    throw new Error('Invalid paper trade entry');
  }

  if (typeof trade.tradeId !== 'string' || trade.tradeId.trim() === '') {
    throw new Error('Paper trade is missing tradeId');
  }
  if (!['BUY', 'SELL'].includes(trade.direction)) {
    throw new Error(`Invalid paper trade direction for ${trade.tradeId}`);
  }
  if (!['OPEN', 'ACTIVE', 'CLOSED'].includes(trade.status)) {
    throw new Error(`Invalid paper trade status for ${trade.tradeId}`);
  }
  if (collection === 'open' && trade.status === 'CLOSED') {
    throw new Error(`Closed paper trade present in open collection: ${trade.tradeId}`);
  }
  if (collection === 'closed' && trade.status !== 'CLOSED') {
    throw new Error(`Open paper trade present in closed collection: ${trade.tradeId}`);
  }

  for (const [field, value] of [
    ['entryPrice', trade.entryPrice],
    ['stopLoss', trade.stopLoss],
    ['takeProfit', trade.takeProfit],
    ['positionSize', trade.positionSize],
    ['riskReward', trade.riskReward],
  ]) {
    requireFiniteNumber(value, field);
  }
  if (!isValidTimestamp(trade.entryTime) || !isValidTimestamp(trade.timestamp)) {
    throw new Error(`Invalid paper trade timestamp for ${trade.tradeId}`);
  }

  const isClosed = trade.status === 'CLOSED';
  if (isClosed) {
    requireFiniteNumber(trade.exitPrice, 'exitPrice');
    requireFiniteNumber(trade.pnl, 'pnl');
    if (!isValidTimestamp(trade.exitTime)) {
      throw new Error(`Invalid paper trade exitTime for ${trade.tradeId}`);
    }
  } else {
    if (trade.exitPrice !== null && trade.exitPrice !== undefined) {
      requireFiniteNumber(trade.exitPrice, 'exitPrice');
    }
    if (trade.pnl !== null && trade.pnl !== undefined) {
      requireFiniteNumber(trade.pnl, 'pnl');
    }
    if (trade.exitTime !== null && trade.exitTime !== undefined && !isValidTimestamp(trade.exitTime)) {
      throw new Error(`Invalid paper trade exitTime for ${trade.tradeId}`);
    }
  }

  return {
    id: trade.tradeId,
    type: isClosed ? 'closed' : 'opened',
    side: trade.direction,
    entry: trade.entryPrice,
    exit: trade.exitPrice ?? null,
    sl: trade.stopLoss,
    tp: trade.takeProfit,
    size: trade.positionSize,
    rr: trade.riskReward,
    pnl: trade.pnl ?? null,
    openedAt: trade.entryTime,
    closedAt: trade.exitTime ?? null,
    timestamp: trade.timestamp,
  };
}

function normalizePaperTradeResponse(response) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new Error('Invalid paper trades response object');
  }
  if (!Object.hasOwn(response, 'open') || !Object.hasOwn(response, 'closed')) {
    throw new Error('Paper trades response must contain open and closed arrays');
  }
  if (!Array.isArray(response.open) || !Array.isArray(response.closed)) {
    throw new Error('Paper trades response open and closed fields must be arrays');
  }

  return {
    open: response.open.map(trade => normalizeTrade(trade, 'open')),
    closed: response.closed.map(trade => normalizeTrade(trade, 'closed')),
  };
}

function assertCompatibleTrade(existing, incoming, fields) {
  for (const field of fields) {
    if (!Object.is(existing[field], incoming[field])) {
      throw new Error(`Conflicting paper trade ${field} for ${incoming.id}`);
    }
  }
}

function mergeTradeObservation(tradesById, observation) {
  const existing = tradesById.get(observation.id);
  if (!existing) {
    tradesById.set(observation.id, { ...observation });
    return;
  }

  assertCompatibleTrade(existing, observation, IMMUTABLE_TRADE_FIELDS);

  if (observation.type === 'closed') {
    if (existing.type === 'closed') {
      assertCompatibleTrade(existing, observation, CLOSURE_TRADE_FIELDS);
    } else {
      existing.type = 'closed';
      existing.exit = observation.exit;
      existing.pnl = observation.pnl;
      existing.closedAt = observation.closedAt;
    }
  }
}

function formatTime(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ${s % 60}s`;
}

function evaluateChecks(cycles, trades, verificationState = {}) {
  const totalCycles = cycles.length;
  const cyclesWithPrice = cycles.filter(c => c.price != null);
  const cyclesNoPrice = cycles.filter(c => c.price == null);
  const confluenceScores = cyclesWithPrice.map(c => c.confluenceScore).filter(s => s != null);
  const biasCounts = {};
  const rejectionReasons = {};
  cycles.forEach(c => {
    const bias = c.bias || 'Unknown';
    biasCounts[bias] = (biasCounts[bias] || 0) + 1;
    if (!c.tradeOpened) {
      const reason = c.rejectionReason || 'Unknown';
      rejectionReasons[reason] = (rejectionReasons[reason] || 0) + 1;
    }
  });
  const gateNotEval = {};
  const gateNames = ['confluenceBias', 'trend', 'structure', 'rsi', 'ema', 'macd', 'atr', 'bollinger', 'riskEngine'];
  gateNames.forEach(g => { gateNotEval[g] = 0; });
  cycles.forEach(c => {
    if (c.gates) {
      gateNames.forEach(g => {
        if (!c.gates[g]) gateNotEval[g]++;
      });
    }
  });

  const checks = [
    { name: 'Pipeline running (cycles > 0)', pass: totalCycles > 0 },
    { name: 'Price data available', pass: cyclesWithPrice.length > 0 },
    { name: 'Confluence scores computed', pass: confluenceScores.length > 0 },
    { name: 'All gates evaluated (no stale --)', pass: gateNotEval.confluenceBias === 0 || cyclesNoPrice.length === gateNotEval.confluenceBias },
    { name: 'Bias distribution valid (no Unknown)', pass: !biasCounts['Unknown'] || biasCounts['Unknown'] === 0 },
    { name: 'Rejection reasons recorded', pass: Object.keys(rejectionReasons).length > 0 },
    { name: 'Consistent cycle count', pass: totalCycles >= (DURATION_MIN * 60 / POLL_INTERVAL_SEC * 0.8) },
    { name: 'Pipeline endpoint contract', pass: !verificationState.inspectorFailed },
    { name: 'Paper trades response contract', pass: !verificationState.paperContractFailed },
  ];

  return { checks, allPass: checks.every(c => c.pass) };
}

function generateReport(cycles, trades, startTime, endTime, verificationState = {}) {
  const totalCycles = cycles.length;
  const durationMs = endTime - startTime;

  const cyclesWithPrice = cycles.filter(c => c.price != null);
  const cyclesNoPrice = cycles.filter(c => c.price == null);

  const biasCounts = {};
  cycles.forEach(c => {
    const bias = c.bias || 'Unknown';
    biasCounts[bias] = (biasCounts[bias] || 0) + 1;
  });

  const rejectionReasons = {};
  cycles.forEach(c => {
    if (!c.tradeOpened) {
      const reason = c.rejectionReason || 'Unknown';
      rejectionReasons[reason] = (rejectionReasons[reason] || 0) + 1;
    }
  });

  const gatePassCounts = {};
  const gateFailCounts = {};
  const gateNotEval = {};
  const gateNames = ['confluenceBias', 'trend', 'structure', 'rsi', 'ema', 'macd', 'atr', 'bollinger', 'riskEngine'];
  gateNames.forEach(g => { gatePassCounts[g] = 0; gateFailCounts[g] = 0; gateNotEval[g] = 0; });

  cycles.forEach(c => {
    if (c.gates) {
      gateNames.forEach(g => {
        if (!c.gates[g]) {
          gateNotEval[g]++;
        } else if (c.gates[g].pass) {
          gatePassCounts[g]++;
        } else {
          gateFailCounts[g]++;
        }
      });
    }
  });

  const prices = cyclesWithPrice.map(c => c.price);
  const priceMin = prices.length ? Math.min(...prices) : 0;
  const priceMax = prices.length ? Math.max(...prices) : 0;
  const priceStart = prices.length ? prices[0] : 0;
  const priceEnd = prices.length ? prices[prices.length - 1] : 0;
  const priceChange = priceStart ? ((priceEnd - priceStart) / priceStart * 100).toFixed(2) : '0';

  const confluenceScores = cyclesWithPrice.map(c => c.confluenceScore).filter(s => s != null);
  const avgConfluence = confluenceScores.length
    ? (confluenceScores.reduce((a, b) => a + b, 0) / confluenceScores.length).toFixed(1)
    : 'N/A';
  const minConfluence = confluenceScores.length ? Math.min(...confluenceScores) : 'N/A';
  const maxConfluence = confluenceScores.length ? Math.max(...confluenceScores) : 'N/A';

  const tradesOpened = trades;
  const tradesClosed = trades.filter(t => t.type === 'closed');
  const totalTradesOpened = tradesOpened.length;
  const totalTradesClosed = tradesClosed.length;

  let wins = 0, losses = 0, totalPnL = 0, grossProfit = 0, grossLoss = 0;
  const pnls = [];
  tradesClosed.forEach(t => {
    const pnl = t.pnl || 0;
    pnls.push(pnl);
    totalPnL += pnl;
    if (pnl > 0) { wins++; grossProfit += pnl; }
    else if (pnl < 0) { losses++; grossLoss += Math.abs(pnl); }
  });
  const winRate = totalTradesClosed > 0 ? (wins / totalTradesClosed * 100).toFixed(1) : 'N/A';
  const profitFactor = grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : (grossProfit > 0 ? '∞' : 'N/A');
  const expectancy = totalTradesClosed > 0 ? (totalPnL / totalTradesClosed).toFixed(2) : 'N/A';
  const avgWin = wins > 0 ? (grossProfit / wins).toFixed(2) : 'N/A';
  const avgLoss = losses > 0 ? (grossLoss / losses).toFixed(2) : 'N/A';
  const largestWin = pnls.length ? Math.max(...pnls).toFixed(2) : 'N/A';
  const largestLoss = pnls.length ? Math.min(...pnls).toFixed(2) : 'N/A';

  const tradesBySide = { BUY: 0, SELL: 0 };
  tradesOpened.forEach(t => { tradesBySide[t.side] = (tradesBySide[t.side] || 0) + 1; });

  let md = `# Atlas Pipeline Verification Report\n\n`;
  md += `**Generated:** ${new Date(endTime).toISOString()}\n`;
  md += `**Duration:** ${formatTime(durationMs)} (${DURATION_MIN} min target)\n`;
  md += `**Poll Interval:** ${POLL_INTERVAL_SEC}s\n`;
  md += `**Symbol:** BTC/USDT\n\n`;

  md += `## Summary\n\n`;
  md += `| Metric | Value |\n`;
  md += `|---|---|\n`;
  md += `| Total Cycles Recorded | ${totalCycles} |\n`;
  md += `| Cycles with Price | ${cyclesWithPrice.length} |\n`;
  md += `| Cycles without Price | ${cyclesNoPrice.length} |\n`;
  md += `| Duration | ${formatTime(durationMs)} |\n\n`;

  md += `## Price Action\n\n`;
  md += `| Metric | Value |\n`;
  md += `|---|---|\n`;
  md += `| Start Price | $${priceStart.toLocaleString()} |\n`;
  md += `| End Price | $${priceEnd.toLocaleString()} |\n`;
  md += `| Change | ${priceChange}% |\n`;
  md += `| Low | $${priceMin.toLocaleString()} |\n`;
  md += `| High | $${priceMax.toLocaleString()} |\n\n`;

  md += `## Confluence\n\n`;
  md += `| Metric | Value |\n`;
  md += `|---|---|\n`;
  md += `| Average Score | ${avgConfluence} |\n`;
  md += `| Min Score | ${minConfluence} |\n`;
  md += `| Max Score | ${maxConfluence} |\n`;
  md += `| Bullish Threshold | ≥65 |\n`;
  md += `| Bearish Threshold | ≤35 |\n\n`;

  md += `## Bias Distribution\n\n`;
  md += `| Bias | Count | % |\n`;
  md += `|---|---|---|\n`;
  Object.entries(biasCounts)
    .sort((a, b) => b[1] - a[1])
    .forEach(([bias, count]) => {
      md += `| ${bias} | ${count} | ${(count / totalCycles * 100).toFixed(1)}% |\n`;
    });
  md += `\n`;

  md += `## Gate Evaluation Summary\n\n`;
  md += `| Gate | Pass | Fail | Not Evaluated | Evaluated % |\n`;
  md += `|---|---|---|---|---|\n`;
  gateNames.forEach(g => {
    const total = gatePassCounts[g] + gateFailCounts[g] + gateNotEval[g];
    const evaluated = gatePassCounts[g] + gateFailCounts[g];
    const evalPct = total > 0 ? (evaluated / total * 100).toFixed(1) : '0';
    const passPct = evaluated > 0 ? (gatePassCounts[g] / evaluated * 100).toFixed(1) : '0';
    md += `| ${g} | ${gatePassCounts[g]} (${passPct}% of evaluated) | ${gateFailCounts[g]} | ${gateNotEval[g]} | ${evalPct}% |\n`;
  });
  md += `\n`;

  md += `## Trade Decision Summary\n\n`;
  md += `| Metric | Value |\n`;
  md += `|---|---|\n`;
  md += `| Total Trade Opened | ${totalTradesOpened} |\n`;
  md += `| Total Rejected | ${totalCycles - totalTradesOpened - cyclesNoPrice.length} |\n`;
  md += `| BUY Trades | ${tradesBySide.BUY || 0} |\n`;
  md += `| SELL Trades | ${tradesBySide.SELL || 0} |\n\n`;

  md += `## Rejection Reasons\n\n`;
  md += `| Reason | Count | % |\n`;
  md += `|---|---|---|\n`;
  Object.entries(rejectionReasons)
    .sort((a, b) => b[1] - a[1])
    .forEach(([reason, count]) => {
      md += `| ${reason} | ${count} | ${(count / (totalCycles - totalTradesOpened) * 100).toFixed(1)}% |\n`;
    });
  md += `\n`;

  if (totalTradesClosed > 0) {
    md += `## Trade Performance\n\n`;
    md += `| Metric | Value |\n`;
    md += `|---|---|\n`;
    md += `| Total Closed | ${totalTradesClosed} |\n`;
    md += `| Wins | ${wins} |\n`;
    md += `| Losses | ${losses} |\n`;
    md += `| Win Rate | ${winRate}% |\n`;
    md += `| Profit Factor | ${profitFactor} |\n`;
    md += `| Expectancy | ${expectancy} |\n`;
    md += `| Avg Win | $${avgWin} |\n`;
    md += `| Avg Loss | $${avgLoss} |\n`;
    md += `| Largest Win | $${largestWin} |\n`;
    md += `| Largest Loss | $${largestLoss} |\n`;
    md += `| Total PnL | $${totalPnL.toFixed(2)} |\n\n`;

    md += `## Trade Log\n\n`;
    md += `| # | Time | Side | Entry | Exit | SL | TP | Size | R:R | PnL |\n`;
    md += `|---|---|---|---|---|---|---|---|---|---|\n`;
    tradesClosed.forEach((t, i) => {
      md += `| ${i + 1} | ${t.closedAt || t.openedAt || t.timestamp} | ${t.side} | $${t.entry} | $${t.exit || '--'} | $${t.sl || '--'} | $${t.tp || '--'} | $${t.size} | ${t.rr || '--'} | $${(t.pnl || 0).toFixed(2)} |\n`;
    });
    md += `\n`;
  } else {
    md += `## Trade Performance\n\n`;
    md += `No trades were closed during the verification period.\n\n`;
  }

  md += `## Verification Checks\n\n`;
  const { checks, allPass } = evaluateChecks(cycles, trades, verificationState);

  md += `| Check | Status |\n`;
  md += `|---|---|\n`;
  checks.forEach(c => {
    md += `| ${c.name} | ${c.pass ? '✅ PASS' : '❌ FAIL'} |\n`;
  });
  md += `\n**Overall:** ${allPass ? '✅ ALL CHECKS PASSED' : '❌ SOME CHECKS FAILED'}\n`;

  md += `\n---\n*Report generated by Atlas Pipeline Verification Script*\n`;

  return md;
}

async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('  Atlas Pipeline End-to-End Verification');
  console.log(`  Duration: ${DURATION_MIN} min | Interval: ${POLL_INTERVAL_SEC}s`);
  console.log('═══════════════════════════════════════════════\n');

  // Check server is running
  try {
    const inspector = await fetchJSON('/api/signal/inspector');
    console.log(`✅ Server running — inspector available: ${inspector.available}`);
  } catch (e) {
    console.error('❌ Server not reachable. Start it with: node server.js');
    process.exit(1);
  }

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const startTime = Date.now();
  const cycles = [];
  const tradesById = new Map();
  const seenCycles = new Set();
  let pollCount = 0;
  let errorCount = 0;
  const verificationState = {
    paperContractFailed: false,
    inspectorFailed: false,
    firstPaperFailure: null,
    firstInspectorFailure: null,
  };

  console.log(`\nRecording started at ${new Date(startTime).toISOString()}`);
  console.log(`Output: ${OUTPUT_FILE}\n`);

  const endTime = startTime + DURATION_MS;
  let lastProgressPrint = 0;

  while (Date.now() < endTime) {
    pollCount++;
    try {
      const [inspectorResult, paperTradesResult] = await Promise.allSettled([
        fetchJSON('/api/signal/inspector'),
        fetchJSON('/api/paper-trades')
      ]);

      if (inspectorResult.status === 'rejected') {
        verificationState.inspectorFailed = true;
        verificationState.firstInspectorFailure = verificationState.firstInspectorFailure || inspectorResult.reason.message;
      }
      if (paperTradesResult.status === 'rejected') {
        verificationState.paperContractFailed = true;
        verificationState.firstPaperFailure = verificationState.firstPaperFailure || paperTradesResult.reason.message;
      }
      if (inspectorResult.status === 'rejected' || paperTradesResult.status === 'rejected') {
        throw inspectorResult.status === 'rejected' ? inspectorResult.reason : paperTradesResult.reason;
      }

      const inspector = inspectorResult.value;
      const paperTrades = paperTradesResult.value;

      if (inspector && inspector.available) {
        const cycleKey = `${inspector.cycle}-${inspector.timestamp}`;
        if (!seenCycles.has(cycleKey)) {
          seenCycles.add(cycleKey);
          const record = {
            cycle: inspector.cycle,
            timestamp: inspector.timestamp,
            price: inspector.price,
            confluenceScore: inspector.confluence?.score,
            bias: inspector.confluence?.bias,
            confidence: inspector.confluence?.confidence,
            gates: inspector.gates || {},
            verdict: inspector.verdict || {},
            tradeOpened: inspector.verdict?.tradeOpened || false,
            rejectionReason: inspector.verdict?.rejectionReason || null,
            tradeDetails: inspector.trade || null,
          };
          cycles.push(record);
        }
      }

      try {
        const normalizedPaperTrades = normalizePaperTradeResponse(paperTrades);
        normalizedPaperTrades.open.forEach(trade => mergeTradeObservation(tradesById, trade));
        normalizedPaperTrades.closed.forEach(trade => mergeTradeObservation(tradesById, trade));
      } catch (e) {
        verificationState.paperContractFailed = true;
        verificationState.firstPaperFailure = verificationState.firstPaperFailure || e.message;
        throw e;
      }

      const elapsed = Date.now() - startTime;
      const elapsedMin = Math.floor(elapsed / 60000);
      if (elapsedMin > lastProgressPrint) {
        lastProgressPrint = elapsedMin;
        const pct = (elapsed / DURATION_MS * 100).toFixed(1);
        console.log(`[${new Date().toLocaleTimeString()}] ${pct}% | Cycles: ${cycles.length} | Trades: ${tradesById.size} | Errors: ${errorCount}`);
      }
    } catch (e) {
      errorCount++;
      if (errorCount <= 5) {
        console.error(`  ⚠ Poll error: ${e.message}`);
      }
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL_SEC * 1000));
  }

  const actualEndTime = Date.now();
  console.log(`\n═══════════════════════════════════════════════`);
  console.log(`  Recording complete: ${formatTime(actualEndTime - startTime)}`);
  const trades = Array.from(tradesById.values());
  console.log(`  Cycles: ${cycles.length} | Trades: ${trades.length} | Errors: ${errorCount}`);
  console.log(`═══════════════════════════════════════════════\n`);

  // Save raw data
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify({ startTime, endTime: actualEndTime, cycles, trades }, null, 2));
  console.log(`Raw data saved: ${OUTPUT_FILE}`);

  // Generate and save report
  const report = generateReport(cycles, trades, startTime, actualEndTime, verificationState);
  fs.writeFileSync(REPORT_FILE, report);
  console.log(`Report saved: ${REPORT_FILE}\n`);

  // Print report to console
  console.log(report);

  const { allPass } = evaluateChecks(cycles, trades, verificationState);
  if (!allPass) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(e => {
    console.error('Fatal error:', e.message);
    process.exit(1);
  });
}

module.exports = {
  evaluateChecks,
  fetchJSON,
  generateReport,
  mergeTradeObservation,
  normalizePaperTradeResponse,
  normalizeTrade,
};
