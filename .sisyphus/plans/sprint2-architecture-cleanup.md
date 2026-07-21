# Sprint 2: Architecture Cleanup

## Context

Atlas Sprint 1 delivered a complete trading engine pipeline but introduced significant code duplication and frontend quality issues. The "filter active candle" pattern is copy-pasted identically across **16 locations** (7 engine files, 1 server.js, 8 route handlers). The frontend `app.js` has **22 `console.log` debug statements** firing every 3 seconds, and two functions (`fetchPaperTrades` and `fetchPerformance`) race over the same DOM elements, causing the Performance panel to flicker unpredictably between data sources.

This plan eliminates all duplication and frontend defects while preserving 100% existing API contracts and trading behavior.

---

## Task 1: Create shared candle utility

**File to create:** `backend/src/engine/candleUtils.js`

A single exported function:

```js
function getFinalizedCandles(candleEngine, timeframe, limit) {
  const allCandles = candleEngine.getCandles(timeframe, limit || 500);
  const active = candleEngine.getActive(timeframe);
  if (active && allCandles.length > 0 &&
      allCandles[allCandles.length - 1].openTime === active.openTime) {
    return allCandles.slice(0, -1);
  }
  return allCandles;
}

module.exports = { getFinalizedCandles };
```

This is a pure extraction — the logic is identical in every location.

---

## Task 2: Replace all 16 duplicate implementations

Replace the 4-line candle-filtering block with a single call to `getFinalizedCandles()` in each file:

### Engine files (7 files, each has the same pattern in `calculate()`):

| # | File | Line(s) | Context |
|---|------|---------|---------|
| 1 | `src/engine/atr.js` | 41-47 | `calculate()` |
| 2 | `src/engine/bollinger.js` | 48-54 | `calculate()` |
| 3 | `src/engine/macd.js` | 47-53 | `calculate()` |
| 4 | `src/engine/confluence.js` | 121-127 | `calculateAll()` |
| 5 | `src/engine/mtf.js` | 58-64 | `calculate()` inner loop |
| 6 | `src/engine/signalHistory.js` | 48-54 | `record()` |
| 7 | `src/market-regime/RegimeEngine.js` | 83-89 | `calculateAll()` |

### Route file (1 file, 8 occurrences in `routes.js`):

| # | Lines | Endpoint |
|---|-------|----------|
| 8 | 111-117 | `GET /indicators/rsi` |
| 9 | 157-163 | `GET /indicators/ema` |
| 10 | 278-284 | `GET /confluence` |
| 11 | 325-331 | `GET /market-regime` |
| 12 | 454-459 | `GET /structure` |
| 13 | 586-591 | `GET /backtest` |
| 14 | 636-641 | `GET /analytics` |
| 15 | 932-937 | `GET /market-regime/inspector` |

### Server file (1 file, 1 occurrence):

| # | Lines | Context |
|---|-------|---------|
| 16 | 188-194 | `runExecutionPipeline()` |

**Total: 16 replacements** — each removes 4-5 lines and replaces with 1 line.

---

## Task 3: Remove frontend console.log spam

**File:** `frontend/app.js`

Remove all **22 `console.log()` debug statements** that fire on every 3-second polling cycle. These log full API response objects and rendered values, flooding the browser console and leaking trading data.

Lines to remove (all are standalone `console.log(...)` statements):

| Line | Statement |
|------|-----------|
| 199 | `[Market] API response:` |
| 217 | `[Analysis] API response keys:` |
| 238 | `[Structure] API response:` |
| 248 | `[Structure] Rendered:` |
| 258 | `[RSI] API response:` |
| 264 | `[RSI] Rendered:` |
| 271 | `[EMA] API response:` |
| 282 | `[EMA] Rendered:` |
| 288 | `[MACD] API response:` |
| 295 | `[MACD] Rendered:` |
| 301 | `[ATR] API response:` |
| 308 | `[ATR] Rendered:` |
| 314 | `[Bollinger] API response:` |
| 325 | `[Bollinger] Rendered:` |
| 334 | `[MarketRegime] API response:` |
| 376 | `[Confluence] API response:` |
| 435 | `[Risk] API response:` |
| 475 | `[AdvanceRisk] API:` |
| 516 | `[MTFConf] API:` |
| 555 | `[PaperTrades] API response:` |
| 617 | `[PaperTrades] Rendered:` |
| 650 | `[Analytics] API response keys:` |
| 662 | `[Analytics] Rendered:` |

**22 lines removed, 0 lines added.** Pure deletion.

---

## Task 4: Fix Performance panel race condition

**File:** `frontend/app.js`

### Problem
`fetchPaperTrades()` and `fetchPerformance()` both write to the same DOM elements (`perfWinRate`, `perfStatus`, `perfSignals`) on every poll cycle. Whichever resolves last wins, causing unpredictable flicker.

### Solution

**A) Remove `fetchPaperTrades()` writes to shared Performance panel elements:**
- Line 606-617: Delete the block that writes `perfWinRate`, `perfProfitFactor`, `perfExpectancy`, `perfDrawdown`, `perfReturn`, `perfStreak`, and `perfStatus`. These are **only** authored by `fetchPerformance()` (the analytics endpoint) which is the correct source.
- Line 620-641: Change the `perfSignals` rendering to use a **paper-trade-specific** container. The `index.html` already has a `paperTrades` list (`id="paperTrades"`) — closed trades are already rendered there at lines 578-603. So the `perfSignals` block in `fetchPaperTrades()` is fully redundant and should be deleted.

**B) Remove dead code in `fetchPaperTrades()`:**
- Line 563: First `paperWins` assignment is immediately overwritten at line 566. Delete line 563.

**C) Remove early returns that skip performance panel updates:**
- Lines 582-583 and 623-624: When `allTrades.length === 0` or `closedTrades.length === 0`, the function returns early, skipping performance panel updates. Since we're removing the performance panel writes from `fetchPaperTrades()` entirely (task A), these early returns no longer cause the issue.

### Net effect on `fetchPaperTrades()`:
- Remove dead `paperWins` assignment (line 563)
- Remove entire performance panel update block (lines 606-617)
- Remove `perfSignals` closed-trades rendering (lines 620-641)
- `fetchPaperTrades()` now only updates `paper*` elements
- `fetchPerformance()` is the sole owner of `perf*` elements

### Also fix: Remove `fetchPerformance()` backtest signal rendering overlap:
`fetchPerformance()` at lines 664-686 overwrites `perfSignals` with backtest data. This conflicts with paper trades. Since `fetchPaperTrades()` is already rendering closed trades into `paperTrades` (lines 578-603), the backtest signal rendering in `fetchPerformance()` should render into `perfSignals` (which is now exclusively owned by it after task A). This is already the case — no change needed for `fetchPerformance()` itself.

---

## Task 5: Validation

After each task, run:

```bash
# Syntax check all JS files
node --check backend/server.js
node --check backend/src/engine/candleUtils.js
node --check backend/src/engine/atr.js
node --check backend/src/engine/bollinger.js
node --check backend/src/engine/macd.js
node --check backend/src/engine/confluence.js
node --check backend/src/engine/mtf.js
node --check backend/src/engine/signalHistory.js
node --check backend/src/market-regime/RegimeEngine.js
node --check backend/src/routes/routes.js
node --check frontend/app.js

# Quick start test (verify no startup crashes)
cd backend && timeout 15 node server.js 2>&1 || true
```

If any step fails, fix forward before proceeding.

---

## Task 6: Regression checklist

After all changes:

1. Every API endpoint returns identical JSON structure (no removed/renamed fields)
2. Backend starts without errors (config validation passes, all engines initialize)
3. Frontend loads without JS errors (no undefined DOM references)
4. Performance panel shows analytics data only (no paper-trade overwrites)
5. Paper trades panel shows paper-trade data only (no analytics overwrites)
6. No `console.log` spam in browser console on page load
7. Candle filtering logic in `candleUtils.js` produces identical results to the inline version

---

## Files modified

| File | Change |
|------|--------|
| `backend/src/engine/candleUtils.js` | **NEW** — shared candle filtering utility |
| `backend/src/engine/atr.js` | Replace inline filter with `getFinalizedCandles()` |
| `backend/src/engine/bollinger.js` | Replace inline filter with `getFinalizedCandles()` |
| `backend/src/engine/macd.js` | Replace inline filter with `getFinalizedCandles()` |
| `backend/src/engine/confluence.js` | Replace inline filter with `getFinalizedCandles()` |
| `backend/src/engine/mtf.js` | Replace inline filter with `getFinalizedCandles()` |
| `backend/src/engine/signalHistory.js` | Replace inline filter with `getFinalizedCandles()` |
| `backend/src/market-regime/RegimeEngine.js` | Replace inline filter with `getFinalizedCandles()` |
| `backend/src/routes/routes.js` | Replace 8 inline filters with `getFinalizedCandles()` |
| `backend/server.js` | Replace 1 inline filter with `getFinalizedCandles()`, add require |
| `frontend/app.js` | Remove 22 console.logs, fix perf panel race, remove dead code |

**Total: 11 files modified, 0 files deleted.**

---

## Expected outcomes

| Metric | Before | After |
|--------|--------|-------|
| Duplicated candle-filter blocks | 16 | 0 (1 shared function) |
| Lines removed (duplication) | — | ~72 lines across engine/route files |
| Lines added (import + call) | — | ~24 lines (1 import + 16 one-line calls, minus the removed blocks) |
| Frontend `console.log` statements | 22 | 0 |
| DOM element ownership conflicts | 3 elements (perfWinRate, perfStatus, perfSignals) | 0 (each panel exclusively owned) |
| Dead code lines | 2 (paperWins double-write, perf panel overwrites) | 0 |
| API contracts changed | 0 | 0 |
| Trading logic changed | 0 | 0 |
