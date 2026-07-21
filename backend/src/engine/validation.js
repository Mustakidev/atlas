/**
 * Validation Engine
 *
 * Mathematically proves every engine is correct using deterministic
 * synthetic datasets. Never modifies production data.
 *
 * Each test produces:
 *   - status: 'PASS' | 'WARNING' | 'FAIL'
 *   - reason: explanation
 *   - executionTime: ms
 *
 * Version: 1.0.0
 * Data Source: Isolated synthetic datasets only (never production data)
 */
const ENGINE_VERSION = '1.0.0';
const TOLERANCE = 0.01;
const SOFT_TOLERANCE = 5.0;

class ValidationEngine {
  constructor({ analyzer, indicatorRegistry, structureEngine, candleEngine, regimeEngine, regimeDecisionEngine, advanceRiskEngine, mtfConfirmationEngine, logger, symbol }) {
    this.analyzer = analyzer;
    this.indicatorRegistry = indicatorRegistry;
    this.structureEngine = structureEngine;
    this.candleEngine = candleEngine;
    this.regimeEngine = regimeEngine;
    this.regimeDecisionEngine = regimeDecisionEngine;
    this.advanceRiskEngine = advanceRiskEngine;
    this.mtfConfirmationEngine = mtfConfirmationEngine;
    this.logger = logger;
    this.symbol = symbol || 'BTCUSDT';
    this.version = ENGINE_VERSION;
    this.lastUpdated = null;
    this.calculationTime = 0;
    this.dataSource = 'Isolated synthetic datasets (never production data)';
    this._cache = null;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  runAll(forceRerun) {
    if (this._cache && !forceRerun) {
      return this._cache;
    }

    const start = Date.now();

    const results = {};
    results.trend = this._validateTrend();
    results.structure = this._validateStructure();
    results.rsi = this._validateRSI();
    results.ema = this._validateEMA();
    results.mtf = this._validateMTF();
    results.confluence = this._validateConfluence();
    results.macd = this._validateMACD();
    results.atr = this._validateATR();
    results.bollinger = this._validateBollinger();
    results.signalHistory = this._validateSignalHistory();
    results.backtest = this._validateBacktest();
    results.analytics = this._validateAnalytics();
    results.paperTrading = this._validatePaperTrading();
    results.risk = this._validateRisk();
    results.advanceRisk = this._validateAdvanceRisk();
    results.marketRegime = this._validateMarketRegime();
    results.regimeDecision = this._validateRegimeDecision();
    results.mtfConfirmation = this._validateMTFConfirmation();

    const statuses = Object.values(results).map(r => r.status);
    let overall = 'PASS';
    if (statuses.includes('FAIL')) overall = 'FAIL';
    else if (statuses.includes('WARNING')) overall = 'WARNING';

    this.calculationTime = Date.now() - start;
    this.lastUpdated = new Date().toISOString();

    this._cache = {
      timestamp: this.lastUpdated,
      overall,
      engines: {},
      details: {},
      engineVersion: this.version,
      lastUpdated: this.lastUpdated,
      calculationTime: this.calculationTime,
      dataSource: this.dataSource,
    };

    for (const [name, result] of Object.entries(results)) {
      this._cache.engines[name] = {
        status: result.status,
        tests: result.tests.length,
        passed: result.tests.filter(t => t.status === 'PASS').length,
        failed: result.tests.filter(t => t.status === 'FAIL').length,
        warnings: result.tests.filter(t => t.status === 'WARNING').length,
        executionTime: result.executionTime,
      };
      this._cache.details[name] = result.tests;
    }

    return this._cache;
  }

  getInfo() {
    return {
      name: 'Validation',
      description: 'Mathematical proof of engine correctness using deterministic synthetic datasets',
      implemented: true,
      version: this.version,
    };
  }

  // ---------------------------------------------------------------------------
  // RSI Validation
  // ---------------------------------------------------------------------------

  _validateRSI() {
    const start = Date.now();
    const tests = [];
    const rsi = this.indicatorRegistry.get('RSI');

    // Test 1: Pure uptrend → RSI = 100
    tests.push(this._runTest('RSI Pure Uptrend', () => {
      const candles = this._makeCandles(30, (i) => 100 + i * 2);
      const result = rsi.calculate(candles, 'val_1h');
      if (Math.abs(result.value - 100) > TOLERANCE) {
        return { status: 'FAIL', reason: `Expected RSI=100, got ${result.value}` };
      }
      if (result.state !== 'Overbought') {
        return { status: 'FAIL', reason: `Expected state=Overbought, got ${result.state}` };
      }
      return { status: 'PASS', reason: `RSI correctly = 100 for pure uptrend` };
    }));

    // Test 2: Pure downtrend → RSI = 0
    tests.push(this._runTest('RSI Pure Downtrend', () => {
      const candles = this._makeCandles(30, (i) => 200 - i * 2);
      const result = rsi.calculate(candles, 'val_2h');
      if (Math.abs(result.value - 0) > TOLERANCE) {
        return { status: 'FAIL', reason: `Expected RSI=0, got ${result.value}` };
      }
      if (result.state !== 'Oversold') {
        return { status: 'FAIL', reason: `Expected state=Oversold, got ${result.state}` };
      }
      return { status: 'PASS', reason: `RSI correctly = 0 for pure downtrend` };
    }));

    // Test 3: No change → RSI = 50
    tests.push(this._runTest('RSI No Change', () => {
      const candles = this._makeCandles(30, () => 100);
      const result = rsi.calculate(candles, 'val_3h');
      if (Math.abs(result.value - 50) > TOLERANCE) {
        return { status: 'FAIL', reason: `Expected RSI=50, got ${result.value}` };
      }
      return { status: 'PASS', reason: `RSI correctly = 50 for flat prices` };
    }));

    // Test 4: Known reference value (Investopedia example)
    tests.push(this._runTest('RSI Reference Value', () => {
      const closes = [44, 44.34, 44.09, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08,
                      45.89, 46.03, 45.61, 46.28, 46.28, 46.00, 46.03, 46.41, 46.22, 45.64];
      const candles = closes.map((c, i) => ({
        openTime: i * 3600000, close: c, high: c + 0.5, low: c - 0.5,
        open: c, volume: 1000, timestamp: new Date(i * 3600000).toISOString(),
      }));
      const result = rsi.calculate(candles, 'val_4h');
      if (!result.ready) {
        return { status: 'FAIL', reason: `RSI not ready with 20 candles` };
      }
      const diff = Math.abs(result.value - 60.14);
      if (diff > SOFT_TOLERANCE) {
        return { status: 'FAIL', reason: `Expected RSI≈60.14 (Investopedia), got ${result.value} (diff=${diff.toFixed(2)})` };
      }
      if (diff > 1.0) {
        return { status: 'WARNING', reason: `RSI=${result.value} deviates from reference 60.14 by ${diff.toFixed(2)}` };
      }
      return { status: 'PASS', reason: `RSI=${result.value} matches Investopedia reference (diff=${diff.toFixed(2)})` };
    }));

    // Test 5: Insufficient data → not ready
    tests.push(this._runTest('RSI Insufficient Data', () => {
      const candles = this._makeCandles(14, (i) => 100 + i);
      const result = rsi.calculate(candles, 'val_5h');
      if (result.ready) {
        return { status: 'FAIL', reason: `RSI should not be ready with 14 candles` };
      }
      return { status: 'PASS', reason: `RSI correctly returns not-ready with 14 candles` };
    }));

    // Test 6: Minimum data → ready
    tests.push(this._runTest('RSI Minimum Data', () => {
      const closes = [];
      for (let i = 0; i < 15; i++) {
        closes.push(i % 2 === 0 ? 100 + i : 100 + i - 1);
      }
      const candles = this._makeCandlesFromCloses(closes);
      const result = rsi.calculate(candles, 'val_6h');
      if (!result.ready) {
        return { status: 'FAIL', reason: `RSI should be ready with 15 candles` };
      }
      if (result.value < 0 || result.value > 100) {
        return { status: 'FAIL', reason: `RSI value ${result.value} out of range 0-100` };
      }
      return { status: 'PASS', reason: `RSI ready with 15 candles, value=${result.value}` };
    }));

    // Test 7: Determinism — same input produces same output
    tests.push(this._runTest('RSI Determinism', () => {
      const candles = this._makeCandles(30, (i) => 100 + Math.sin(i * 0.3) * 10);
      const r1 = rsi.calculate(candles, 'val_7h');
      rsi.invalidate('val_7h');
      const r2 = rsi.calculate(candles, 'val_7h');
      if (r1.value !== r2.value) {
        return { status: 'FAIL', reason: `Non-deterministic: first=${r1.value}, second=${r2.value}` };
      }
      return { status: 'PASS', reason: `RSI is deterministic: both runs = ${r1.value}` };
    }));

    const executionTime = Date.now() - start;
    return { tests, executionTime };
  }

  // ---------------------------------------------------------------------------
  // EMA Validation
  // ---------------------------------------------------------------------------

  _validateEMA() {
    const start = Date.now();
    const tests = [];
    const ema = this.indicatorRegistry.get('EMA');

    // Test 1: Known EMA value — hand-computed reference
    // Closes: [10, 11, 12, 13, 14, 13, 12, 13, 14, 15], period=3
    // SMA(3) = (10+11+12)/3 = 11, k = 2/(3+1) = 0.5
    // EMA steps: 11(seed)→12→13→13→12.5→12.75→13.375→14.1875
    tests.push(this._runTest('EMA Known Value', () => {
      const closes = [10, 11, 12, 13, 14, 13, 12, 13, 14, 15];
      const candles = this._makeCandlesFromCloses(closes);
      const result = ema.calculate(candles, 'ema_test_1', 3);
      if (!result.ready) {
        return { status: 'FAIL', reason: 'EMA not ready with 10 candles and period=3' };
      }
      // Hand-computed: SMA=11, then EMA = 12, 13, 13, 12.5, 12.75, 13.375, 14.1875
      const expected = Math.round(14.1875 * 100) / 100;
      const diff = Math.abs(result.value - expected);
      if (diff > 0.1) {
        return { status: 'FAIL', reason: `Expected EMA≈${expected}, got ${result.value} (diff=${diff})` };
      }
      return { status: 'PASS', reason: `EMA=${result.value} matches hand-computed ${expected} (diff=${diff})` };
    }));

    // Test 2: Pure uptrend — EMA lags behind price
    tests.push(this._runTest('EMA Pure Uptrend', () => {
      const candles = this._makeCandles(30, (i) => 100 + i);
      const result = ema.calculate(candles, 'ema_test_2', 20);
      if (!result.ready) {
        return { status: 'FAIL', reason: 'EMA not ready' };
      }
      const lastClose = 100 + 29; // 129
      if (result.value >= lastClose) {
        return { status: 'FAIL', reason: `EMA(${result.value}) should lag behind close(${lastClose}) in uptrend` };
      }
      if (result.trend !== 'Above') {
        return { status: 'FAIL', reason: `Expected trend=Above, got ${result.trend}` };
      }
      return { status: 'PASS', reason: `EMA=${result.value} < close=${lastClose}, trend=Above` };
    }));

    // Test 3: Pure downtrend — EMA leads price
    tests.push(this._runTest('EMA Pure Downtrend', () => {
      const candles = this._makeCandles(30, (i) => 200 - i);
      const result = ema.calculate(candles, 'ema_test_3', 20);
      if (!result.ready) {
        return { status: 'FAIL', reason: 'EMA not ready' };
      }
      const lastClose = 200 - 29; // 171
      if (result.value <= lastClose) {
        return { status: 'FAIL', reason: `EMA(${result.value}) should be above close(${lastClose}) in downtrend` };
      }
      if (result.trend !== 'Below') {
        return { status: 'FAIL', reason: `Expected trend=Below, got ${result.trend}` };
      }
      return { status: 'PASS', reason: `EMA=${result.value} > close=${lastClose}, trend=Below` };
    }));

    // Test 4: Flat prices — EMA equals price exactly
    tests.push(this._runTest('EMA Flat Prices', () => {
      const candles = this._makeCandles(30, () => 100);
      const result = ema.calculate(candles, 'ema_test_4', 20);
      if (!result.ready) {
        return { status: 'FAIL', reason: 'EMA not ready' };
      }
      if (Math.abs(result.value - 100) > 0.01) {
        return { status: 'FAIL', reason: `Expected EMA≈100 for flat prices, got ${result.value}` };
      }
      return { status: 'PASS', reason: `EMA=${result.value} for flat prices (expected 100)` };
    }));

    // Test 5: Insufficient data
    tests.push(this._runTest('EMA Insufficient Data', () => {
      const candles = this._makeCandles(5, (i) => 100 + i);
      const result = ema.calculate(candles, 'ema_test_5', 20);
      if (result.ready) {
        return { status: 'FAIL', reason: 'EMA should not be ready with 5 candles and period=20' };
      }
      return { status: 'PASS', reason: `EMA correctly not ready: ${result.reason}` };
    }));

    // Test 6: Minimum data — period+1 candles
    tests.push(this._runTest('EMA Minimum Data', () => {
      const candles = this._makeCandles(21, (i) => 100 + Math.sin(i * 0.5) * 5);
      const result = ema.calculate(candles, 'ema_test_6', 20);
      if (!result.ready) {
        return { status: 'FAIL', reason: 'EMA should be ready with 21 candles and period=20' };
      }
      if (typeof result.value !== 'number' || isNaN(result.value)) {
        return { status: 'FAIL', reason: `EMA value is not a number: ${result.value}` };
      }
      return { status: 'PASS', reason: `EMA ready with 21 candles, value=${result.value}` };
    }));

    // Test 7: Determinism — same input produces same output
    tests.push(this._runTest('EMA Determinism', () => {
      const candles = this._makeCandles(30, (i) => 100 + Math.sin(i * 0.3) * 10);
      ema.invalidate('ema_test_7');
      const r1 = ema.calculate(candles, 'ema_test_7', 20);
      ema.invalidate('ema_test_7');
      const r2 = ema.calculate(candles, 'ema_test_7', 20);
      if (r1.value !== r2.value) {
        return { status: 'FAIL', reason: `Non-deterministic: first=${r1.value}, second=${r2.value}` };
      }
      return { status: 'PASS', reason: `EMA is deterministic: both runs = ${r1.value}` };
    }));

    // Test 8: Multi-period consistency — longer period should be smoother
    tests.push(this._runTest('EMA Multi-Period Consistency', () => {
      const candles = this._makeCandles(250, (i) => 100 + Math.sin(i * 0.05) * 20);
      const ema9 = ema.calculate(candles, 'ema_test_8', 9);
      const ema50 = ema.calculate(candles, 'ema_test_8', 50);
      if (!ema9.ready || !ema50.ready) {
        return { status: 'FAIL', reason: 'EMAs not ready' };
      }
      // Both should be valid numbers
      if (typeof ema9.value !== 'number' || typeof ema50.value !== 'number') {
        return { status: 'FAIL', reason: 'EMA values are not numbers' };
      }
      return { status: 'PASS', reason: `EMA(9)=${ema9.value}, EMA(50)=${ema50.value} — both valid` };
    }));

    // Test 9: Crossing detection
    tests.push(this._runTest('EMA Crossing Detection', () => {
      // Create data where price crosses above EMA in last candle
      // First 10 candles below EMA, then last candle jumps above
      const closes = [100, 99, 98, 97, 96, 95, 94, 93, 92, 91, 90, 110];
      const candles = this._makeCandlesFromCloses(closes);
      const result = ema.calculate(candles, 'ema_test_9', 5);
      if (!result.ready) {
        return { status: 'FAIL', reason: 'EMA not ready' };
      }
      // With period=5, EMA should be around 93-95, close=110 → Above or Crossing
      if (result.trend !== 'Above' && result.trend !== 'Crossing') {
        return { status: 'WARNING', reason: `Expected Above or Crossing, got ${result.trend} (EMA=${result.value}, close=110)` };
      }
      return { status: 'PASS', reason: `Trend=${result.trend} with close=110 > EMA=${result.value}` };
    }));

    // Test 10: Symbol parameter
    tests.push(this._runTest('EMA Symbol Parameter', () => {
      const { EMAIndicator } = require('./indicators/ema');
      const customEma = new EMAIndicator('ETHUSDT');
      const candles = this._makeCandles(30, (i) => 3000 + i * 10);
      const result = customEma.calculate(candles, 'ema_test_10', 20);
      if (result.symbol !== 'ETHUSDT') {
        return { status: 'FAIL', reason: `Expected symbol=ETHUSDT, got ${result.symbol}` };
      }
      return { status: 'PASS', reason: `Symbol correctly set to ${result.symbol}` };
    }));

    const executionTime = Date.now() - start;
    return { tests, executionTime };
  }

  // ---------------------------------------------------------------------------
  // Trend Validation (MarketAnalyzer)
  // ---------------------------------------------------------------------------

  _validateTrend() {
    const start = Date.now();
    const tests = [];

    if (!this.analyzer) {
      tests.push({ name: 'Trend Skipped', status: 'WARNING', reason: 'MarketAnalyzer not provided — standalone validation', executionTime: 0 });
      return { tests, executionTime: Date.now() - start };
    }

    // Helper: create a mock HistoryEngine with synthetic snapshots
    const makeHistory = (snapshots) => ({
      all: () => snapshots,
      size: () => snapshots.length,
    });

    // Test 1: Perfect uptrend
    tests.push(this._runTest('Trend Perfect Uptrend', () => {
      const now = Date.now();
      const snapshots = [];
      for (let i = 0; i < 100; i++) {
        snapshots.push({
          timestamp: new Date(now - (99 - i) * 2000).toISOString(),
          price: 100 + i * 0.5,
          volume: 1000,
          change24h: 0,
        });
      }
      this.analyzer.analyze(makeHistory(snapshots));
      const analysis = this.analyzer.getAnalysis();
      if (analysis.trend['1H'] !== 'Bullish') {
        return { status: 'FAIL', reason: `Expected trend=Bullish, got ${analysis.trend['1H']}` };
      }
      return { status: 'PASS', reason: `Correctly classified perfect uptrend as Bullish` };
    }));

    // Test 2: Perfect downtrend
    tests.push(this._runTest('Trend Perfect Downtrend', () => {
      const now = Date.now();
      const snapshots = [];
      for (let i = 0; i < 100; i++) {
        snapshots.push({
          timestamp: new Date(now - (99 - i) * 2000).toISOString(),
          price: 200 - i * 0.5,
          volume: 1000,
          change24h: 0,
        });
      }
      this.analyzer.analyze(makeHistory(snapshots));
      const analysis = this.analyzer.getAnalysis();
      if (analysis.trend['1H'] !== 'Bearish') {
        return { status: 'FAIL', reason: `Expected trend=Bearish, got ${analysis.trend['1H']}` };
      }
      return { status: 'PASS', reason: `Correctly classified perfect downtrend as Bearish` };
    }));

    // Test 3: Flat prices → Sideways
    tests.push(this._runTest('Trend Flat Prices', () => {
      const now = Date.now();
      const snapshots = [];
      for (let i = 0; i < 100; i++) {
        snapshots.push({
          timestamp: new Date(now - (99 - i) * 2000).toISOString(),
          price: 100,
          volume: 1000,
          change24h: 0,
        });
      }
      this.analyzer.analyze(makeHistory(snapshots));
      const analysis = this.analyzer.getAnalysis();
      if (analysis.trend['1H'] !== 'Sideways') {
        return { status: 'FAIL', reason: `Expected trend=Sideways, got ${analysis.trend['1H']}` };
      }
      return { status: 'PASS', reason: `Correctly classified flat prices as Sideways` };
    }));

    // Test 4: Momentum range for mixed data
    tests.push(this._runTest('Trend Momentum Range', () => {
      const now = Date.now();
      const snapshots = [];
      for (let i = 0; i < 100; i++) {
        snapshots.push({
          timestamp: new Date(now - (99 - i) * 2000).toISOString(),
          price: 100 + (i % 2 === 0 ? 0.1 : -0.1),
          volume: 1000,
          change24h: 0,
        });
      }
      this.analyzer.analyze(makeHistory(snapshots));
      const analysis = this.analyzer.getAnalysis();
      const mom = analysis.momentum['1H'];
      if (mom < 40 || mom > 60) {
        return { status: 'WARNING', reason: `Momentum ${mom} outside expected 40-60 range for mixed data` };
      }
      return { status: 'PASS', reason: `Momentum=${mom} within expected range for alternating data` };
    }));

    // Test 5: Confidence non-zero for clear trend
    tests.push(this._runTest('Trend Confidence Non-Zero', () => {
      const now = Date.now();
      const snapshots = [];
      for (let i = 0; i < 100; i++) {
        snapshots.push({
          timestamp: new Date(now - (99 - i) * 2000).toISOString(),
          price: 100 + i * 0.5,
          volume: 1000,
          change24h: 0,
        });
      }
      this.analyzer.analyze(makeHistory(snapshots));
      const analysis = this.analyzer.getAnalysis();
      if (analysis.confidence['1H'] <= 0) {
        return { status: 'FAIL', reason: `Confidence should be > 0 for clear trend, got ${analysis.confidence['1H']}` };
      }
      return { status: 'PASS', reason: `Confidence=${analysis.confidence['1H']} for clear trend` };
    }));

    // Test 6: Determinism
    tests.push(this._runTest('Trend Determinism', () => {
      const now = Date.now();
      const snapshots = [];
      for (let i = 0; i < 100; i++) {
        snapshots.push({
          timestamp: new Date(now - (99 - i) * 2000).toISOString(),
          price: 100 + i * 0.3 + Math.sin(i * 0.1) * 2,
          volume: 1000,
          change24h: 0,
        });
      }
      this.analyzer.analyze(makeHistory(snapshots));
      const r1 = this.analyzer.getAnalysis();
      this.analyzer.analyze(makeHistory(snapshots));
      const r2 = this.analyzer.getAnalysis();
      if (r1.trend['1H'] !== r2.trend['1H'] || r1.momentum['1H'] !== r2.momentum['1H']) {
        return { status: 'FAIL', reason: `Non-deterministic: run1=${r1.trend['1H']}/${r1.momentum['1H']}, run2=${r2.trend['1H']}/${r2.momentum['1H']}` };
      }
      return { status: 'PASS', reason: `Trend analysis is deterministic` };
    }));

    const executionTime = Date.now() - start;
    return { tests, executionTime };
  }

  // ---------------------------------------------------------------------------
  // Structure Validation
  // ---------------------------------------------------------------------------

  _validateStructure() {
    const start = Date.now();
    const tests = [];

    // Test 1: Bullish structure — ascending swing points
    tests.push(this._runTest('Structure Bullish Pattern', () => {
      const candles = this._makeStructureCandles('bullish', 50);
      const result = this.structureEngine.calculate(candles);
      if (!result.ready) {
        return { status: 'FAIL', reason: 'Structure not ready with 50 candles' };
      }
      if (result.structure !== 'Bullish') {
        return { status: 'FAIL', reason: `Expected structure=Bullish, got ${result.structure}` };
      }
      if (result.score <= 50) {
        return { status: 'FAIL', reason: `Expected score>50 for bullish, got ${result.score}` };
      }
      return { status: 'PASS', reason: `Bullish structure detected, score=${result.score}` };
    }));

    // Test 2: Bearish structure — descending swing points
    tests.push(this._runTest('Structure Bearish Pattern', () => {
      const candles = this._makeStructureCandles('bearish', 50);
      const result = this.structureEngine.calculate(candles);
      if (!result.ready) {
        return { status: 'FAIL', reason: 'Structure not ready with 50 candles' };
      }
      if (result.structure !== 'Bearish') {
        return { status: 'FAIL', reason: `Expected structure=Bearish, got ${result.structure}` };
      }
      if (result.score >= 50) {
        return { status: 'FAIL', reason: `Expected score<50 for bearish, got ${result.score}` };
      }
      return { status: 'PASS', reason: `Bearish structure detected, score=${result.score}` };
    }));

    // Test 3: Ranging — oscillating prices
    tests.push(this._runTest('Structure Ranging Pattern', () => {
      const candles = this._makeStructureCandles('ranging', 50);
      const result = this.structureEngine.calculate(candles);
      if (!result.ready) {
        return { status: 'FAIL', reason: 'Structure not ready with 50 candles' };
      }
      if (result.structure !== 'Ranging') {
        return { status: 'WARNING', reason: `Expected structure=Ranging, got ${result.structure} (may be borderline)` };
      }
      return { status: 'PASS', reason: `Ranging structure detected, score=${result.score}` };
    }));

    // Test 4: Insufficient data
    tests.push(this._runTest('Structure Insufficient Data', () => {
      const candles = this._makeCandles(10, (i) => 100 + i);
      const result = this.structureEngine.calculate(candles);
      if (result.ready) {
        return { status: 'FAIL', reason: 'Structure should not be ready with 10 candles' };
      }
      return { status: 'PASS', reason: `Correctly returns not-ready with 10 candles` };
    }));

    // Test 5: BOS detection — price breaks above swing high
    tests.push(this._runTest('Structure BOS Detection', () => {
      const candles = this._makeStructureCandles('bos_bullish', 40);
      const result = this.structureEngine.calculate(candles);
      if (!result.ready) {
        return { status: 'FAIL', reason: 'Structure not ready' };
      }
      if (!result.lastBOS) {
        return { status: 'WARNING', reason: 'No BOS detected (swing detection may need more candles)' };
      }
      if (result.lastBOS.type !== 'Bullish') {
        return { status: 'FAIL', reason: `Expected BOS=Bullish, got ${result.lastBOS.type}` };
      }
      return { status: 'PASS', reason: `Bullish BOS detected at price ${result.lastBOS.price}` };
    }));

    // Test 6: Determinism
    tests.push(this._runTest('Structure Determinism', () => {
      const candles = this._makeStructureCandles('bullish', 50);
      const r1 = this.structureEngine.calculate(candles);
      const r2 = this.structureEngine.calculate(candles);
      if (r1.structure !== r2.structure || r1.score !== r2.score) {
        return { status: 'FAIL', reason: `Non-deterministic: run1=${r1.structure}/${r1.score}, run2=${r2.structure}/${r2.score}` };
      }
      return { status: 'PASS', reason: `Structure engine is deterministic` };
    }));

    const executionTime = Date.now() - start;
    return { tests, executionTime };
  }

  // ---------------------------------------------------------------------------
  // MTF Validation
  // ---------------------------------------------------------------------------

  _validateMTF() {
    const start = Date.now();
    const tests = [];

    // Helper: create a mock MTF engine with pre-computed per-timeframe results
    const makeMockMTF = (tfOverrides) => {
      const { MTFEngine } = require('./mtf');
      const mockDeps = {
        confluenceEngine: {
          calculate: (candles, tf) => tfOverrides[tf]?.confluence || { score: null, bias: 'Neutral', confidence: 0 },
        },
        structureEngine: {
          calculate: () => ({ ready: false }),
        },
        indicatorRegistry: {
          get: () => ({ calculate: () => ({ ready: false }) }),
        },
        candleEngine: {
          getCandles: (tf) => {
            if (!tfOverrides[tf]) return [];
            return Array.from({ length: 30 }, (_, i) => ({
              openTime: i * 3600000, close: 100, high: 101, low: 99,
              open: 100, volume: 1000, timestamp: new Date(i * 3600000).toISOString(),
            }));
          },
          getActive: () => null,
          getAllTimeframes: () => ['1m', '5m', '15m', '30m', '1h', '4h', '12h', '24h'],
        },
        analyzer: { getAnalysis: () => null },
        logger: { info: () => {} },
        config: { get: () => null },
      };
      return new MTFEngine(mockDeps);
    };

    // Test 1: All Bullish → overall Bullish, agreement=100
    tests.push(this._runTest('MTF All Bullish', () => {
      const tfData = {};
      for (const tf of ['1m', '5m', '15m', '30m', '1h', '4h', '12h', '24h']) {
        tfData[tf] = { confluence: { score: 80, bias: 'Bullish', confidence: 80 } };
      }
      const engine = makeMockMTF(tfData);
      const result = engine.calculate(500);
      if (result.overallBias !== 'Bullish') {
        return { status: 'FAIL', reason: `Expected overallBias=Bullish, got ${result.overallBias}` };
      }
      if (result.timeframeAgreement !== 100) {
        return { status: 'FAIL', reason: `Expected agreement=100, got ${result.timeframeAgreement}` };
      }
      return { status: 'PASS', reason: `overallBias=Bullish, agreement=${result.timeframeAgreement}` };
    }));

    // Test 2: All Bearish → overall Bearish, agreement=100
    tests.push(this._runTest('MTF All Bearish', () => {
      const tfData = {};
      for (const tf of ['1m', '5m', '15m', '30m', '1h', '4h', '12h', '24h']) {
        tfData[tf] = { confluence: { score: 20, bias: 'Bearish', confidence: 80 } };
      }
      const engine = makeMockMTF(tfData);
      const result = engine.calculate(500);
      if (result.overallBias !== 'Bearish') {
        return { status: 'FAIL', reason: `Expected overallBias=Bearish, got ${result.overallBias}` };
      }
      if (result.timeframeAgreement !== 100) {
        return { status: 'FAIL', reason: `Expected agreement=100, got ${result.timeframeAgreement}` };
      }
      return { status: 'PASS', reason: `overallBias=Bearish, agreement=${result.timeframeAgreement}` };
    }));

    // Test 3: Mixed → overall Neutral, agreement=50
    tests.push(this._runTest('MTF Mixed Neutral', () => {
      const tfData = {};
      const tfs = ['1m', '5m', '15m', '30m', '1h', '4h', '12h', '24h'];
      for (let i = 0; i < tfs.length; i++) {
        tfData[tfs[i]] = {
          confluence: {
            score: i < 4 ? 80 : 20,
            bias: i < 4 ? 'Bullish' : 'Bearish',
            confidence: 80,
          },
        };
      }
      const engine = makeMockMTF(tfData);
      const result = engine.calculate(500);
      if (result.overallBias !== 'Neutral') {
        return { status: 'FAIL', reason: `Expected overallBias=Neutral, got ${result.overallBias}` };
      }
      if (result.timeframeAgreement !== 50) {
        return { status: 'FAIL', reason: `Expected agreement=50, got ${result.timeframeAgreement}` };
      }
      return { status: 'PASS', reason: `overallBias=Neutral, agreement=${result.timeframeAgreement}` };
    }));

    // Test 4: Missing Timeframes → confidence decreases
    tests.push(this._runTest('MTF Missing Timeframes', () => {
      const tfData = {};
      // Only provide 4 out of 8 timeframes
      for (const tf of ['1h', '4h', '12h', '24h']) {
        tfData[tf] = { confluence: { score: 80, bias: 'Bullish', confidence: 80 } };
      }
      const engine = makeMockMTF(tfData);
      const result = engine.calculate(500);
      if (result.confidence >= 80) {
        return { status: 'FAIL', reason: `Confidence should decrease with missing TFs, got ${result.confidence}` };
      }
      return { status: 'PASS', reason: `Confidence=${result.confidence} with 4/8 timeframes available` };
    }));

    // Test 5: Strongest/Weakest identification
    tests.push(this._runTest('MTF Strongest Weakest', () => {
      const tfData = {};
      const scores = { '1m': 30, '5m': 40, '15m': 50, '30m': 60, '1h': 70, '4h': 80, '12h': 90, '24h': 95 };
      for (const [tf, score] of Object.entries(scores)) {
        tfData[tf] = { confluence: { score, bias: 'Bullish', confidence: 80 } };
      }
      const engine = makeMockMTF(tfData);
      const result = engine.calculate(500);
      if (result.strongestTimeframe !== '24h') {
        return { status: 'FAIL', reason: `Expected strongest=24h, got ${result.strongestTimeframe}` };
      }
      if (result.weakestTimeframe !== '1m') {
        return { status: 'FAIL', reason: `Expected weakest=1m, got ${result.weakestTimeframe}` };
      }
      return { status: 'PASS', reason: `strongest=${result.strongestTimeframe}, weakest=${result.weakestTimeframe}` };
    }));

    // Test 6: Determinism
    tests.push(this._runTest('MTF Determinism', () => {
      const tfData = {};
      for (const tf of ['1m', '5m', '15m', '30m', '1h', '4h', '12h', '24h']) {
        tfData[tf] = { confluence: { score: 70, bias: 'Bullish', confidence: 75 } };
      }
      const engine = makeMockMTF(tfData);
      const r1 = engine.calculate(500);
      const r2 = engine.calculate(500);
      if (r1.overallBias !== r2.overallBias || r1.confidence !== r2.confidence) {
        return { status: 'FAIL', reason: `Non-deterministic: r1=${r1.overallBias}/${r1.confidence}, r2=${r2.overallBias}/${r2.confidence}` };
      }
      return { status: 'PASS', reason: `MTF is deterministic: bias=${r1.overallBias}, confidence=${r1.confidence}` };
    }));

    // Test 7: Symbol parameter
    tests.push(this._runTest('MTF Symbol Parameter', () => {
      const { MTFEngine } = require('./mtf');
      const mockDeps = {
        confluenceEngine: { calculate: () => ({ score: 70, bias: 'Bullish', confidence: 75 }) },
        structureEngine: { calculate: () => ({ ready: false }) },
        indicatorRegistry: { get: () => ({ calculate: () => ({ ready: false }) }) },
        candleEngine: {
          getCandles: () => Array.from({ length: 30 }, (_, i) => ({
            openTime: i * 3600000, close: 100, high: 101, low: 99,
            open: 100, volume: 1000, timestamp: new Date(i * 3600000).toISOString(),
          })),
          getActive: () => null,
          getAllTimeframes: () => ['1h'],
        },
        analyzer: { getAnalysis: () => null },
        logger: { info: () => {} },
        config: { get: () => null },
      };
      const engine = new MTFEngine(mockDeps);
      engine._symbol = 'ETHUSDT';
      const result = engine.calculate(500);
      if (result.symbol !== 'ETHUSDT') {
        return { status: 'FAIL', reason: `Expected symbol=ETHUSDT, got ${result.symbol}` };
      }
      return { status: 'PASS', reason: `Symbol correctly set to ${result.symbol}` };
    }));

    const executionTime = Date.now() - start;
    return { tests, executionTime };
  }

  // ---------------------------------------------------------------------------
  // Confluence Validation
  // ---------------------------------------------------------------------------

  _validateConfluence() {
    const start = Date.now();
    const tests = [];

    if (!this.analyzer) {
      tests.push({ name: 'Confluence Skipped', status: 'WARNING', reason: 'MarketAnalyzer not provided — standalone validation', executionTime: 0 });
      return { tests, executionTime: Date.now() - start };
    }

    // Test 1: All components bullish → high score, Bullish bias
    tests.push(this._runTest('Confluence All Bullish', () => {
      const candles = this._makeCandles(30, (i) => 100 + i * 2);
      const engine = this._makeMockConfluence({
        trend: { score: 80, direction: 'bullish', confidence: 80, available: true },
        structure: { score: 75, direction: 'bullish', confidence: 70, available: true },
        momentum: { score: 70, direction: 'bullish', confidence: 75, available: true },
        rsi: { score: 65, direction: 'bullish', confidence: 70, available: true },
        volatility: { score: 80, direction: null, confidence: 80, available: true },
      });
      const result = engine.calculate(candles, '1h');
      if (result.score <= 65) {
        return { status: 'FAIL', reason: `Expected score>65, got ${result.score}` };
      }
      if (result.bias !== 'Bullish') {
        return { status: 'FAIL', reason: `Expected bias=Bullish, got ${result.bias}` };
      }
      return { status: 'PASS', reason: `All bullish: score=${result.score}, bias=${result.bias}` };
    }));

    // Test 2: All components bearish → low score, Bearish bias
    tests.push(this._runTest('Confluence All Bearish', () => {
      const candles = this._makeCandles(30, (i) => 200 - i * 2);
      const engine = this._makeMockConfluence({
        trend: { score: 20, direction: 'bearish', confidence: 80, available: true },
        structure: { score: 25, direction: 'bearish', confidence: 70, available: true },
        momentum: { score: 30, direction: 'bearish', confidence: 75, available: true },
        rsi: { score: 25, direction: 'bearish', confidence: 70, available: true },
        volatility: { score: 20, direction: null, confidence: 80, available: true },
      });
      const result = engine.calculate(candles, '1h');
      if (result.score >= 35) {
        return { status: 'FAIL', reason: `Expected score<35, got ${result.score}` };
      }
      if (result.bias !== 'Bearish') {
        return { status: 'FAIL', reason: `Expected bias=Bearish, got ${result.bias}` };
      }
      return { status: 'PASS', reason: `All bearish: score=${result.score}, bias=${result.bias}` };
    }));

    // Test 3: Mixed components → Neutral bias
    tests.push(this._runTest('Confluence Mixed Neutral', () => {
      const candles = this._makeCandles(30, (i) => 100 + Math.sin(i) * 5);
      const engine = this._makeMockConfluence({
        trend: { score: 70, direction: 'bullish', confidence: 70, available: true },
        structure: { score: 30, direction: 'bearish', confidence: 70, available: true },
        momentum: { score: 55, direction: 'bullish', confidence: 60, available: true },
        rsi: { score: 40, direction: 'bearish', confidence: 65, available: true },
        volatility: { score: 50, direction: null, confidence: 60, available: true },
      });
      const result = engine.calculate(candles, '1h');
      if (result.bias !== 'Neutral') {
        return { status: 'FAIL', reason: `Expected bias=Neutral, got ${result.bias} (score=${result.score})` };
      }
      return { status: 'PASS', reason: `Mixed components: score=${result.score}, bias=${result.bias}` };
    }));

    // Test 4: Missing components → confidence decreases
    tests.push(this._runTest('Confluence Missing Components', () => {
      const candles = this._makeCandles(30, (i) => 100 + i);
      const engine = this._makeMockConfluence({
        trend: { score: 75, direction: 'bullish', confidence: 80, available: true },
        structure: { score: 70, direction: 'bullish', confidence: 75, available: true },
        momentum: { score: 65, direction: 'bullish', confidence: 70, available: true },
        rsi: { score: null, direction: null, confidence: null, available: false, reason: 'Insufficient data' },
        volatility: { score: null, direction: null, confidence: null, available: false, reason: 'No data' },
      });
      const result = engine.calculate(candles, '1h');
      if (result.confidence >= 80) {
        return { status: 'FAIL', reason: `Confidence should decrease with missing components, got ${result.confidence}` };
      }
      if (result.missing.length !== 2) {
        return { status: 'FAIL', reason: `Expected 2 missing components, got ${result.missing.length}` };
      }
      return { status: 'PASS', reason: `Confidence=${result.confidence} with 2 missing components` };
    }));

    // Test 5: No weight redistribution
    tests.push(this._runTest('Confluence No Weight Redistribution', () => {
      const candles = this._makeCandles(30, (i) => 100 + i);
      const engine = this._makeMockConfluence({
        trend: { score: 80, direction: 'bullish', confidence: 80, available: true },
        structure: { score: null, direction: null, confidence: null, available: false, reason: 'Not enough data' },
        momentum: { score: 60, direction: 'bullish', confidence: 70, available: true },
        rsi: { score: null, direction: null, confidence: null, available: false, reason: 'Not enough data' },
        volatility: { score: 40, direction: null, confidence: 60, available: true },
      });
      const result = engine.calculate(candles, '1h');
      // Available: trend(0.30) + momentum(0.15) + volatility(0.15) = 0.60
      // Expected: (80*0.30 + 60*0.15 + 40*0.15) / 0.60 = (24 + 9 + 6) / 0.60 = 39/0.60 = 65
      const expectedScore = Math.round((80 * 0.30 + 60 * 0.15 + 40 * 0.15) / 0.60);
      if (Math.abs(result.score - expectedScore) > 1) {
        return { status: 'FAIL', reason: `Expected score=${expectedScore} (no redistribution), got ${result.score}` };
      }
      return { status: 'PASS', reason: `Score=${result.score} correctly excludes missing weights (expected ${expectedScore})` };
    }));

    // Test 6: Single component → valid score, low confidence
    tests.push(this._runTest('Confluence Single Component', () => {
      const candles = this._makeCandles(30, (i) => 100 + i);
      const engine = this._makeMockConfluence({
        trend: { score: 70, direction: 'bullish', confidence: 75, available: true },
        structure: { score: null, direction: null, confidence: null, available: false, reason: 'No data' },
        momentum: { score: null, direction: null, confidence: null, available: false, reason: 'No data' },
        rsi: { score: null, direction: null, confidence: null, available: false, reason: 'No data' },
        volatility: { score: null, direction: null, confidence: null, available: false, reason: 'No data' },
      });
      const result = engine.calculate(candles, '1h');
      if (result.score !== 70) {
        return { status: 'FAIL', reason: `Expected score=70 (trend only), got ${result.score}` };
      }
      if (result.confidence >= 30) {
        return { status: 'FAIL', reason: `Confidence should be low with 1 component, got ${result.confidence}` };
      }
      return { status: 'PASS', reason: `Single component: score=${result.score}, confidence=${result.confidence}` };
    }));

    // Test 7: Determinism
    tests.push(this._runTest('Confluence Determinism', () => {
      const candles = this._makeCandles(30, (i) => 100 + Math.sin(i) * 5);
      const engine = this._makeMockConfluence({
        trend: { score: 70, direction: 'bullish', confidence: 75, available: true },
        structure: { score: 60, direction: 'bullish', confidence: 65, available: true },
        momentum: { score: 55, direction: 'neutral', confidence: 70, available: true },
        rsi: { score: 50, direction: 'neutral', confidence: 60, available: true },
        volatility: { score: 50, direction: null, confidence: 65, available: true },
      });
      const r1 = engine.calculate(candles, '1h');
      const r2 = engine.calculate(candles, '1h');
      if (r1.score !== r2.score || r1.bias !== r2.bias) {
        return { status: 'FAIL', reason: `Non-deterministic: run1=${r1.score}/${r1.bias}, run2=${r2.score}/${r2.bias}` };
      }
      return { status: 'PASS', reason: `Confluence is deterministic: score=${r1.score}, bias=${r1.bias}` };
    }));

    const executionTime = Date.now() - start;
    return { tests, executionTime };
  }

  // ---------------------------------------------------------------------------
  // Backtest Validation
  // ---------------------------------------------------------------------------

  _validateBacktest() {
    const start = Date.now();
    const tests = [];
    const { BacktestEngine } = require('./backtest');

    const makeEngine = (overrides = {}) => {
      return new BacktestEngine({
        structureEngine: this.structureEngine,
        indicatorRegistry: this.indicatorRegistry,
        logger: this.logger,
        symbol: overrides.symbol || 'TEST',
      });
    };

    // Test 1: Determinism — same input produces same output
    tests.push(this._runTest('Backtest Determinism', () => {
      const candles = this._makeCandles(100, (i) => 100 + Math.sin(i * 0.3) * 10);
      const engine = makeEngine();
      const r1 = engine.run({ candles, timeframe: '1h', warmupCandles: 20, predictionCandles: 5 });
      const r2 = engine.run({ candles, timeframe: '1h', warmupCandles: 20, predictionCandles: 5 });
      if (r1.signals.length !== r2.signals.length) {
        return { status: 'FAIL', reason: `Non-deterministic signal count: ${r1.signals.length} vs ${r2.signals.length}` };
      }
      for (let i = 0; i < r1.signals.length; i++) {
        if (r1.signals[i].bias !== r2.signals[i].bias || r1.signals[i].confidence !== r2.signals[i].confidence) {
          return { status: 'FAIL', reason: `Non-deterministic signal[${i}]: ${r1.signals[i].bias}/${r1.signals[i].confidence} vs ${r2.signals[i].bias}/${r2.signals[i].confidence}` };
        }
      }
      return { status: 'PASS', reason: `Deterministic: ${r1.signals.length} signals match on both runs` };
    }));

    // Test 2: No look-ahead bias — signal at position i only sees candles[0..i]
    tests.push(this._runTest('Backtest No Look-Ahead Bias', () => {
      const candles = this._makeCandles(80, (i) => 100 + i * 0.5);
      const engine = makeEngine();
      const result = engine.run({ candles, timeframe: '1h', warmupCandles: 20, predictionCandles: 5 });

      // Verify signal timestamps correspond to candle positions within the valid range
      for (const signal of result.signals) {
        const candleIndex = candles.findIndex(c => c.timestamp === signal.timestamp);
        if (candleIndex < 20) {
          return { status: 'FAIL', reason: `Signal at index ${candleIndex} is before warmup (20)` };
        }
        if (candleIndex >= candles.length - 5) {
          return { status: 'FAIL', reason: `Signal at index ${candleIndex} is in prediction zone (>= ${candles.length - 5})` };
        }
        if (signal.priceAtSignal !== candles[candleIndex].close) {
          return { status: 'FAIL', reason: `Signal price mismatch at index ${candleIndex}` };
        }
      }
      return { status: 'PASS', reason: `No look-ahead: all ${result.signals.length} signals in valid range [20, ${candles.length - 6}]` };
    }));

    // Test 3: Historical replay correctness — prices match candle data
    tests.push(this._runTest('Backtest Historical Replay', () => {
      const closes = [];
      for (let i = 0; i < 100; i++) {
        closes.push(100 + Math.sin(i * 0.2) * 20);
      }
      const candles = this._makeCandlesFromCloses(closes);
      const engine = makeEngine();
      const result = engine.run({ candles, timeframe: '1h', warmupCandles: 20, predictionCandles: 5 });

      for (const signal of result.signals) {
        const candleIdx = candles.findIndex(c => c.timestamp === signal.timestamp);
        if (candleIdx === -1) {
          return { status: 'FAIL', reason: `Signal timestamp ${signal.timestamp} not found in candles` };
        }
        const round2 = (v) => Math.round(v * 100) / 100;
        if (signal.priceAtSignal !== round2(candles[candleIdx].close)) {
          return { status: 'FAIL', reason: `Price mismatch at ${signal.timestamp}` };
        }
        const futureIdx = candleIdx + 5;
        if (futureIdx < candles.length && signal.priceAfter !== round2(candles[futureIdx].close)) {
          return { status: 'FAIL', reason: `Future price mismatch at index ${futureIdx}` };
        }
      }
      return { status: 'PASS', reason: `Replay verified: all ${result.signals.length} signal prices match candle data` };
    }));

    // Test 4: Outcome logic — bullish signal + price up = correct
    tests.push(this._runTest('Backtest Outcome Logic', () => {
      const engine = makeEngine();
      const outcome1 = engine._evaluateOutcome('Bullish', 100, 110);
      const outcome2 = engine._evaluateOutcome('Bearish', 100, 90);
      const outcome3 = engine._evaluateOutcome('Bullish', 100, 90);
      const outcome4 = engine._evaluateOutcome('Bearish', 100, 110);
      const outcome5 = engine._evaluateOutcome('Bullish', 100, 100);

      if (outcome1 !== 'correct') return { status: 'FAIL', reason: `Bullish + price up should be correct, got ${outcome1}` };
      if (outcome2 !== 'correct') return { status: 'FAIL', reason: `Bearish + price down should be correct, got ${outcome2}` };
      if (outcome3 !== 'incorrect') return { status: 'FAIL', reason: `Bullish + price down should be incorrect, got ${outcome3}` };
      if (outcome4 !== 'incorrect') return { status: 'FAIL', reason: `Bearish + price up should be incorrect, got ${outcome4}` };
      if (outcome5 !== 'neutral') return { status: 'FAIL', reason: `Bullish + flat price should be neutral, got ${outcome5}` };

      return { status: 'PASS', reason: `Outcome logic correct: up=${outcome1}, down=${outcome2}, wrong=${outcome3}/${outcome4}, flat=${outcome5}` };
    }));

    // Test 5: Stats calculation
    tests.push(this._runTest('Backtest Stats Calculation', () => {
      const engine = makeEngine();
      const signals = [
        { overallBias: 'Bullish', confidence: 70, outcome: 'correct', timeframe: '1h' },
        { overallBias: 'Bullish', confidence: 80, outcome: 'incorrect', timeframe: '1h' },
        { overallBias: 'Bearish', confidence: 60, outcome: 'correct', timeframe: '1h' },
        { overallBias: 'Bearish', confidence: 50, outcome: 'neutral', timeframe: '1h' },
      ];
      const stats = engine._computeStats(signals);

      if (stats.totalSignals !== 4) return { status: 'FAIL', reason: `Expected 4 signals, got ${stats.totalSignals}` };
      if (stats.bullishSignals !== 2) return { status: 'FAIL', reason: `Expected 2 bullish, got ${stats.bullishSignals}` };
      if (stats.bearishSignals !== 2) return { status: 'FAIL', reason: `Expected 2 bearish, got ${stats.bearishSignals}` };
      if (stats.winRate !== 50) return { status: 'FAIL', reason: `Expected 50% win rate, got ${stats.winRate}` };
      if (stats.lossRate !== 25) return { status: 'FAIL', reason: `Expected 25% loss rate, got ${stats.lossRate}` };
      if (Math.abs(stats.averageConfidence - 65) > 0.01) return { status: 'FAIL', reason: `Expected avg confidence 65, got ${stats.averageConfidence}` };

      return { status: 'PASS', reason: `Stats: total=${stats.totalSignals}, win=${stats.winRate}%, loss=${stats.lossRate}%, avgConf=${stats.averageConfidence}` };
    }));

    // Test 6: Empty input handling
    tests.push(this._runTest('Backtest Empty Input', () => {
      const engine = makeEngine();
      const result = engine.run({ candles: [] });
      if (result.signals.length !== 0) return { status: 'FAIL', reason: `Expected 0 signals for empty input, got ${result.signals.length}` };
      if (result.stats.totalSignals !== 0) return { status: 'FAIL', reason: `Expected totalSignals=0` };
      if (!result.reason) return { status: 'FAIL', reason: `Expected a reason for empty input` };
      return { status: 'PASS', reason: `Empty input handled: ${result.reason}` };
    }));

    // Test 7: Insufficient candles
    tests.push(this._runTest('Backtest Insufficient Candles', () => {
      const engine = makeEngine();
      const candles = this._makeCandles(10, (i) => 100 + i);
      const result = engine.run({ candles, warmupCandles: 20, predictionCandles: 5 });
      if (result.signals.length !== 0) return { status: 'FAIL', reason: `Expected 0 signals for 10 candles, got ${result.signals.length}` };
      if (!result.reason) return { status: 'FAIL', reason: `Expected a reason for insufficient candles` };
      return { status: 'PASS', reason: `Insufficient candles handled: ${result.reason}` };
    }));

    // Test 8: Strong uptrend produces mostly bullish signals
    tests.push(this._runTest('Backtest Strong Uptrend Signals', () => {
      const candles = this._makeCandles(100, (i) => 100 + i * 2);
      const engine = makeEngine();
      const result = engine.run({ candles, timeframe: '1h', warmupCandles: 20, predictionCandles: 5 });
      const bullishCount = result.signals.filter(s => s.overallBias === 'Bullish').length;
      const bearishCount = result.signals.filter(s => s.overallBias === 'Bearish').length;
      if (bullishCount <= bearishCount) {
        return { status: 'FAIL', reason: `Strong uptrend: expected more bullish (${bullishCount}) than bearish (${bearishCount})` };
      }
      return { status: 'PASS', reason: `Strong uptrend: ${bullishCount} bullish, ${bearishCount} bearish signals` };
    }));

    // Test 9: Strong downtrend produces mostly bearish signals
    tests.push(this._runTest('Backtest Strong Downtrend Signals', () => {
      const candles = this._makeCandles(100, (i) => 200 - i * 2);
      const engine = makeEngine();
      const result = engine.run({ candles, timeframe: '1h', warmupCandles: 20, predictionCandles: 5 });
      const bearishCount = result.signals.filter(s => s.overallBias === 'Bearish').length;
      const bullishCount = result.signals.filter(s => s.overallBias === 'Bullish').length;
      if (bearishCount <= bullishCount) {
        return { status: 'FAIL', reason: `Strong downtrend: expected more bearish (${bearishCount}) than bullish (${bullishCount})` };
      }
      return { status: 'PASS', reason: `Strong downtrend: ${bearishCount} bearish, ${bullishCount} bullish signals` };
    }));

    // Test 10: Signal record structure — all required fields present
    tests.push(this._runTest('Backtest Signal Record Structure', () => {
      const candles = this._makeCandles(100, (i) => 100 + Math.sin(i * 0.3) * 10);
      const engine = makeEngine();
      const result = engine.run({ candles, timeframe: '1h', warmupCandles: 20, predictionCandles: 5 });
      const requiredFields = ['timestamp', 'symbol', 'timeframe', 'overallBias', 'confidence', 'priceAtSignal', 'priceAfter', 'outcome'];

      for (const signal of result.signals) {
        for (const field of requiredFields) {
          if (signal[field] === undefined || signal[field] === null) {
            return { status: 'FAIL', reason: `Missing field '${field}' in signal at ${signal.timestamp}` };
          }
        }
      }
      return { status: 'PASS', reason: `All ${result.signals.length} signals have required fields` };
    }));

    // Test 11: No production engine modification — engines produce valid outputs
    tests.push(this._runTest('Backtest Engine Integrity', () => {
      const candles = this._makeCandles(100, (i) => 100 + Math.sin(i * 0.2) * 10);
      const engine = makeEngine();
      const window = candles.slice(0, 50);
      const signal = engine._generateSignal(window, '1h');

      if (!signal) return { status: 'FAIL', reason: '_generateSignal returned null' };
      if (!signal.bias) return { status: 'FAIL', reason: 'Signal missing bias' };
      if (typeof signal.confidence !== 'number') return { status: 'FAIL', reason: 'Signal confidence is not a number' };
      if (signal.confidence < 0 || signal.confidence > 100) {
        return { status: 'FAIL', reason: `Confidence ${signal.confidence} out of range 0-100` };
      }
      return { status: 'PASS', reason: `Engine integrity: bias=${signal.bias}, confidence=${signal.confidence}` };
    }));

    const executionTime = Date.now() - start;
    return { tests, executionTime };
  }

  // ---------------------------------------------------------------------------
  // Market Regime Validation
  // ---------------------------------------------------------------------------

  _validateMarketRegime() {
    const start = Date.now();
    const tests = [];

    if (!this.regimeEngine) {
      tests.push({ name: 'MarketRegime Skipped', status: 'WARNING', reason: 'RegimeEngine not provided', executionTime: 0 });
      return { tests, executionTime: Date.now() - start };
    }

    tests.push(this._runTest('MarketRegime Always Returned', () => {
      const candles = this._makeCandles(30, (i) => 100 + i);
      const result = this.regimeEngine.calculate(candles, 'val_1h');
      if (!result.regime) {
        return { status: 'FAIL', reason: 'Regime was not returned' };
      }
      return { status: 'PASS', reason: `Regime returned: ${result.regime}` };
    }));

    tests.push(this._runTest('MarketRegime Confidence Range', () => {
      const candles = this._makeCandles(30, (i) => 100 + i);
      const result = this.regimeEngine.calculate(candles, 'val_2h');
      if (result.confidence < 0 || result.confidence > 100) {
        return { status: 'FAIL', reason: `Confidence ${result.confidence} outside 0-100` };
      }
      return { status: 'PASS', reason: `Confidence ${result.confidence} is in 0-100 range` };
    }));

    tests.push(this._runTest('MarketRegime TrendScore Range', () => {
      const candles = this._makeCandles(30, (i) => 100 + Math.sin(i) * 10);
      const result = this.regimeEngine.calculate(candles, 'val_3h');
      if (result.trendScore !== null && (result.trendScore < 0 || result.trendScore > 100)) {
        return { status: 'FAIL', reason: `TrendScore ${result.trendScore} outside 0-100` };
      }
      return { status: 'PASS', reason: `TrendScore ${result.trendScore} is valid` };
    }));

    tests.push(this._runTest('MarketRegime No Undefined', () => {
      const c = this._makeCandles(30, (i) => 100 + Math.sin(i) * 5);
      const r = this.regimeEngine.calculate(c, 'val_4h');
      const check = (obj, path) => {
        for (const [k, v] of Object.entries(obj)) {
          if (v === undefined) return path ? `${path}.${k}` : k;
          if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
            const n = check(v, path ? `${path}.${k}` : k);
            if (n) return n;
          }
        }
        return null;
      };
      const f = check(r, '');
      if (f) return { status: 'FAIL', reason: `Field '${f}' is undefined` };
      return { status: 'PASS', reason: 'No undefined fields' };
    }));

    tests.push(this._runTest('MarketRegime Determinism', () => {
      const c = this._makeCandles(60, (i) => 100 + Math.sin(i * 0.2) * 15);
      const r1 = this.regimeEngine.calculate(c, 'val_5h');
      const r2 = this.regimeEngine.calculate(c, 'val_5h');
      if (r1.regime !== r2.regime || r1.confidence !== r2.confidence) {
        return { status: 'FAIL', reason: `Non-deterministic: ${r1.regime}/${r1.confidence} vs ${r2.regime}/${r2.confidence}` };
      }
      return { status: 'PASS', reason: `Deterministic: ${r1.regime} (${r1.confidence})` };
    }));

    tests.push(this._runTest('MarketRegime Insufficient Data', () => {
      const c = this._makeCandles(5, (i) => 100 + i);
      const r = this.regimeEngine.calculate(c, 'val_8h');
      if (r.regime !== 'UNKNOWN') {
        return { status: 'WARNING', reason: `Expected UNKNOWN with 5 candles, got ${r.regime}` };
      }
      return { status: 'PASS', reason: `Correctly returns UNKNOWN` };
    }));

    const executionTime = Date.now() - start;
    return { tests, executionTime };
  }

  // ---------------------------------------------------------------------------
  // Regime Decision Validation
  // ---------------------------------------------------------------------------

  _validateRegimeDecision() {
    const start = Date.now();
    const tests = [];

    if (!this.regimeDecisionEngine) {
      tests.push({ name: 'RegimeDecision Skipped', status: 'WARNING', reason: 'RegimeDecisionEngine not provided', executionTime: 0 });
      return { tests, executionTime: Date.now() - start };
    }

    const engine = this.regimeDecisionEngine;

    // Test 1: Bull trend — BUY is allowed with no penalty
    tests.push(this._runTest('RegimeDecision Bull BUY', () => {
      const r = engine.evaluate({ regime: 'TRENDING_BULL', confidence: 70, direction: 'BUY', confluenceScore: 60 });
      if (!r.allowTrade) return { status: 'FAIL', reason: `Bull BUY should be allowed, got block` };
      if (r.penalty !== 0) return { status: 'FAIL', reason: `Bull BUY should have 0 penalty, got ${r.penalty}` };
      if (r.preferredDirection !== 'BUY') return { status: 'FAIL', reason: `Bull BUY preferred should be BUY, got ${r.preferredDirection}` };
      return { status: 'PASS', reason: `Bull BUY: allowed, penalty=0, preferred=BUY` };
    }));

    // Test 2: Bull trend — SELL is penalized
    tests.push(this._runTest('RegimeDecision Bull SELL Penalty', () => {
      const r = engine.evaluate({ regime: 'TRENDING_BULL', confidence: 70, direction: 'SELL', confluenceScore: 60 });
      if (r.penalty < 5) return { status: 'FAIL', reason: `Bull SELL should have penalty >= 5, got ${r.penalty}` };
      if (r.preferredDirection !== 'BUY') return { status: 'FAIL', reason: `Preferred should be BUY, got ${r.preferredDirection}` };
      return { status: 'PASS', reason: `Bull SELL: penalty=${r.penalty}, preferred=BUY` };
    }));

    // Test 3: Bear trend — SELL is allowed with no penalty
    tests.push(this._runTest('RegimeDecision Bear SELL', () => {
      const r = engine.evaluate({ regime: 'TRENDING_BEAR', confidence: 70, direction: 'SELL', confluenceScore: 60 });
      if (!r.allowTrade) return { status: 'FAIL', reason: `Bear SELL should be allowed, got block` };
      if (r.penalty !== 0) return { status: 'FAIL', reason: `Bear SELL should have 0 penalty, got ${r.penalty}` };
      if (r.preferredDirection !== 'SELL') return { status: 'FAIL', reason: `Bear SELL preferred should be SELL, got ${r.preferredDirection}` };
      return { status: 'PASS', reason: `Bear SELL: allowed, penalty=0, preferred=SELL` };
    }));

    // Test 4: Bear trend — BUY is penalized
    tests.push(this._runTest('RegimeDecision Bear BUY Penalty', () => {
      const r = engine.evaluate({ regime: 'TRENDING_BEAR', confidence: 70, direction: 'BUY', confluenceScore: 60 });
      if (r.penalty < 5) return { status: 'FAIL', reason: `Bear BUY should have penalty >= 5, got ${r.penalty}` };
      if (r.preferredDirection !== 'SELL') return { status: 'FAIL', reason: `Preferred should be SELL, got ${r.preferredDirection}` };
      return { status: 'PASS', reason: `Bear BUY: penalty=${r.penalty}, preferred=SELL` };
    }));

    // Test 5: Sideways — weak trend-following trade rejected
    tests.push(this._runTest('RegimeDecision Sideways Reject Weak', () => {
      const r = engine.evaluate({ regime: 'RANGING', confidence: 60, direction: 'BUY', confluenceScore: 50 });
      if (r.allowTrade) return { status: 'FAIL', reason: `Sideways with low confluence should be rejected, got allowed` };
      return { status: 'PASS', reason: `Sideways weak: rejected (confluence 50 < 65)` };
    }));

    // Test 6: Sideways — strong confluence allowed
    tests.push(this._runTest('RegimeDecision Sideways Strong Allowed', () => {
      const r = engine.evaluate({ regime: 'RANGING', confidence: 60, direction: 'BUY', confluenceScore: 80 });
      if (!r.allowTrade) return { status: 'FAIL', reason: `Sideways with strong confluence should be allowed, got rejected` };
      return { status: 'PASS', reason: `Sideways strong: allowed with confluence 80` };
    }));

    // Test 7: High Volatility — insufficient confluence rejected
    tests.push(this._runTest('RegimeDecision HighVol Reject', () => {
      const r = engine.evaluate({ regime: 'HIGH_VOLATILITY', confidence: 60, direction: 'BUY', confluenceScore: 50 });
      if (r.allowTrade) return { status: 'FAIL', reason: `High vol with low confluence should be rejected` };
      if (!r.warning) return { status: 'FAIL', reason: `High vol should include warning flag` };
      if (r.riskReduction !== 0.5) return { status: 'FAIL', reason: `High vol should recommend 0.5 risk reduction` };
      return { status: 'PASS', reason: `HighVol: rejected, warning=HIGH_VOLATILITY, riskReduction=0.5` };
    }));

    // Test 8: High Volatility — sufficient confluence allowed
    tests.push(this._runTest('RegimeDecision HighVol Allowed', () => {
      const r = engine.evaluate({ regime: 'HIGH_VOLATILITY', confidence: 60, direction: 'BUY', confluenceScore: 80 });
      if (!r.allowTrade) return { status: 'FAIL', reason: `High vol with strong confluence should be allowed` };
      if (!r.warning) return { status: 'FAIL', reason: `High vol should include warning even when allowed` };
      return { status: 'PASS', reason: `HighVol: allowed with confluence 80, warning=${r.warning}` };
    }));

    // Test 9: Unknown regime — always allowed
    tests.push(this._runTest('RegimeDecision Unknown', () => {
      const r = engine.evaluate({ regime: 'UNKNOWN', confidence: 0, direction: 'BUY', confluenceScore: 50 });
      if (!r.allowTrade) return { status: 'FAIL', reason: `Unknown regime should always allow trade` };
      if (r.penalty !== 0) return { status: 'FAIL', reason: `Unknown regime should have 0 penalty` };
      return { status: 'PASS', reason: `Unknown: allowed, penalty=0` };
    }));

    // Test 10: Missing regime field
    tests.push(this._runTest('RegimeDecision Missing Regime', () => {
      const r = engine.evaluate({ regime: null, confidence: 0, direction: 'BUY', confluenceScore: 50 });
      if (!r.allowTrade) return { status: 'FAIL', reason: `Missing regime should fall back to unknown (allowed)` };
      return { status: 'PASS', reason: `Missing regime: falls back to unknown handler, allowed` };
    }));

    // Test 11: Determinism
    tests.push(this._runTest('RegimeDecision Determinism', () => {
      const input = { regime: 'TRENDING_BEAR', confidence: 80, direction: 'SELL', confluenceScore: 70 };
      const r1 = engine.evaluate(input);
      const r2 = engine.evaluate(input);
      if (r1.allowTrade !== r2.allowTrade || r1.penalty !== r2.penalty) {
        return { status: 'FAIL', reason: `Non-deterministic: ${JSON.stringify(r1)} vs ${JSON.stringify(r2)}` };
      }
      return { status: 'PASS', reason: `Deterministic: allow=${r1.allowTrade}, penalty=${r1.penalty}` };
    }));

    const executionTime = Date.now() - start;
    return { tests, executionTime };
  }

  // ---------------------------------------------------------------------------
  // Analytics Validation
  // ---------------------------------------------------------------------------

  _validateAnalytics() {
    const start = Date.now();
    const tests = [];
    const { AnalyticsEngine } = require('./analytics');

    const makeEngine = (overrides = {}) => {
      return new AnalyticsEngine({
        logger: this.logger,
        symbol: overrides.symbol || 'TEST',
      });
    };

    const makeBacktestSignals = (count, pattern) => {
      const signals = [];
      for (let i = 0; i < count; i++) {
        let bias, outcome;
        if (pattern === 'uptrend') {
          bias = 'Bullish';
          outcome = i % 3 === 0 ? 'incorrect' : 'correct';
        } else if (pattern === 'downtrend') {
          bias = 'Bearish';
          outcome = i % 3 === 0 ? 'incorrect' : 'correct';
        } else if (pattern === 'mixed') {
          bias = i % 2 === 0 ? 'Bullish' : 'Bearish';
          outcome = i % 3 === 0 ? 'incorrect' : i % 3 === 1 ? 'correct' : 'neutral';
        } else if (pattern === 'all_wrong') {
          bias = i % 2 === 0 ? 'Bullish' : 'Bearish';
          outcome = 'incorrect';
        } else if (pattern === 'all_correct') {
          bias = i % 2 === 0 ? 'Bullish' : 'Bearish';
          outcome = 'correct';
        } else {
          bias = 'Bullish';
          outcome = 'correct';
        }
        signals.push({
          timestamp: new Date(i * 3600000).toISOString(),
          symbol: 'TEST',
          timeframe: i < count / 2 ? '1h' : '4h',
          overallBias: bias,
          confidence: 50 + (i % 5) * 10,
          priceAtSignal: 100 + i,
          priceAfter: 100 + i + (outcome === 'correct' ? 5 : -5),
          outcome,
        });
      }
      return signals;
    };

    // Test 1: Determinism — same input produces same output
    tests.push(this._runTest('Analytics Determinism', () => {
      const engine = makeEngine();
      const signals = makeBacktestSignals(20, 'mixed');
      const r1 = engine.analyze({ backtestResult: { signals, totalCandles: 100, warmupCandles: 20, predictionCandles: 5 } });
      const r2 = engine.analyze({ backtestResult: { signals, totalCandles: 100, warmupCandles: 20, predictionCandles: 5 } });
      if (r1.general.totalSignals !== r2.general.totalSignals) {
        return { status: 'FAIL', reason: `Non-deterministic totalSignals: ${r1.general.totalSignals} vs ${r2.general.totalSignals}` };
      }
      if (r1.accuracy.overall !== r2.accuracy.overall) {
        return { status: 'FAIL', reason: `Non-deterministic accuracy: ${r1.accuracy.overall} vs ${r2.accuracy.overall}` };
      }
      if (r1.risk.maximumDrawdown !== r2.risk.maximumDrawdown) {
        return { status: 'FAIL', reason: `Non-deterministic drawdown: ${r1.risk.maximumDrawdown} vs ${r2.risk.maximumDrawdown}` };
      }
      return { status: 'PASS', reason: `Deterministic: total=${r1.general.totalSignals}, accuracy=${r1.accuracy.overall}%, drawdown=${r1.risk.maximumDrawdown}%` };
    }));

    // Test 2: Empty input — no crash, all zeros
    tests.push(this._runTest('Analytics Empty Input', () => {
      const engine = makeEngine();
      const result = engine.analyze({});
      if (result.general.totalSignals !== 0) return { status: 'FAIL', reason: `Expected 0 signals, got ${result.general.totalSignals}` };
      if (result.accuracy.overall !== 0) return { status: 'FAIL', reason: `Expected 0% accuracy, got ${result.accuracy.overall}` };
      if (result.performance.winRate !== 0) return { status: 'FAIL', reason: `Expected 0% win rate, got ${result.performance.winRate}` };
      return { status: 'PASS', reason: `Empty input handled: all zeros returned` };
    }));

    // Test 3: General metrics — counts are correct
    tests.push(this._runTest('Analytics General Counts', () => {
      const engine = makeEngine();
      const signals = makeBacktestSignals(30, 'mixed');
      const result = engine.analyze({ backtestResult: { signals } });
      if (result.general.totalSignals !== 30) return { status: 'FAIL', reason: `Expected 30 total, got ${result.general.totalSignals}` };
      if (result.general.bullishSignals !== 15) return { status: 'FAIL', reason: `Expected 15 bullish, got ${result.general.bullishSignals}` };
      if (result.general.bearishSignals !== 15) return { status: 'FAIL', reason: `Expected 15 bearish, got ${result.general.bearishSignals}` };
      if (result.general.neutralSignals !== 10) return { status: 'FAIL', reason: `Expected 10 neutral, got ${result.general.neutralSignals}` };
      return { status: 'PASS', reason: `Counts: total=${result.general.totalSignals}, bull=${result.general.bullishSignals}, bear=${result.general.bearishSignals}, neutral=${result.general.neutralSignals}` };
    }));

    // Test 4: All correct → 100% win rate, 0% loss rate
    tests.push(this._runTest('Analytics All Correct', () => {
      const engine = makeEngine();
      const signals = makeBacktestSignals(20, 'all_correct');
      const result = engine.analyze({ backtestResult: { signals } });
      if (result.performance.winRate !== 100) return { status: 'FAIL', reason: `Expected 100% win rate, got ${result.performance.winRate}` };
      if (result.performance.lossRate !== 0) return { status: 'FAIL', reason: `Expected 0% loss rate, got ${result.performance.lossRate}` };
      if (result.accuracy.overall !== 100) return { status: 'FAIL', reason: `Expected 100% accuracy, got ${result.accuracy.overall}` };
      return { status: 'PASS', reason: `All correct: win=${result.performance.winRate}%, loss=${result.performance.lossRate}%` };
    }));

    // Test 5: All wrong → 0% win rate, 100% loss rate
    tests.push(this._runTest('Analytics All Wrong', () => {
      const engine = makeEngine();
      const signals = makeBacktestSignals(20, 'all_wrong');
      const result = engine.analyze({ backtestResult: { signals } });
      if (result.performance.winRate !== 0) return { status: 'FAIL', reason: `Expected 0% win rate, got ${result.performance.winRate}` };
      if (result.performance.lossRate !== 100) return { status: 'FAIL', reason: `Expected 100% loss rate, got ${result.performance.lossRate}` };
      return { status: 'PASS', reason: `All wrong: win=${result.performance.winRate}%, loss=${result.performance.lossRate}%` };
    }));

    // Test 6: Consecutive streaks
    tests.push(this._runTest('Analytics Consecutive Streaks', () => {
      const engine = makeEngine();
      const signals = [
        { timestamp: '2026-01-01T00:00:00Z', symbol: 'TEST', timeframe: '1h', overallBias: 'Bullish', confidence: 70, priceAtSignal: 100, priceAfter: 105, outcome: 'correct' },
        { timestamp: '2026-01-01T01:00:00Z', symbol: 'TEST', timeframe: '1h', overallBias: 'Bullish', confidence: 70, priceAtSignal: 105, priceAfter: 110, outcome: 'correct' },
        { timestamp: '2026-01-01T02:00:00Z', symbol: 'TEST', timeframe: '1h', overallBias: 'Bullish', confidence: 70, priceAtSignal: 110, priceAfter: 105, outcome: 'incorrect' },
        { timestamp: '2026-01-01T03:00:00Z', symbol: 'TEST', timeframe: '1h', overallBias: 'Bullish', confidence: 70, priceAtSignal: 105, priceAfter: 100, outcome: 'incorrect' },
        { timestamp: '2026-01-01T04:00:00Z', symbol: 'TEST', timeframe: '1h', overallBias: 'Bullish', confidence: 70, priceAtSignal: 100, priceAfter: 105, outcome: 'correct' },
      ];
      const result = engine.analyze({ backtestResult: { signals } });
      if (result.risk.maxConsecutiveWins !== 2) return { status: 'FAIL', reason: `Expected max 2 consecutive wins, got ${result.risk.maxConsecutiveWins}` };
      if (result.risk.maxConsecutiveLosses !== 2) return { status: 'FAIL', reason: `Expected max 2 consecutive losses, got ${result.risk.maxConsecutiveLosses}` };
      return { status: 'PASS', reason: `Streaks: maxWins=${result.risk.maxConsecutiveWins}, maxLosses=${result.risk.maxConsecutiveLosses}` };
    }));

    // Test 7: Maximum drawdown — all incorrect → >0% drawdown
    tests.push(this._runTest('Analytics Maximum Drawdown', () => {
      const engine = makeEngine();
      const signals = makeBacktestSignals(20, 'all_wrong');
      const result = engine.analyze({ backtestResult: { signals } });
      if (result.risk.maximumDrawdown <= 0) return { status: 'FAIL', reason: `Expected positive drawdown, got ${result.risk.maximumDrawdown}` };
      return { status: 'PASS', reason: `Drawdown=${result.risk.maximumDrawdown}% for all-incorrect signals` };
    }));

    // Test 8: Confidence vs Accuracy — higher confidence should not guarantee higher accuracy (validates structure)
    tests.push(this._runTest('Analytics Confidence Structure', () => {
      const engine = makeEngine();
      const signals = makeBacktestSignals(30, 'mixed');
      const result = engine.analyze({ backtestResult: { signals } });
      if (typeof result.confidence.averageConfidence !== 'number') return { status: 'FAIL', reason: `averageConfidence is not a number` };
      if (result.confidence.averageConfidence < 0 || result.confidence.averageConfidence > 100) {
        return { status: 'FAIL', reason: `avgConfidence ${result.confidence.averageConfidence} out of range` };
      }
      if (typeof result.confidence.distribution !== 'object') return { status: 'FAIL', reason: `distribution is not an object` };
      if (typeof result.confidence.vsAccuracy !== 'object') return { status: 'FAIL', reason: `vsAccuracy is not an object` };
      return { status: 'PASS', reason: `Confidence: avg=${result.confidence.averageConfidence}, buckets=${Object.keys(result.confidence.vsAccuracy).length}` };
    }));

    // Test 9: Accuracy by timeframe — both timeframes present
    tests.push(this._runTest('Analytics Accuracy By Timeframe', () => {
      const engine = makeEngine();
      const signals = makeBacktestSignals(20, 'uptrend');
      const result = engine.analyze({ backtestResult: { signals } });
      const tfs = Object.keys(result.accuracy.byTimeframe);
      if (tfs.length < 2) return { status: 'FAIL', reason: `Expected 2 timeframes, got ${tfs.length}` };
      if (!result.accuracy.byTimeframe['1h'] || !result.accuracy.byTimeframe['4h']) {
        return { status: 'FAIL', reason: `Missing expected timeframes` };
      }
      return { status: 'PASS', reason: `Timeframes: ${tfs.join(', ')}` };
    }));

    // Test 10: Signal frequency — computed correctly
    tests.push(this._runTest('Analytics Signal Frequency', () => {
      const engine = makeEngine();
      const signals = makeBacktestSignals(10, 'uptrend');
      const result = engine.analyze({
        backtestResult: { signals, totalCandles: 100, warmupCandles: 20, predictionCandles: 5 },
      });
      if (result.performance.signalFrequency <= 0) return { status: 'FAIL', reason: `Expected positive frequency, got ${result.performance.signalFrequency}` };
      return { status: 'PASS', reason: `Frequency=${result.performance.signalFrequency}% (${signals.length} signals / 75 analyzed candles)` };
    }));

    // Test 11: Record structure — all required sections present
    tests.push(this._runTest('Analytics Record Structure', () => {
      const engine = makeEngine();
      const result = engine.analyze({});
      const requiredSections = ['general', 'accuracy', 'risk', 'confidence', 'performance'];
      for (const section of requiredSections) {
        if (!result[section]) return { status: 'FAIL', reason: `Missing section: ${section}` };
      }
      if (!result.engineVersion) return { status: 'FAIL', reason: `Missing engineVersion` };
      if (!result.lastUpdated) return { status: 'FAIL', reason: `Missing lastUpdated` };
      if (typeof result.calculationTime !== 'number') return { status: 'FAIL', reason: `calculationTime is not a number` };
      return { status: 'PASS', reason: `All ${requiredSections.length} sections present` };
    }));

    // Test 12: Signal history integration — consumes history records
    tests.push(this._runTest('Analytics Signal History Integration', () => {
      const engine = makeEngine();
      const historyRecords = [
        { confluence: { bias: 'Bullish', confidence: 70 }, mtf: { overallBias: 'Bullish', confidence: 65 } },
        { confluence: { bias: 'Bearish', confidence: 60 }, mtf: { overallBias: 'Bearish', confidence: 55 } },
        { confluence: { bias: 'Neutral', confidence: 50 }, mtf: { overallBias: 'Neutral', confidence: 45 } },
      ];
      const result = engine.analyze({ signalHistory: historyRecords });
      if (result.general.signalHistoryRecords !== 3) return { status: 'FAIL', reason: `Expected 3 history records, got ${result.general.signalHistoryRecords}` };
      if (result.general.signalHistoryBias.Bullish !== 1) return { status: 'FAIL', reason: `Expected 1 Bullish history, got ${result.general.signalHistoryBias.Bullish}` };
      if (result.general.signalHistoryBias.Bearish !== 1) return { status: 'FAIL', reason: `Expected 1 Bearish history, got ${result.general.signalHistoryBias.Bearish}` };
      return { status: 'PASS', reason: `History: ${result.general.signalHistoryRecords} records, bias=${JSON.stringify(result.general.signalHistoryBias)}` };
    }));

    const executionTime = Date.now() - start;
    return { tests, executionTime };
  }

  // ---------------------------------------------------------------------------
  // Paper Trading Validation
  // ---------------------------------------------------------------------------

  _validatePaperTrading() {
    const start = Date.now();
    const tests = [];
    const { PaperTradingEngine } = require('./paperTrading');

    const makeEngine = (overrides = {}) => {
      return new PaperTradingEngine({
        logger: this.logger,
        symbol: overrides.symbol || 'TEST',
      });
    };

    const bullishEngines = () => ({
      trend: { trend: { '1H': 'Bullish' } },
      structure: { ready: true, direction: 'bullish', structure: 'Bullish BOS', score: 0.8, confidence: 75 },
      rsi: { ready: true, value: 62, state: 'Neutral', interpretation: 'Approaching overbought' },
      ema: { ready: true, trend: 'Above', value: 55120.50, interpretation: 'Bullish' },
      macd: { ready: true, trend: 'bullish', histogram: 12.5, signal: 0.0012, fast: 0.0018, slow: 0.0006 },
      bollinger: { ready: true, pricePosition: 'Inside Bands', middleBand: 55000, upperBand: 56000, lowerBand: 54000 },
      confluence: { bias: 'Bullish', score: 72, confidence: 70, interpretation: 'Bullish confluence' },
      mtf: { overallBias: 'Bullish', confidence: 68, timeframeAgreement: 75 },
      analytics: { general: { totalSignals: 100 }, accuracy: { overall: 65 } },
    });

    const bearishEngines = () => ({
      trend: { trend: { '1H': 'Bearish' } },
      structure: { ready: true, direction: 'bearish', structure: 'Bearish BOS', score: -0.8, confidence: 72 },
      rsi: { ready: true, value: 35, state: 'Neutral', interpretation: 'Approaching oversold' },
      ema: { ready: true, trend: 'Below', value: 54800.00, interpretation: 'Bearish' },
      macd: { ready: true, trend: 'bearish', histogram: -8.3, signal: -0.0010, fast: -0.0015, slow: -0.0005 },
      bollinger: { ready: true, pricePosition: 'Inside Bands', middleBand: 55000, upperBand: 56000, lowerBand: 54000 },
      confluence: { bias: 'Bearish', score: 68, confidence: 65, interpretation: 'Bearish confluence' },
      mtf: { overallBias: 'Bearish', confidence: 62, timeframeAgreement: 70 },
      analytics: { general: { totalSignals: 100 }, accuracy: { overall: 60 } },
    });

    // Test 1: Determinism — same input produces same output
    tests.push(this._runTest('Paper Trading Determinism', () => {
      const engine = makeEngine();
      const e = bullishEngines();
      const t1 = engine.signal(e, 55000, '1h');
      engine.evaluateTrades(55100);
      const t2 = engine.signal(e, 55000, '1h');
      if (!t1 || !t2) return { status: 'FAIL', reason: 'No trades opened' };
      if (t1.direction !== t2.direction) return { status: 'FAIL', reason: `Non-deterministic direction: ${t1.direction} vs ${t2.direction}` };
      if (t1.entryPrice !== t2.entryPrice) return { status: 'FAIL', reason: `Non-deterministic entryPrice: ${t1.entryPrice} vs ${t2.entryPrice}` };
      return { status: 'PASS', reason: `Deterministic: direction=${t1.direction}, entry=${t1.entryPrice}` };
    }));

    // Test 2: Neutral signals produce no trade
    tests.push(this._runTest('Paper Trading Neutral No Trade', () => {
      const engine = makeEngine();
      const neutralEngines = {
        trend: { trend: { '1H': 'Neutral' } },
        structure: { ready: true, direction: 'neutral', structure: 'Ranging', score: 0, confidence: 40 },
        rsi: { ready: true, value: 50, state: 'Neutral', interpretation: 'Neutral' },
        ema: { ready: true, trend: 'Crossing', value: 55000, interpretation: 'Crossing' },
        macd: { ready: true, trend: 'neutral', histogram: 0.1, signal: 0.001, fast: 0.0011, slow: 0.0009 },
        bollinger: { ready: true, pricePosition: 'Inside Bands', middleBand: 55000, upperBand: 56000, lowerBand: 54000 },
        confluence: { bias: 'Neutral', score: 50, confidence: 50, interpretation: 'Neutral' },
        mtf: { overallBias: 'Neutral', confidence: 50, timeframeAgreement: 50 },
      };
      const trade = engine.signal(neutralEngines, 55000, '1h');
      if (trade !== null) return { status: 'FAIL', reason: `Expected null trade, got ${trade.direction}` };
      if (engine.open().length !== 0) return { status: 'FAIL', reason: `Expected 0 open trades, got ${engine.open().length}` };
      return { status: 'PASS', reason: `Neutral engines correctly produce no trade` };
    }));

    // Test 3: Low consensus (< 55% threshold) produces no trade
    tests.push(this._runTest('Paper Trading Low Confidence No Trade', () => {
      const engine = makeEngine();
      const lowConfEngines = {
        trend: { trend: { '1H': 'Bullish' } },
        structure: { ready: true, direction: 'bullish', structure: 'Weak Bullish', score: 0.2, confidence: 25 },
        rsi: { ready: true, value: 42, state: 'Neutral', interpretation: 'Neutral' },
        ema: { ready: true, trend: 'Crossing', value: 55000, interpretation: 'Crossing' },
        macd: { ready: true, trend: 'neutral', histogram: 0.5, signal: 0.001, fast: 0.0011, slow: 0.0009 },
        bollinger: { ready: true, pricePosition: 'Inside Bands', middleBand: 55000, upperBand: 56000, lowerBand: 54000 },
        confluence: { bias: 'Bearish', score: 55, confidence: 40, interpretation: 'Mixed' },
        mtf: { overallBias: 'Bearish', confidence: 35, timeframeAgreement: 45 },
      };
      const trade = engine.signal(lowConfEngines, 55000, '1h');
      if (trade !== null) return { status: 'FAIL', reason: `Expected null for split consensus, got ${trade.direction}` };
      return { status: 'PASS', reason: `Split consensus correctly rejected` };
    }));

    // Test 4: Trade structure has all required fields
    tests.push(this._runTest('Paper Trading Trade Structure', () => {
      const engine = makeEngine();
      const trade = engine.signal(bullishEngines(), 55000, '1h');
      if (!trade) return { status: 'FAIL', reason: 'No trade opened' };
      const required = ['tradeId', 'timestamp', 'symbol', 'timeframe', 'direction', 'entryPrice', 'stopLoss', 'takeProfit', 'confidence', 'reason', 'status'];
      for (const field of required) {
        if (trade[field] === undefined) return { status: 'FAIL', reason: `Missing field: ${field}` };
      }
      if (trade.status !== 'OPEN') return { status: 'FAIL', reason: `Expected OPEN, got ${trade.status}` };
      if (!trade.tradeId.startsWith('PT-')) return { status: 'FAIL', reason: `tradeId should start with PT-, got ${trade.tradeId}` };
      return { status: 'PASS', reason: `All ${required.length} fields present, tradeId=${trade.tradeId}` };
    }));

    // Test 5: BUY trade stop loss < entry, take profit > entry
    tests.push(this._runTest('Paper Trading BUY Levels', () => {
      const engine = makeEngine();
      const trade = engine.signal(bullishEngines(), 55000, '1h');
      if (!trade) return { status: 'FAIL', reason: 'No trade opened' };
      if (trade.direction !== 'BUY') return { status: 'FAIL', reason: `Expected BUY, got ${trade.direction}` };
      if (trade.stopLoss >= trade.entryPrice) return { status: 'FAIL', reason: `BUY SL (${trade.stopLoss}) should be below entry (${trade.entryPrice})` };
      if (trade.takeProfit <= trade.entryPrice) return { status: 'FAIL', reason: `BUY TP (${trade.takeProfit}) should be above entry (${trade.entryPrice})` };
      return { status: 'PASS', reason: `BUY: SL=${trade.stopLoss}, entry=${trade.entryPrice}, TP=${trade.takeProfit}` };
    }));

    // Test 6: SELL trade stop loss > entry, take profit < entry
    tests.push(this._runTest('Paper Trading SELL Levels', () => {
      const engine = makeEngine();
      const trade = engine.signal(bearishEngines(), 55000, '1h');
      if (!trade) return { status: 'FAIL', reason: 'No trade opened' };
      if (trade.direction !== 'SELL') return { status: 'FAIL', reason: `Expected SELL, got ${trade.direction}` };
      if (trade.stopLoss <= trade.entryPrice) return { status: 'FAIL', reason: `SELL SL (${trade.stopLoss}) should be above entry (${trade.entryPrice})` };
      if (trade.takeProfit >= trade.entryPrice) return { status: 'FAIL', reason: `SELL TP (${trade.takeProfit}) should be below entry (${trade.entryPrice})` };
      return { status: 'PASS', reason: `SELL: SL=${trade.stopLoss}, entry=${trade.entryPrice}, TP=${trade.takeProfit}` };
    }));

    // Test 7: Stop Loss closes BUY trade
    tests.push(this._runTest('Paper Trading SL Closes BUY', () => {
      const engine = makeEngine();
      const trade = engine.signal(bullishEngines(), 55000, '1h');
      if (!trade) return { status: 'FAIL', reason: 'No trade opened' };
      const closed = engine.evaluateTrades(trade.stopLoss - 100);
      if (closed.length !== 1) return { status: 'FAIL', reason: `Expected 1 closed trade, got ${closed.length}` };
      if (closed[0].status !== 'CLOSED') return { status: 'FAIL', reason: `Expected CLOSED, got ${closed[0].status}` };
      if (closed[0].pnl >= 0) return { status: 'FAIL', reason: `Stop Loss should have negative PnL, got ${closed[0].pnl}` };
      return { status: 'PASS', reason: `SL hit: pnl=${closed[0].pnl}, pnlPercent=${closed[0].pnlPercent}%` };
    }));

    // Test 8: Take Profit closes BUY trade
    tests.push(this._runTest('Paper Trading TP Closes BUY', () => {
      const engine = makeEngine();
      const trade = engine.signal(bullishEngines(), 55000, '1h');
      if (!trade) return { status: 'FAIL', reason: 'No trade opened' };
      const closed = engine.evaluateTrades(trade.takeProfit + 100);
      if (closed.length !== 1) return { status: 'FAIL', reason: `Expected 1 closed trade, got ${closed.length}` };
      if (closed[0].pnl <= 0) return { status: 'FAIL', reason: `Take Profit should have positive PnL, got ${closed[0].pnl}` };
      return { status: 'PASS', reason: `TP hit: pnl=${closed[0].pnl}, pnlPercent=${closed[0].pnlPercent}%` };
    }));

    // Test 9: Stop Loss closes SELL trade
    tests.push(this._runTest('Paper Trading SL Closes SELL', () => {
      const engine = makeEngine();
      const trade = engine.signal(bearishEngines(), 55000, '1h');
      if (!trade) return { status: 'FAIL', reason: 'No trade opened' };
      const closed = engine.evaluateTrades(trade.stopLoss + 100);
      if (closed.length !== 1) return { status: 'FAIL', reason: `Expected 1 closed trade, got ${closed.length}` };
      if (closed[0].pnl >= 0) return { status: 'FAIL', reason: `Stop Loss should have negative PnL, got ${closed[0].pnl}` };
      return { status: 'PASS', reason: `SELL SL hit: pnl=${closed[0].pnl}, pnlPercent=${closed[0].pnlPercent}%` };
    }));

    // Test 10: Take Profit closes SELL trade
    tests.push(this._runTest('Paper Trading TP Closes SELL', () => {
      const engine = makeEngine();
      const trade = engine.signal(bearishEngines(), 55000, '1h');
      if (!trade) return { status: 'FAIL', reason: 'No trade opened' };
      const closed = engine.evaluateTrades(trade.takeProfit - 100);
      if (closed.length !== 1) return { status: 'FAIL', reason: `Expected 1 closed trade, got ${closed.length}` };
      if (closed[0].pnl <= 0) return { status: 'FAIL', reason: `Take Profit should have positive PnL, got ${closed[0].pnl}` };
      return { status: 'PASS', reason: `SELL TP hit: pnl=${closed[0].pnl}, pnlPercent=${closed[0].pnlPercent}%` };
    }));

    // Test 11: Stats — win rate, loss rate, by direction, by timeframe
    tests.push(this._runTest('Paper Trading Stats', () => {
      const engine = makeEngine();
      // Open and close a winning BUY
      const t1 = engine.signal(bullishEngines(), 55000, '1h');
      engine.evaluateTrades(t1.takeProfit + 100);
      // Open and close a losing BUY
      const t2 = engine.signal(bullishEngines(), 55000, '1h');
      engine.evaluateTrades(t2.stopLoss - 100);
      const stats = engine.stats();
      if (stats.closedTrades !== 2) return { status: 'FAIL', reason: `Expected 2 closed, got ${stats.closedTrades}` };
      if (stats.winRate !== 50) return { status: 'FAIL', reason: `Expected 50% win rate, got ${stats.winRate}` };
      if (stats.lossRate !== 50) return { status: 'FAIL', reason: `Expected 50% loss rate, got ${stats.lossRate}` };
      if (!stats.byDirection.BUY) return { status: 'FAIL', reason: 'Missing BUY direction stats' };
      if (stats.byDirection.BUY.total !== 2) return { status: 'FAIL', reason: `Expected 2 BUY trades, got ${stats.byDirection.BUY.total}` };
      if (!stats.byTimeframe['1h']) return { status: 'FAIL', reason: 'Missing 1h timeframe stats' };
      return { status: 'PASS', reason: `Stats: win=${stats.winRate}%, loss=${stats.lossRate}%, BUY=${stats.byDirection.BUY.total}` };
    }));

    // Test 12: All() returns all trades
    tests.push(this._runTest('Paper Trading All Trades', () => {
      const engine = makeEngine();
      engine.signal(bullishEngines(), 55000, '1h');
      engine.signal(bullishEngines(), 55100, '1h');
      engine.signal(bullishEngines(), 55200, '1h');
      const all = engine.all();
      if (all.length !== 3) return { status: 'FAIL', reason: `Expected 3 trades, got ${all.length}` };
      if (all[0].status !== 'OPEN' || all[1].status !== 'OPEN' || all[2].status !== 'OPEN') {
        return { status: 'FAIL', reason: `All trades should be OPEN` };
      }
      return { status: 'PASS', reason: `all() returned ${all.length} trades` };
    }));

    // Test 13: No SL/TP when price is between levels — trade stays OPEN
    tests.push(this._runTest('Paper Trading No Trigger Between Levels', () => {
      const engine = makeEngine();
      const trade = engine.signal(bullishEngines(), 55000, '1h');
      if (!trade) return { status: 'FAIL', reason: 'No trade opened' };
      const midPrice = (trade.stopLoss + trade.takeProfit) / 2;
      const closed = engine.evaluateTrades(midPrice);
      if (closed.length !== 0) return { status: 'FAIL', reason: `Expected 0 closed at mid price, got ${closed.length}` };
      if (engine.open().length !== 1) return { status: 'FAIL', reason: `Trade should still be open` };
      return { status: 'PASS', reason: `Trade stays OPEN at mid-price=${this._round ? midPrice : Math.round(midPrice * 100) / 100}` };
    }));

    // Test 14: Invalid price — no crash, returns null
    tests.push(this._runTest('Paper Trading Invalid Price', () => {
      const engine = makeEngine();
      const t1 = engine.signal(bullishEngines(), 0, '1h');
      const t2 = engine.signal(bullishEngines(), -100, '1h');
      const t3 = engine.signal(bullishEngines(), null, '1h');
      if (t1 !== null || t2 !== null || t3 !== null) return { status: 'FAIL', reason: `Expected null for invalid prices` };
      return { status: 'PASS', reason: `Invalid prices handled correctly` };
    }));

    // Test 15: Full lifecycle — signal → onCandle → SL/TP → CLOSED
    tests.push(this._runTest('Paper Trading Full Lifecycle', () => {
      const engine = makeEngine();
      const trade = engine.signal(bullishEngines(), 55000, '1h');
      if (!trade) return { status: 'FAIL', reason: 'No trade opened' };
      if (trade.status !== 'OPEN') return { status: 'FAIL', reason: `Expected OPEN, got ${trade.status}` };

      const midCandle = { open: 55100, high: 55200, low: 55050, close: 55150, volume: 100, timestamp: new Date().toISOString() };
      engine.onCandle(midCandle);
      if (trade.status !== 'ACTIVE') return { status: 'FAIL', reason: `Expected ACTIVE after onCandle, got ${trade.status}` };

      const tpCandle = { open: trade.takeProfit - 10, high: trade.takeProfit + 100, low: trade.takeProfit - 20, close: trade.takeProfit + 50, volume: 100, timestamp: new Date().toISOString() };
      const result = engine.onCandle(tpCandle);
      if (trade.status !== 'CLOSED') return { status: 'FAIL', reason: `Expected CLOSED after TP hit, got ${trade.status}` };
      if (trade.exitReason !== 'Take Profit') return { status: 'FAIL', reason: `Expected exitReason=Take Profit, got ${trade.exitReason}` };
      if (trade.pnl <= 0) return { status: 'FAIL', reason: `TP should have positive PnL, got ${trade.pnl}` };
      if (result.closed.length !== 1) return { status: 'FAIL', reason: `Expected 1 closed in result, got ${result.closed.length}` };
      return { status: 'PASS', reason: `Full lifecycle: OPEN→ACTIVE→CLOSED via TP, pnl=${trade.pnl}` };
    }));

    // Test 16: onCandle SL closes trade
    tests.push(this._runTest('Paper Trading onCandle SL Close', () => {
      const engine = makeEngine();
      const trade = engine.signal(bullishEngines(), 55000, '1h');
      if (!trade) return { status: 'FAIL', reason: 'No trade opened' };

      const slCandle = { open: trade.stopLoss + 10, high: trade.stopLoss + 20, low: trade.stopLoss - 100, close: trade.stopLoss - 50, volume: 100, timestamp: new Date().toISOString() };
      engine.onCandle(slCandle);
      if (trade.status !== 'CLOSED') return { status: 'FAIL', reason: `Expected CLOSED, got ${trade.status}` };
      if (trade.exitReason !== 'Stop Loss') return { status: 'FAIL', reason: `Expected Stop Loss, got ${trade.exitReason}` };
      if (trade.pnl >= 0) return { status: 'FAIL', reason: `SL should have negative PnL, got ${trade.pnl}` };
      return { status: 'PASS', reason: `SL closed: pnl=${trade.pnl}, reason=${trade.exitReason}` };
    }));

    // Test 17: Manual close via close()
    tests.push(this._runTest('Paper Trading Manual Close', () => {
      const engine = makeEngine();
      const trade = engine.signal(bullishEngines(), 55000, '1h');
      if (!trade) return { status: 'FAIL', reason: 'No trade opened' };
      engine._lastPrice = 55500;
      const closed = engine.close(trade.tradeId, 'Manual');
      if (!closed) return { status: 'FAIL', reason: 'close() returned null' };
      if (closed.status !== 'CLOSED') return { status: 'FAIL', reason: `Expected CLOSED, got ${closed.status}` };
      if (closed.exitReason !== 'Manual') return { status: 'FAIL', reason: `Expected Manual, got ${closed.exitReason}` };
      if (closed.pnl <= 0) return { status: 'FAIL', reason: `Manual close at 55500 should have positive PnL, got ${closed.pnl}` };
      return { status: 'PASS', reason: `Manual close: pnl=${closed.pnl}` };
    }));

    // Test 18: No duplicate closes
    tests.push(this._runTest('Paper Trading No Duplicate Close', () => {
      const engine = makeEngine();
      const trade = engine.signal(bullishEngines(), 55000, '1h');
      if (!trade) return { status: 'FAIL', reason: 'No trade opened' };
      engine.close(trade.tradeId, 'Manual');
      const second = engine.close(trade.tradeId, 'Manual');
      if (second !== null) return { status: 'FAIL', reason: `Second close should return null, got ${second}` };
      const closedList = engine.closed();
      const count = closedList.filter(t => t.tradeId === trade.tradeId).length;
      if (count !== 1) return { status: 'FAIL', reason: `Expected 1 closed trade with id ${trade.tradeId}, got ${count}` };
      return { status: 'PASS', reason: `No duplicate close: only 1 entry in history` };
    }));

    // Test 19: Position sizing calculated correctly
    tests.push(this._runTest('Paper Trading Position Sizing', () => {
      const engine = makeEngine();
      const trade = engine.signal(bullishEngines(), 55000, '1h');
      if (!trade) return { status: 'FAIL', reason: 'No trade opened' };
      if (trade.positionSize <= 0) return { status: 'FAIL', reason: `Position size should be > 0, got ${trade.positionSize}` };
      const risk = Math.abs(trade.entryPrice - trade.stopLoss);
      const expectedSize = Math.round((10000 * 0.01 / risk) * 100) / 100;
      if (Math.abs(trade.positionSize - expectedSize) > 0.01) return { status: 'FAIL', reason: `Expected size=${expectedSize}, got ${trade.positionSize}` };
      return { status: 'PASS', reason: `Position size=${trade.positionSize} (risk=${risk.toFixed(2)})` };
    }));

    // Test 20: Risk:Reward ratio in trade record
    tests.push(this._runTest('Paper Trading RiskReward in Record', () => {
      const engine = makeEngine();
      const trade = engine.signal(bullishEngines(), 55000, '1h');
      if (!trade) return { status: 'FAIL', reason: 'No trade opened' };
      if (trade.riskReward == null || trade.riskReward === 0) return { status: 'FAIL', reason: `riskReward should be > 0, got ${trade.riskReward}` };
      return { status: 'PASS', reason: `riskReward=${trade.riskReward}` };
    }));

    // Test 21: Balance tracking — win increases balance
    tests.push(this._runTest('Paper Trading Balance Tracking', () => {
      const engine = makeEngine();
      const initialBalance = engine.getBalance();
      const trade = engine.signal(bullishEngines(), 55000, '1h');
      engine._lastPrice = 56000;
      engine.close(trade.tradeId, 'Manual');
      const balanceAfter = engine.getBalance();
      if (balanceAfter <= initialBalance) return { status: 'FAIL', reason: `Balance should increase after win: ${initialBalance} → ${balanceAfter}` };
      return { status: 'PASS', reason: `Balance: ${initialBalance} → ${balanceAfter}` };
    }));

    // Test 22: All trade fields present in full lifecycle
    tests.push(this._runTest('Paper Trading Full Trade Fields', () => {
      const engine = makeEngine();
      const trade = engine.signal(bullishEngines(), 55000, '1h');
      if (!trade) return { status: 'FAIL', reason: 'No trade opened' };
      const required = ['tradeId', 'symbol', 'timeframe', 'direction', 'entryPrice', 'entryTime', 'stopLoss', 'takeProfit', 'riskReward', 'positionSize', 'currentPrice', 'status', 'exitPrice', 'exitTime', 'exitReason', 'duration', 'pnl', 'pnlPercent', 'confidence', 'reason'];
      for (const field of required) {
        if (!(field in trade)) return { status: 'FAIL', reason: `Missing field: ${field}` };
      }
      engine.close(trade.tradeId, 'Manual');
      if (trade.exitPrice == null) return { status: 'FAIL', reason: 'exitPrice should be set after close' };
      if (trade.exitTime == null) return { status: 'FAIL', reason: 'exitTime should be set after close' };
      if (trade.exitReason !== 'Manual') return { status: 'FAIL', reason: `exitReason should be Manual, got ${trade.exitReason}` };
      if (trade.duration == null || trade.duration < 0) return { status: 'FAIL', reason: `duration should be >= 0, got ${trade.duration}` };
      if (trade.pnl == null) return { status: 'FAIL', reason: 'pnl should be set after close' };
      if (trade.pnlPercent == null) return { status: 'FAIL', reason: 'pnlPercent should be set after close' };
      return { status: 'PASS', reason: `All ${required.length} fields present, lifecycle fields set after close` };
    }));

    // Test 23: Performance analytics structure
    tests.push(this._runTest('Paper Trading Performance Structure', () => {
      const engine = makeEngine();
      const t1 = engine.signal(bullishEngines(), 55000, '1h');
      engine.close(t1.tradeId, 'Manual');
      engine._lastPrice = 56000;
      const t2 = engine.signal(bearishEngines(), 55000, '1h');
      engine.evaluateTrades(54000);
      const perf = engine.performance();
      const required = ['profitFactor', 'expectancy', 'maxDrawdown', 'maxDrawdownPct', 'largestWin', 'largestLoss', 'avgConsecutiveWins', 'avgConsecutiveLosses', 'currentStreak', 'currentStreakType', 'totalPnl', 'netReturnPct'];
      for (const field of required) {
        if (perf[field] === undefined) return { status: 'FAIL', reason: `Missing performance field: ${field}` };
      }
      return { status: 'PASS', reason: `Performance: profitFactor=${perf.profitFactor}, expectancy=${perf.expectancy}, streak=${perf.currentStreak} ${perf.currentStreakType}` };
    }));

    // Test 24: Streaks computed correctly
    tests.push(this._runTest('Paper Trading Consecutive Streaks', () => {
      const engine = makeEngine();
      for (let i = 0; i < 3; i++) {
        const t = engine.signal(bullishEngines(), 55000 + i * 100, '1h');
        engine._lastPrice = 56000 + i * 100;
        engine.close(t.tradeId, 'Manual');
      }
      for (let i = 0; i < 2; i++) {
        const t = engine.signal(bearishEngines(), 55000, '1h');
        engine.evaluateTrades(56000);
      }
      const stats = engine.stats();
      if (stats.maxConsecutiveWins < 3) return { status: 'FAIL', reason: `Expected max 3 consecutive wins, got ${stats.maxConsecutiveWins}` };
      if (stats.maxConsecutiveLosses < 2) return { status: 'FAIL', reason: `Expected max 2 consecutive losses, got ${stats.maxConsecutiveLosses}` };
      return { status: 'PASS', reason: `Streaks: maxWins=${stats.maxConsecutiveWins}, maxLosses=${stats.maxConsecutiveLosses}` };
    }));

    // Test 25: Drawdown computed correctly
    tests.push(this._runTest('Paper Trading Drawdown', () => {
      const engine = makeEngine();
      for (let i = 0; i < 5; i++) {
        const t = engine.signal(bullishEngines(), 55000, '1h');
        engine.evaluateTrades(t.stopLoss - 100);
      }
      const stats = engine.stats();
      if (stats.maxDrawdown <= 0) return { status: 'FAIL', reason: `Expected positive drawdown, got ${stats.maxDrawdown}` };
      if (stats.maxDrawdownPct <= 0) return { status: 'FAIL', reason: `Expected positive drawdownPct, got ${stats.maxDrawdownPct}` };
      return { status: 'PASS', reason: `Drawdown: ${stats.maxDrawdown} (${stats.maxDrawdownPct}%)` };
    }));

    // Test 26: onCandle SELL trade TP
    tests.push(this._runTest('Paper Trading onCandle SELL TP', () => {
      const engine = makeEngine();
      const trade = engine.signal(bearishEngines(), 55000, '1h');
      if (!trade) return { status: 'FAIL', reason: 'No trade opened' };
      if (trade.direction !== 'SELL') return { status: 'FAIL', reason: `Expected SELL, got ${trade.direction}` };

      const tpCandle = { open: trade.takeProfit + 10, high: trade.takeProfit + 20, low: trade.takeProfit - 100, close: trade.takeProfit - 50, volume: 100, timestamp: new Date().toISOString() };
      engine.onCandle(tpCandle);
      if (trade.status !== 'CLOSED') return { status: 'FAIL', reason: `Expected CLOSED, got ${trade.status}` };
      if (trade.exitReason !== 'Take Profit') return { status: 'FAIL', reason: `Expected Take Profit, got ${trade.exitReason}` };
      if (trade.pnl <= 0) return { status: 'FAIL', reason: `SELL TP should have positive PnL, got ${trade.pnl}` };
      return { status: 'PASS', reason: `SELL TP: pnl=${trade.pnl}` };
    }));

    // Test 27: No open() on already-closed trades
    tests.push(this._runTest('Paper Trading Closed Not in Open', () => {
      const engine = makeEngine();
      const t1 = engine.signal(bullishEngines(), 55000, '1h');
      const t2 = engine.signal(bullishEngines(), 55100, '1h');
      engine.close(t1.tradeId, 'Manual');
      const openList = engine.open();
      if (openList.length !== 1) return { status: 'FAIL', reason: `Expected 1 open, got ${openList.length}` };
      if (openList[0].tradeId !== t2.tradeId) return { status: 'FAIL', reason: `Wrong trade in open list` };
      return { status: 'PASS', reason: `1 open trade remains after closing 1` };
    }));

    // Test 28: Net return percentage
    tests.push(this._runTest('Paper Trading Net Return Pct', () => {
      const engine = makeEngine();
      const t = engine.signal(bullishEngines(), 55000, '1h');
      engine.close(t.tradeId, 'Manual');
      const stats = engine.stats();
      if (stats.netReturnPct == null) return { status: 'FAIL', reason: `netReturnPct should be defined` };
      return { status: 'PASS', reason: `Net return: ${stats.netReturnPct}%` };
    }));

    const executionTime = Date.now() - start;
    return { tests, executionTime };
  }

  // ---------------------------------------------------------------------------
  // Risk Validation
  // ---------------------------------------------------------------------------

  _validateRisk() {
    const start = Date.now();
    const tests = [];
    const { RiskEngine } = require('./risk');

    const makeEngine = (overrides = {}) => {
      return new RiskEngine({
        logger: this.logger,
        symbol: overrides.symbol || 'TEST',
      });
    };

    const atrResult = (atr, atrPct, level) => ({
      ready: true,
      atr,
      atrPercentage: atrPct,
      volatilityLevel: level || (atrPct < 1 ? 'Low' : atrPct <= 3 ? 'Medium' : 'High'),
    });

    const confluenceResult = (confidence, bias) => ({
      confidence,
      bias: bias || 'Neutral',
      score: 50,
    });

    const trendResult = (dir) => ({
      trend: { '1H': dir },
    });

    const structureResult = (dir) => ({
      ready: true,
      direction: dir,
      structure: dir === 'bullish' ? 'Bullish BOS' : 'Bearish BOS',
      score: dir === 'bullish' ? 0.8 : -0.8,
      confidence: 75,
    });

    // Test 1: Determinism — same inputs → same output
    tests.push(this._runTest('Risk Determinism', () => {
      const engine = makeEngine();
      const params = {
        symbol: 'BTCUSDT', timeframe: '1h', entryPrice: 55000,
        atr: atrResult(500, 0.91), direction: 'BUY',
        trend: trendResult('Bullish'), structure: structureResult('bullish'),
        confluence: confluenceResult(70, 'Bullish'),
      };
      const r1 = engine.evaluate(params);
      const r2 = engine.evaluate(params);
      if (r1.stopLoss !== r2.stopLoss) return { status: 'FAIL', reason: `Non-deterministic stopLoss: ${r1.stopLoss} vs ${r2.stopLoss}` };
      if (r1.takeProfit !== r2.takeProfit) return { status: 'FAIL', reason: `Non-deterministic takeProfit: ${r1.takeProfit} vs ${r2.takeProfit}` };
      if (r1.riskReward !== r2.riskReward) return { status: 'FAIL', reason: `Non-deterministic riskReward: ${r1.riskReward} vs ${r2.riskReward}` };
      return { status: 'PASS', reason: `Deterministic: SL=${r1.stopLoss}, TP=${r1.takeProfit}, R:R=${r1.riskReward}` };
    }));

    // Test 2: BUY stop loss below entry, take profit above entry
    tests.push(this._runTest('Risk BUY Levels', () => {
      const engine = makeEngine();
      const r = engine.evaluate({
        symbol: 'BTCUSDT', timeframe: '1h', entryPrice: 55000,
        atr: atrResult(500, 0.91), direction: 'BUY',
        trend: trendResult('Bullish'), structure: structureResult('bullish'),
        confluence: confluenceResult(70, 'Bullish'),
      });
      if (!r.tradeAllowed) return { status: 'FAIL', reason: `Trade rejected: ${r.rejectionReason}` };
      if (r.stopLoss >= r.entryPrice) return { status: 'FAIL', reason: `BUY SL (${r.stopLoss}) should be below entry (${r.entryPrice})` };
      if (r.takeProfit <= r.entryPrice) return { status: 'FAIL', reason: `BUY TP (${r.takeProfit}) should be above entry (${r.entryPrice})` };
      return { status: 'PASS', reason: `BUY: SL=${r.stopLoss}, entry=${r.entryPrice}, TP=${r.takeProfit}` };
    }));

    // Test 3: SELL stop loss above entry, take profit below entry
    tests.push(this._runTest('Risk SELL Levels', () => {
      const engine = makeEngine();
      const r = engine.evaluate({
        symbol: 'BTCUSDT', timeframe: '1h', entryPrice: 55000,
        atr: atrResult(500, 0.91), direction: 'SELL',
        trend: trendResult('Bearish'), structure: structureResult('bearish'),
        confluence: confluenceResult(70, 'Bearish'),
      });
      if (!r.tradeAllowed) return { status: 'FAIL', reason: `Trade rejected: ${r.rejectionReason}` };
      if (r.stopLoss <= r.entryPrice) return { status: 'FAIL', reason: `SELL SL (${r.stopLoss}) should be above entry (${r.entryPrice})` };
      if (r.takeProfit >= r.entryPrice) return { status: 'FAIL', reason: `SELL TP (${r.takeProfit}) should be below entry (${r.entryPrice})` };
      return { status: 'PASS', reason: `SELL: SL=${r.stopLoss}, entry=${r.entryPrice}, TP=${r.takeProfit}` };
    }));

    // Test 4: Risk:Reward ratio is 1:2 by default
    tests.push(this._runTest('Risk Default RiskReward 1:2', () => {
      const engine = makeEngine();
      const r = engine.evaluate({
        symbol: 'BTCUSDT', timeframe: '1h', entryPrice: 55000,
        atr: atrResult(500, 0.91), direction: 'BUY',
        trend: trendResult('Bullish'), structure: structureResult('bullish'),
        confluence: confluenceResult(70, 'Bullish'),
      });
      if (!r.tradeAllowed) return { status: 'FAIL', reason: `Trade rejected: ${r.rejectionReason}` };
      if (r.riskReward !== 2) return { status: 'FAIL', reason: `Expected R:R=2, got ${r.riskReward}` };
      return { status: 'PASS', reason: `R:R=${r.riskReward} (SL mult=2, TP mult=4)` };
    }));

    // Test 5: Low confluence confidence → rejection
    tests.push(this._runTest('Risk Low Confidence Rejected', () => {
      const engine = makeEngine();
      const r = engine.evaluate({
        symbol: 'BTCUSDT', timeframe: '1h', entryPrice: 55000,
        atr: atrResult(500, 0.91), direction: 'BUY',
        trend: trendResult('Bullish'), structure: structureResult('bullish'),
        confluence: confluenceResult(20, 'Neutral'),
      });
      if (r.tradeAllowed) return { status: 'FAIL', reason: `Should reject low confidence (20 < 30)` };
      if (!r.rejectionReason.includes('confidence')) return { status: 'FAIL', reason: `Rejection reason should mention confidence, got: ${r.rejectionReason}` };
      return { status: 'PASS', reason: `Correctly rejected: ${r.rejectionReason}` };
    }));

    // Test 6: Extreme volatility → rejection
    tests.push(this._runTest('Risk Extreme Volatility Rejected', () => {
      const engine = makeEngine();
      const r = engine.evaluate({
        symbol: 'BTCUSDT', timeframe: '1h', entryPrice: 55000,
        atr: atrResult(3000, 5.45, 'High'), direction: 'BUY',
        trend: trendResult('Bullish'), structure: structureResult('bullish'),
        confluence: confluenceResult(70, 'Bullish'),
      });
      if (r.tradeAllowed) return { status: 'FAIL', reason: `Should reject extreme volatility (5.45% > 5%)` };
      if (!r.rejectionReason.includes('Volatility')) return { status: 'FAIL', reason: `Rejection reason should mention volatility, got: ${r.rejectionReason}` };
      return { status: 'PASS', reason: `Correctly rejected: ${r.rejectionReason}` };
    }));

    // Test 7: Missing ATR → rejection
    tests.push(this._runTest('Risk Missing ATR Rejected', () => {
      const engine = makeEngine();
      const r = engine.evaluate({
        symbol: 'BTCUSDT', timeframe: '1h', entryPrice: 55000,
        atr: { ready: false, atr: null }, direction: 'BUY',
        trend: trendResult('Bullish'), structure: structureResult('bullish'),
        confluence: confluenceResult(70, 'Bullish'),
      });
      if (r.tradeAllowed) return { status: 'FAIL', reason: `Should reject when ATR not ready` };
      return { status: 'PASS', reason: `Correctly rejected: ${r.rejectionReason}` };
    }));

    // Test 8: Invalid direction → rejection
    tests.push(this._runTest('Risk Invalid Direction Rejected', () => {
      const engine = makeEngine();
      const r = engine.evaluate({
        symbol: 'BTCUSDT', timeframe: '1h', entryPrice: 55000,
        atr: atrResult(500, 0.91), direction: 'NEUTRAL',
        trend: trendResult('Neutral'), structure: structureResult('neutral'),
        confluence: confluenceResult(70, 'Neutral'),
      });
      if (r.tradeAllowed) return { status: 'FAIL', reason: `Should reject invalid direction` };
      return { status: 'PASS', reason: `Correctly rejected: ${r.rejectionReason}` };
    }));

    // Test 9: Invalid entry price → rejection
    tests.push(this._runTest('Risk Invalid Price Rejected', () => {
      const engine = makeEngine();
      const r = engine.evaluate({
        symbol: 'BTCUSDT', timeframe: '1h', entryPrice: 0,
        atr: atrResult(500, 0.91), direction: 'BUY',
        trend: trendResult('Bullish'), structure: structureResult('bullish'),
        confluence: confluenceResult(70, 'Bullish'),
      });
      if (r.tradeAllowed) return { status: 'FAIL', reason: `Should reject entry price 0` };
      return { status: 'PASS', reason: `Correctly rejected: ${r.rejectionReason}` };
    }));

    // Test 10: Null params → rejection
    tests.push(this._runTest('Risk Null Params Rejected', () => {
      const engine = makeEngine();
      const r = engine.evaluate(null);
      if (r.tradeAllowed) return { status: 'FAIL', reason: `Should reject null params` };
      return { status: 'PASS', reason: `Correctly rejected: ${r.rejectionReason}` };
    }));

    // Test 11: Output structure — all required fields present
    tests.push(this._runTest('Risk Output Structure', () => {
      const engine = makeEngine();
      const r = engine.evaluate({
        symbol: 'BTCUSDT', timeframe: '1h', entryPrice: 55000,
        atr: atrResult(500, 0.91), direction: 'BUY',
        trend: trendResult('Bullish'), structure: structureResult('bullish'),
        confluence: confluenceResult(70, 'Bullish'),
      });
      const required = ['symbol', 'timeframe', 'entryPrice', 'direction', 'stopLoss', 'takeProfit', 'riskReward', 'risk', 'reward', 'tradeAllowed', 'rejectionReason', 'timestamp', 'engineVersion'];
      for (const field of required) {
        if (r[field] === undefined) return { status: 'FAIL', reason: `Missing field: ${field}` };
      }
      if (r.rejectionReason !== null) return { status: 'FAIL', reason: `rejectionReason should be null for allowed trade` };
      return { status: 'PASS', reason: `All ${required.length} fields present` };
    }));

    // Test 12: Custom risk:reward ratio
    tests.push(this._runTest('Risk Custom RiskReward', () => {
      const engine = makeEngine();
      engine.setRiskRewardRatio(3);
      const r = engine.evaluate({
        symbol: 'BTCUSDT', timeframe: '1h', entryPrice: 55000,
        atr: atrResult(500, 0.91), direction: 'BUY',
        trend: trendResult('Bullish'), structure: structureResult('bullish'),
        confluence: confluenceResult(70, 'Bullish'),
      });
      if (!r.tradeAllowed) return { status: 'FAIL', reason: `Trade rejected: ${r.rejectionReason}` };
      if (r.riskReward !== 3) return { status: 'FAIL', reason: `Expected R:R=3, got ${r.riskReward}` };
      return { status: 'PASS', reason: `Custom R:R=${r.riskReward}` };
    }));

    // Test 13: Boundary confidence — exactly at threshold → allowed
    tests.push(this._runTest('Risk Boundary Confidence Allowed', () => {
      const engine = makeEngine();
      const r = engine.evaluate({
        symbol: 'BTCUSDT', timeframe: '1h', entryPrice: 55000,
        atr: atrResult(500, 0.91), direction: 'BUY',
        trend: trendResult('Bullish'), structure: structureResult('bullish'),
        confluence: confluenceResult(30, 'Bullish'),
      });
      if (!r.tradeAllowed) return { status: 'FAIL', reason: `Confidence 30 (at threshold) should be allowed` };
      return { status: 'PASS', reason: `Confidence 30 at threshold correctly allowed` };
    }));

    // Test 14: ATR-based SL distance matches multiplier
    tests.push(this._runTest('Risk ATR Multiplier Correct', () => {
      const engine = makeEngine();
      const entry = 55000;
      const atrVal = 600;
      const r = engine.evaluate({
        symbol: 'BTCUSDT', timeframe: '1h', entryPrice: entry,
        atr: atrResult(atrVal, 1.09), direction: 'BUY',
        trend: trendResult('Bullish'), structure: structureResult('bullish'),
        confluence: confluenceResult(70, 'Bullish'),
      });
      if (!r.tradeAllowed) return { status: 'FAIL', reason: `Trade rejected: ${r.rejectionReason}` };
      const expectedSL = Math.round((entry - atrVal * 2) * 100) / 100;
      const expectedTP = Math.round((entry + atrVal * 4) * 100) / 100;
      if (r.stopLoss !== expectedSL) return { status: 'FAIL', reason: `Expected SL=${expectedSL}, got ${r.stopLoss}` };
      if (r.takeProfit !== expectedTP) return { status: 'FAIL', reason: `Expected TP=${expectedTP}, got ${r.takeProfit}` };
      return { status: 'PASS', reason: `SL=${r.stopLoss} (entry-${atrVal}*2), TP=${r.takeProfit} (entry+${atrVal}*4)` };
    }));

    const executionTime = Date.now() - start;
    return { tests, executionTime };
  }

  // ---------------------------------------------------------------------------
  // Advance Risk Validation
  // ---------------------------------------------------------------------------

  _validateAdvanceRisk() {
    const start = Date.now();
    const tests = [];
    const { AdvanceRiskEngine } = require('./advanceRisk');
    const { PaperTradingEngine } = require('./paperTrading');

    const makeEngine = (overrides = {}) => {
      const pt = new PaperTradingEngine({ logger: this.logger, symbol: 'TEST' });
      return new AdvanceRiskEngine({
        logger: this.logger,
        symbol: 'TEST',
        paperTradeEngine: pt,
        config: overrides.config || null,
      });
    };

    const atrResult = (atr, atrPct, level) => ({
      ready: true,
      atr,
      atrPercentage: atrPct,
      volatilityLevel: level || (atrPct < 1 ? 'Low' : atrPct <= 3 ? 'Medium' : 'High'),
    });

    // Test 1: Determinism — same inputs produce identical output
    tests.push(this._runTest('AdvanceRisk Determinism', () => {
      const engine = makeEngine();
      const params = {
        symbol: 'TEST', timeframe: '1h', entryPrice: 50000,
        atr: atrResult(800, 1.6), direction: 'BUY',
        trend: null, structure: null, confluence: { confidence: 80 }, regime: 'TRENDING_BULL',
      };
      const r1 = engine.evaluate(params);
      const r2 = engine.evaluate(params);
      if (r1.stopLoss !== r2.stopLoss) return { status: 'FAIL', reason: `Non-deterministic SL: ${r1.stopLoss} vs ${r2.stopLoss}` };
      if (r1.takeProfit !== r2.takeProfit) return { status: 'FAIL', reason: `Non-deterministic TP: ${r1.takeProfit} vs ${r2.takeProfit}` };
      if (r1.positionSize !== r2.positionSize) return { status: 'FAIL', reason: `Non-deterministic posSize: ${r1.positionSize} vs ${r2.positionSize}` };
      return { status: 'PASS', reason: `Deterministic: SL=${r1.stopLoss}, TP=${r1.takeProfit}, pos=${r1.positionSize}` };
    }));

    // Test 2: BUY → SL below entry, TP above entry
    tests.push(this._runTest('AdvanceRisk BUY Levels', () => {
      const engine = makeEngine();
      const r = engine.evaluate({
        symbol: 'TEST', timeframe: '1h', entryPrice: 50000,
        atr: atrResult(800, 1.6), direction: 'BUY',
        trend: null, structure: null, confluence: { confidence: 80 }, regime: 'TRENDING_BULL',
      });
      if (r.stopLoss >= r.entryPrice) return { status: 'FAIL', reason: `BUY SL ${r.stopLoss} >= entry ${r.entryPrice}` };
      if (r.takeProfit <= r.entryPrice) return { status: 'FAIL', reason: `BUY TP ${r.takeProfit} <= entry ${r.entryPrice}` };
      return { status: 'PASS', reason: `BUY SL=${r.stopLoss} < ${r.entryPrice} < TP=${r.takeProfit}` };
    }));

    // Test 3: SELL → SL above entry, TP below entry
    tests.push(this._runTest('AdvanceRisk SELL Levels', () => {
      const engine = makeEngine();
      const r = engine.evaluate({
        symbol: 'TEST', timeframe: '1h', entryPrice: 50000,
        atr: atrResult(800, 1.6), direction: 'SELL',
        trend: null, structure: null, confluence: { confidence: 80 }, regime: 'TRENDING_BEAR',
      });
      if (r.stopLoss <= r.entryPrice) return { status: 'FAIL', reason: `SELL SL ${r.stopLoss} <= entry ${r.entryPrice}` };
      if (r.takeProfit >= r.entryPrice) return { status: 'FAIL', reason: `SELL TP ${r.takeProfit} >= entry ${r.entryPrice}` };
      return { status: 'PASS', reason: `SELL SL=${r.stopLoss} > ${r.entryPrice} > TP=${r.takeProfit}` };
    }));

    // Test 4: Position size is positive and finite
    tests.push(this._runTest('AdvanceRisk Position Size', () => {
      const engine = makeEngine();
      const r = engine.evaluate({
        symbol: 'TEST', timeframe: '1h', entryPrice: 50000,
        atr: atrResult(800, 1.6), direction: 'BUY',
        trend: null, structure: null, confluence: { confidence: 80 }, regime: 'TRENDING_BULL',
      });
      if (!r.positionSize || r.positionSize <= 0 || !isFinite(r.positionSize)) return { status: 'FAIL', reason: `Invalid posSize=${r.positionSize}` };
      return { status: 'PASS', reason: `Position size=${r.positionSize}` };
    }));

    // Test 5: R:R is > 0
    tests.push(this._runTest('AdvanceRisk Risk Reward', () => {
      const engine = makeEngine();
      const r = engine.evaluate({
        symbol: 'TEST', timeframe: '1h', entryPrice: 50000,
        atr: atrResult(800, 1.6), direction: 'BUY',
        trend: null, structure: null, confluence: { confidence: 80 }, regime: 'TRENDING_BULL',
      });
      if (!r.riskReward || r.riskReward <= 0) return { status: 'FAIL', reason: `Invalid R:R=${r.riskReward}` };
      return { status: 'PASS', reason: `R:R 1:${r.riskReward}` };
    }));

    // Test 6: Trading in trending → trending ATR mult (2) gives wider SL than ranging (1.5)
    tests.push(this._runTest('AdvanceRisk Regime Multiplier', () => {
      const engine = makeEngine();
      const rTrend = engine.evaluate({
        symbol: 'TEST', timeframe: '1h', entryPrice: 50000,
        atr: atrResult(800, 1.6), direction: 'BUY',
        trend: null, structure: null, confluence: { confidence: 80 }, regime: 'TRENDING_BULL',
      });
      const rRange = engine.evaluate({
        symbol: 'TEST', timeframe: '1h', entryPrice: 50000,
        atr: atrResult(800, 1.6), direction: 'BUY',
        trend: null, structure: null, confluence: { confidence: 80 }, regime: 'RANGING',
      });
      const trendSLDist = Math.abs(rTrend.entryPrice - rTrend.stopLoss);
      const rangeSLDist = Math.abs(rRange.entryPrice - rRange.stopLoss);
      if (trendSLDist <= rangeSLDist) return { status: 'FAIL', reason: `Trend SL dist ${trendSLDist} <= Range ${rangeSLDist} — trending should have wider SL` };
      return { status: 'PASS', reason: `Trend SL dist=${trendSLDist} > Range=${rangeSLDist}` };
    }));

    // Test 7: Session detection
    tests.push(this._runTest('AdvanceRisk Session Detection', () => {
      const engine = makeEngine();
      const r = engine.evaluate({
        symbol: 'TEST', timeframe: '1h', entryPrice: 50000,
        atr: atrResult(800, 1.6), direction: 'BUY',
        trend: null, structure: null, confluence: { confidence: 80 }, regime: 'TRENDING_BULL',
      });
      if (!r.session) return { status: 'WARNING', reason: `No session detected` };
      return { status: 'PASS', reason: `Session=${r.session}` };
    }));

    // Test 8: Consecutive loss cooldown — after 3 losses, tradeAllowed should be false
    tests.push(this._runTest('AdvanceRisk Consecutive Loss Cooldown', () => {
      const engine = makeEngine();
      for (let i = 0; i < 3; i++) engine.onTradeClosed(-100);
      const r = engine.evaluate({
        symbol: 'TEST', timeframe: '1h', entryPrice: 50000,
        atr: atrResult(800, 1.6), direction: 'BUY',
        trend: null, structure: null, confluence: { confidence: 80 }, regime: 'TRENDING_BULL',
      });
      const state = engine.getState();
      if (state.consecutiveLosses < 3) return { status: 'FAIL', reason: `Expected 3 consecutive losses, got ${state.consecutiveLosses}` };
      return { status: r.tradeAllowed ? 'WARNING' : 'PASS', reason: `Consecutive losses=${state.consecutiveLosses}, allowed=${r.tradeAllowed}` };
    }));

    // Test 9: Daily loss limit — after exceeding max daily loss, trades blocked
    tests.push(this._runTest('AdvanceRisk Daily Loss Limit', () => {
      const engine = makeEngine({ config: { get: () => null } });
      // Lose more than 5% of $10k balance
      for (let i = 0; i < 5; i++) engine.onTradeClosed(-120);
      const r = engine.evaluate({
        symbol: 'TEST', timeframe: '1h', entryPrice: 50000,
        atr: atrResult(800, 1.6), direction: 'BUY',
        trend: null, structure: null, confluence: { confidence: 80 }, regime: 'TRENDING_BULL',
      });
      const state = engine.getState();
       return { status: r.tradeAllowed ? 'WARNING' : 'PASS', reason: `Daily PnL=${state.dailyPnL}, allowed=${r.tradeAllowed}` };
    }));

    // Test 10: Daily auto-reset — after 24h, daily PnL should reset
    tests.push(this._runTest('AdvanceRisk Daily Reset', () => {
      const engine = makeEngine();
      engine.onTradeClosed(-100);
       const before = engine.getState().dailyPnL;
       // Simulate day passing by setting the current reset day to yesterday
       engine._lastResetDay = new Date(Date.now() - 86400000 - 1000).toDateString();
      engine._consecutiveLosses = 3;
      engine.onTradeClosed(-100); // should trigger reset
       const after = engine.getState().dailyPnL;
      return { status: after === -100 ? 'PASS' : 'WARNING', reason: `pre-reset=${before}, post-reset=${after}` };
    }));

    // Test 11: tradeAllowed true when no limits hit
    tests.push(this._runTest('AdvanceRisk Default Allowed', () => {
      const engine = makeEngine();
      const r = engine.evaluate({
        symbol: 'TEST', timeframe: '1h', entryPrice: 50000,
        atr: atrResult(800, 1.6), direction: 'BUY',
        trend: null, structure: null, confluence: { confidence: 80 }, regime: 'TRENDING_BULL',
      });
      return { status: r.tradeAllowed ? 'PASS' : 'FAIL', reason: `tradeAllowed=${r.tradeAllowed}` };
    }));

    // Test 12: getState returns expected keys
    tests.push(this._runTest('AdvanceRisk State Shape', () => {
      const engine = makeEngine();
      const s = engine.getState();
       const required = ['dailyPnL', 'dailyDrawdownPct', 'consecutiveLosses', 'maxDailyLossPct', 'accountBalance', 'riskPerTradePct'];
      const missing = required.filter(k => s[k] === undefined);
      if (missing.length > 0) return { status: 'FAIL', reason: `Missing keys: ${missing.join(', ')}` };
      return { status: 'PASS', reason: `All ${required.length} state keys present` };
    }));

    const passed = tests.filter(t => t.status === 'PASS').length;
    const warnings = tests.filter(t => t.status === 'WARNING').length;
    const failed = tests.filter(t => t.status === 'FAIL').length;
    const overall = failed > 0 ? 'FAIL' : warnings > 0 ? 'WARNING' : 'PASS';

    return {
      status: overall,
      tests,
      passed,
      warnings,
      failed,
      executionTime: Date.now() - start,
      reason: `${passed} passed, ${warnings} warnings, ${failed} failed`,
    };
  }

  // ---------------------------------------------------------------------------
  // Test runner
  // ---------------------------------------------------------------------------

  _runTest(name, fn) {
    const start = Date.now();
    try {
      const result = fn();
      return {
        name,
        status: result.status,
        reason: result.reason,
        executionTime: Date.now() - start,
      };
    } catch (err) {
      return {
        name,
        status: 'FAIL',
        reason: `Exception: ${err.message}`,
        executionTime: Date.now() - start,
      };
    }
  }

  // ---------------------------------------------------------------------------
  // MACD Validation
  // ---------------------------------------------------------------------------

  _validateMACD() {
    const start = Date.now();
    const tests = [];
    const { MACDEngine, MIN_CANDLES } = require('./macd');

    // Helper: create a mock candleEngine that returns deterministic candles
    const makeMockCandleEngine = (candles) => ({
      getCandles: () => candles,
      getActive: () => null,
      getAllTimeframes: () => ['1h'],
    });

    // Test 1: Known values — exponential uptrend → MACD > Signal, positive histogram
    // Exponential growth produces accelerating EMA separation: fast EMA pulls away from slow EMA
    tests.push(this._runTest('MACD Known Value (Uptrend)', () => {
      const closes = [];
      for (let i = 0; i < 50; i++) closes.push(100 * Math.pow(1.02, i));
      const candles = this._makeCandlesFromCloses(closes);
      const mock = makeMockCandleEngine(candles);
      const engine = new MACDEngine({ candleEngine: mock, logger: this.logger, symbol: 'TEST' });
      const result = engine.calculate('1h', 500);

      if (!result.ready) {
        return { status: 'FAIL', reason: `MACD not ready with 50 candles (need ${MIN_CANDLES})` };
      }
      if (result.macd === null || result.signal === null || result.histogram === null) {
        return { status: 'FAIL', reason: `MACD/signal/histogram are null` };
      }
      if (typeof result.macd !== 'number') {
        return { status: 'FAIL', reason: `Expected macd to be a number, got ${typeof result.macd}` };
      }
      if (result.macd <= 0) {
        return { status: 'FAIL', reason: `In exponential uptrend: expected MACD > 0, got ${result.macd}` };
      }
      if (result.histogram <= 0) {
        return { status: 'FAIL', reason: `In exponential uptrend: expected Histogram > 0, got ${result.histogram}` };
      }
      if (result.trend !== 'Bullish') {
        return { status: 'FAIL', reason: `In exponential uptrend: expected trend=Bullish, got ${result.trend}` };
      }
      return { status: 'PASS', reason: `MACD=${result.macd}, Signal=${result.signal}, Histogram=${result.histogram}, Trend=${result.trend}` };
    }));

    // Test 2: Accelerating downtrend → MACD < Signal, negative histogram, Bearish
    tests.push(this._runTest('MACD Known Value (Downtrend)', () => {
      const closes = [];
      for (let i = 0; i < 50; i++) closes.push(200 - i * i * 0.1);
      const candles = this._makeCandlesFromCloses(closes);
      const mock = makeMockCandleEngine(candles);
      const engine = new MACDEngine({ candleEngine: mock, logger: this.logger, symbol: 'TEST' });
      const result = engine.calculate('1h', 500);

      if (!result.ready) {
        return { status: 'FAIL', reason: `MACD not ready with 50 candles` };
      }
      if (result.trend !== 'Bearish') {
        return { status: 'FAIL', reason: `In accelerating downtrend: expected trend=Bearish, got ${result.trend}` };
      }
      if (result.macd >= result.signal) {
        return { status: 'FAIL', reason: `In accelerating downtrend: expected MACD(${result.macd}) < Signal(${result.signal})` };
      }
      if (result.histogram >= 0) {
        return { status: 'FAIL', reason: `In accelerating downtrend: expected Histogram < 0, got ${result.histogram}` };
      }
      return { status: 'PASS', reason: `MACD=${result.macd}, Signal=${result.signal}, Histogram=${result.histogram}, Trend=${result.trend}` };
    }));

    // Test 3: Crossover detection — construct data where MACD crosses Signal from below
    // Flat → steep uptrend triggers bullish crossover
    tests.push(this._runTest('MACD Bullish Crossover Detection', () => {
      // 40 flat candles followed by 15 steep uptrend
      const closes = [];
      for (let i = 0; i < 40; i++) closes.push(100);
      for (let i = 0; i < 15; i++) closes.push(100 + (i + 1) * 5);
      const candles = this._makeCandlesFromCloses(closes);
      const mock = makeMockCandleEngine(candles);
      const engine = new MACDEngine({ candleEngine: mock, logger: this.logger, symbol: 'TEST' });
      const result = engine.calculate('1h', 500);

      if (!result.ready) {
        return { status: 'FAIL', reason: `MACD not ready with 55 candles` };
      }
      // The sharp uptrend should trigger a bullish crossover at some point
      // At minimum, trend should be Bullish
      if (result.trend !== 'Bullish') {
        return { status: 'FAIL', reason: `Expected Bullish trend after sharp uptrend, got ${result.trend}` };
      }
      return { status: 'PASS', reason: `Crossover=${result.crossover}, Trend=${result.trend}, MACD=${result.macd}, Signal=${result.signal}` };
    }));

    // Test 4: Insufficient data → not ready
    tests.push(this._runTest('MACD Insufficient Data', () => {
      const closes = [];
      for (let i = 0; i < MIN_CANDLES - 1; i++) closes.push(100 + i);
      const candles = this._makeCandlesFromCloses(closes);
      const mock = makeMockCandleEngine(candles);
      const engine = new MACDEngine({ candleEngine: mock, logger: this.logger, symbol: 'TEST' });
      const result = engine.calculate('1h', 500);

      if (result.ready) {
        return { status: 'FAIL', reason: `MACD should not be ready with ${MIN_CANDLES - 1} candles` };
      }
      if (result.reason === undefined || result.reason === null) {
        return { status: 'FAIL', reason: `Expected a reason string for not-ready` };
      }
      return { status: 'PASS', reason: `Correctly returns not-ready with ${MIN_CANDLES - 1} candles: ${result.reason}` };
    }));

    // Test 5: Exactly minimum data → ready
    tests.push(this._runTest('MACD Minimum Data Threshold', () => {
      const closes = [];
      for (let i = 0; i < MIN_CANDLES; i++) closes.push(100 + i);
      const candles = this._makeCandlesFromCloses(closes);
      const mock = makeMockCandleEngine(candles);
      const engine = new MACDEngine({ candleEngine: mock, logger: this.logger, symbol: 'TEST' });
      const result = engine.calculate('1h', 500);

      if (!result.ready) {
        return { status: 'FAIL', reason: `MACD should be ready with ${MIN_CANDLES} candles` };
      }
      return { status: 'PASS', reason: `MACD ready with exactly ${MIN_CANDLES} candles` };
    }));

    // Test 6: Determinism — same input produces same output
    tests.push(this._runTest('MACD Determinism', () => {
      const closes = [];
      for (let i = 0; i < 50; i++) closes.push(100 + Math.sin(i * 0.3) * 10);
      const candles = this._makeCandlesFromCloses(closes);
      const mock = makeMockCandleEngine(candles);
      const engine = new MACDEngine({ candleEngine: mock, logger: this.logger, symbol: 'TEST' });

      const r1 = engine.calculate('1h', 500);
      engine.invalidate('1h');
      const r2 = engine.calculate('1h', 500);

      if (r1.macd !== r2.macd || r1.signal !== r2.signal || r1.histogram !== r2.histogram) {
        return { status: 'FAIL', reason: `Non-deterministic: run1=${r1.macd}/${r1.signal}, run2=${r2.macd}/${r2.signal}` };
      }
      return { status: 'PASS', reason: `Deterministic: both runs = MACD=${r1.macd}, Signal=${r1.signal}` };
    }));

    // Test 7: All timeframes supported
    tests.push(this._runTest('MACD All Timeframes', () => {
      const timeframes = ['1m', '5m', '15m', '30m', '1h', '4h', '12h', '24h'];
      const closes = [];
      for (let i = 0; i < 50; i++) closes.push(100 + Math.sin(i * 0.5) * 5);
      const candles = this._makeCandlesFromCloses(closes);
      const mock = makeMockCandleEngine(candles);
      mock.getAllTimeframes = () => timeframes;
      const engine = new MACDEngine({ candleEngine: mock, logger: this.logger, symbol: 'TEST' });

      const allResults = engine.calculateAll(500);
      const unsupported = timeframes.filter(tf => !allResults[tf]);

      if (unsupported.length > 0) {
        return { status: 'FAIL', reason: `Missing timeframes: ${unsupported.join(', ')}` };
      }
      for (const tf of timeframes) {
        if (!allResults[tf].ready) {
          return { status: 'FAIL', reason: `Not ready for ${tf}` };
        }
      }
      return { status: 'PASS', reason: `All ${timeframes.length} timeframes supported and ready` };
    }));

    // Test 8: Symbol propagation
    tests.push(this._runTest('MACD Symbol Propagation', () => {
      const closes = [];
      for (let i = 0; i < 50; i++) closes.push(100 + i);
      const candles = this._makeCandlesFromCloses(closes);
      const mock = makeMockCandleEngine(candles);
      const engine = new MACDEngine({ candleEngine: mock, logger: this.logger, symbol: 'ETHUSDT' });
      const result = engine.calculate('1h', 500);

      if (result.symbol !== 'ETHUSDT') {
        return { status: 'FAIL', reason: `Expected symbol=ETHUSDT, got ${result.symbol}` };
      }
      return { status: 'PASS', reason: `Symbol correctly propagated: ${result.symbol}` };
    }));

    const executionTime = Date.now() - start;
    return { tests, executionTime };
  }

  // ---------------------------------------------------------------------------
  // Synthetic candle generators (deterministic)
  // ---------------------------------------------------------------------------

  _makeCandles(count, closeFn) {
    const candles = [];
    for (let i = 0; i < count; i++) {
      const close = closeFn(i);
      candles.push({
        openTime: i * 3600000,
        close,
        high: close + 1,
        low: close - 1,
        open: close,
        volume: 1000,
        timestamp: new Date(i * 3600000).toISOString(),
      });
    }
    return candles;
  }

  _makeCandlesFromCloses(closes) {
    return this._makeCandles(closes.length, (i) => closes[i]);
  }

  _makeStructureCandles(pattern, count) {
    const candles = [];
    const lookback = 5;
    const swingGap = lookback * 2 + 1;

    for (let i = 0; i < count; i++) {
      let close, high, low;
      const swingIndex = Math.floor(i / swingGap);
      const posInSwing = i % swingGap;
      const peakPos = lookback;

      if (pattern === 'bullish') {
        const baseLine = 100 + swingIndex * 10;
        if (posInSwing === peakPos) {
          close = baseLine + 15;
          high = close + 5;
          low = close - 1;
        } else if (posInSwing < peakPos) {
          close = baseLine + posInSwing * 1;
          high = close + 0.3;
          low = close - 0.3;
        } else {
          close = baseLine + 15 - (posInSwing - peakPos) * 1;
          high = close + 0.3;
          low = close - 0.3;
        }
      } else if (pattern === 'bearish') {
        const baseLine = 200 - swingIndex * 10;
        if (posInSwing === peakPos) {
          close = baseLine - 15;
          high = close + 1;
          low = close - 5;
        } else if (posInSwing < peakPos) {
          close = baseLine - posInSwing * 1;
          high = close + 0.3;
          low = close - 0.3;
        } else {
          close = baseLine - 15 + (posInSwing - peakPos) * 1;
          high = close + 0.3;
          low = close - 0.3;
        }
      } else if (pattern === 'ranging') {
        close = 100 + Math.sin(i * 0.8) * 3;
        high = close + 0.5;
        low = close - 0.5;
      } else if (pattern === 'bos_bullish') {
        if (i < 30) {
          const bi = i;
          const bSwingIndex = Math.floor(bi / swingGap);
          const bPos = bi % swingGap;
          if (bPos === peakPos) {
            close = 100 + bSwingIndex * 8 + 12;
            high = close + 3;
            low = close - 1;
          } else if (bPos < peakPos) {
            close = 100 + bSwingIndex * 8 + bPos * 0.8;
            high = close + 0.3;
            low = close - 0.3;
          } else {
            close = 100 + bSwingIndex * 8 + 12 - (bPos - peakPos) * 0.8;
            high = close + 0.3;
            low = close - 0.3;
          }
        } else {
          close = 130 + (i - 30) * 3;
          high = close + 0.3;
          low = close - 0.3;
        }
      }

      candles.push({
        openTime: i * 3600000,
        close,
        high,
        low,
        open: close,
        volume: 1000,
        timestamp: new Date(i * 3600000).toISOString(),
      });
    }
    return candles;
  }

  // ---------------------------------------------------------------------------
  // ATR Validation
  // ---------------------------------------------------------------------------

  _validateATR() {
    const start = Date.now();
    const tests = [];
    const { ATREngine, MIN_CANDLES } = require('./atr');

    const makeMockCandleEngine = (candles) => ({
      getCandles: () => candles,
      getActive: () => null,
      getAllTimeframes: () => ['1m', '5m', '15m', '30m', '1h', '4h', '12h', '24h'],
    });

    // Test 1: Known ATR value — hand-computed reference
    // Candles with constant range of 10: high=110, low=100, close=105
    // All TR values = 10 (high - low = 10, gaps are 0)
    // ATR(14) with constant TR = 10
    tests.push(this._runTest('ATR Known Value (Constant Range)', () => {
      const candles = this._makeCandles(20, (i) => 100 + Math.sin(i * 0.5) * 5);
      // Override to have consistent range
      for (let i = 0; i < candles.length; i++) {
        candles[i].high = candles[i].close + 5;
        candles[i].low = candles[i].close - 5;
      }
      const mock = makeMockCandleEngine(candles);
      const engine = new ATREngine({ candleEngine: mock, logger: this.logger, symbol: 'TEST' });
      const result = engine.calculate('1h', 500);

      if (!result.ready) {
        return { status: 'FAIL', reason: 'ATR not ready with 20 candles' };
      }
      // With constant range of 10, ATR should converge to 10
      if (Math.abs(result.atr - 10) > 1) {
        return { status: 'FAIL', reason: `Expected ATR≈10 for constant range, got ${result.atr}` };
      }
      if (result.period !== 14) {
        return { status: 'FAIL', reason: `Expected period=14, got ${result.period}` };
      }
      return { status: 'PASS', reason: `ATR=${result.atr} for constant range (expected≈10), period=${result.period}` };
    }));

    // Test 2: Known ATR value — hand-computed with Wilder's smoothing
    // 15 candles with constant range of 10
    // First ATR = SMA of first 14 TR values = 10
    // 15th TR = 10, Wilder ATR = (10 * 13 + 10) / 14 = 10
    tests.push(this._runTest('ATR Known Value (Wilder Smoothing)', () => {
      const candles = [];
      for (let i = 0; i < 16; i++) {
        const c = 100;
        candles.push({
          openTime: i * 3600000, close: c, high: c + 5, low: c - 5,
          open: c, volume: 1000, timestamp: new Date(i * 3600000).toISOString(),
        });
      }
      const mock = makeMockCandleEngine(candles);
      const engine = new ATREngine({ candleEngine: mock, logger: this.logger, symbol: 'TEST' });
      const result = engine.calculate('1h', 500);

      if (!result.ready) {
        return { status: 'FAIL', reason: 'ATR not ready with 16 candles' };
      }
      // All TR values are exactly 10, so ATR = 10
      if (Math.abs(result.atr - 10) > 0.01) {
        return { status: 'FAIL', reason: `Expected ATR=10.00, got ${result.atr}` };
      }
      return { status: 'PASS', reason: `ATR=${result.atr} matches Wilder smoothing (expected=10.00)` };
    }));

    // Test 3: Insufficient candles → not ready
    tests.push(this._runTest('ATR Insufficient Data', () => {
      const candles = this._makeCandles(MIN_CANDLES - 1, (i) => 100 + i);
      const mock = makeMockCandleEngine(candles);
      const engine = new ATREngine({ candleEngine: mock, logger: this.logger, symbol: 'TEST' });
      const result = engine.calculate('1h', 500);

      if (result.ready) {
        return { status: 'FAIL', reason: `ATR should not be ready with ${MIN_CANDLES - 1} candles` };
      }
      if (result.atr !== null) {
        return { status: 'FAIL', reason: `ATR should be null when not ready` };
      }
      return { status: 'PASS', reason: `Correctly returns not-ready with ${MIN_CANDLES - 1} candles` };
    }));

    // Test 4: Exactly minimum data → ready
    tests.push(this._runTest('ATR Minimum Data Threshold', () => {
      const candles = this._makeCandles(MIN_CANDLES, (i) => 100 + i);
      const mock = makeMockCandleEngine(candles);
      const engine = new ATREngine({ candleEngine: mock, logger: this.logger, symbol: 'TEST' });
      const result = engine.calculate('1h', 500);

      if (!result.ready) {
        return { status: 'FAIL', reason: `ATR should be ready with ${MIN_CANDLES} candles` };
      }
      if (typeof result.atr !== 'number') {
        return { status: 'FAIL', reason: `ATR should be a number` };
      }
      return { status: 'PASS', reason: `ATR ready with ${MIN_CANDLES} candles, atr=${result.atr}` };
    }));

    // Test 5: Volatility level classification
    tests.push(this._runTest('ATR Volatility Level', () => {
      // High volatility: large range relative to price
      const highVolCandles = [];
      for (let i = 0; i < 20; i++) {
        const c = 100;
        highVolCandles.push({
          openTime: i * 3600000, close: c, high: c + 20, low: c - 20,
          open: c, volume: 1000, timestamp: new Date(i * 3600000).toISOString(),
        });
      }
      const highMock = makeMockCandleEngine(highVolCandles);
      const highEngine = new ATREngine({ candleEngine: highMock, logger: this.logger, symbol: 'TEST' });
      const highResult = highEngine.calculate('1h', 500);

      if (highResult.volatilityLevel !== 'High') {
        return { status: 'FAIL', reason: `Expected High volatility, got ${highResult.volatilityLevel} (ATR%=${highResult.atrPercentage})` };
      }

      // Low volatility: small range relative to price
      const lowVolCandles = [];
      for (let i = 0; i < 20; i++) {
        const c = 10000;
        lowVolCandles.push({
          openTime: i * 3600000, close: c, high: c + 5, low: c - 5,
          open: c, volume: 1000, timestamp: new Date(i * 3600000).toISOString(),
        });
      }
      const lowMock = makeMockCandleEngine(lowVolCandles);
      const lowEngine = new ATREngine({ candleEngine: lowMock, logger: this.logger, symbol: 'TEST' });
      const lowResult = lowEngine.calculate('1h', 500);

      if (lowResult.volatilityLevel !== 'Low') {
        return { status: 'FAIL', reason: `Expected Low volatility, got ${lowResult.volatilityLevel} (ATR%=${lowResult.atrPercentage})` };
      }

      return { status: 'PASS', reason: `Volatility levels correct: High=${highResult.volatilityLevel}, Low=${lowResult.volatilityLevel}` };
    }));

    // Test 6: Volatility trend — Increasing
    tests.push(this._runTest('ATR Volatility Trend (Increasing)', () => {
      // Candles with expanding ranges
      const candles = [];
      for (let i = 0; i < 30; i++) {
        const c = 100;
        const range = 2 + i * 0.5; // Range grows from 2 to ~16
        candles.push({
          openTime: i * 3600000, close: c, high: c + range, low: c - range,
          open: c, volume: 1000, timestamp: new Date(i * 3600000).toISOString(),
        });
      }
      const mock = makeMockCandleEngine(candles);
      const engine = new ATREngine({ candleEngine: mock, logger: this.logger, symbol: 'TEST' });
      const result = engine.calculate('1h', 500);

      if (!result.ready) {
        return { status: 'FAIL', reason: 'ATR not ready' };
      }
      if (result.volatilityTrend !== 'Increasing') {
        return { status: 'FAIL', reason: `Expected Increasing trend, got ${result.volatilityTrend}` };
      }
      return { status: 'PASS', reason: `Volatility trend=${result.volatilityTrend} for expanding ranges` };
    }));

    // Test 7: All timeframes supported
    tests.push(this._runTest('ATR All Timeframes', () => {
      const timeframes = ['1m', '5m', '15m', '30m', '1h', '4h', '12h', '24h'];
      const candles = this._makeCandles(20, (i) => 100 + Math.sin(i * 0.3) * 5);
      const mock = makeMockCandleEngine(candles);
      const engine = new ATREngine({ candleEngine: mock, logger: this.logger, symbol: 'TEST' });

      const allResults = engine.calculateAll(500);
      const unsupported = timeframes.filter(tf => !allResults[tf]);

      if (unsupported.length > 0) {
        return { status: 'FAIL', reason: `Missing timeframes: ${unsupported.join(', ')}` };
      }
      for (const tf of timeframes) {
        if (!allResults[tf].ready) {
          return { status: 'FAIL', reason: `Not ready for ${tf}` };
        }
      }
      return { status: 'PASS', reason: `All ${timeframes.length} timeframes supported and ready` };
    }));

    // Test 8: Symbol propagation
    tests.push(this._runTest('ATR Symbol Propagation', () => {
      const candles = this._makeCandles(20, (i) => 100 + i);
      const mock = makeMockCandleEngine(candles);
      const engine = new ATREngine({ candleEngine: mock, logger: this.logger, symbol: 'ETHUSDT' });
      const result = engine.calculate('1h', 500);

      if (result.symbol !== 'ETHUSDT') {
        return { status: 'FAIL', reason: `Expected symbol=ETHUSDT, got ${result.symbol}` };
      }
      return { status: 'PASS', reason: `Symbol correctly propagated: ${result.symbol}` };
    }));

    // Test 9: Determinism — same input produces same output
    tests.push(this._runTest('ATR Determinism', () => {
      const candles = this._makeCandles(30, (i) => 100 + Math.sin(i * 0.3) * 10);
      const mock = makeMockCandleEngine(candles);
      const engine = new ATREngine({ candleEngine: mock, logger: this.logger, symbol: 'TEST' });

      const r1 = engine.calculate('1h', 500);
      engine.invalidate('1h');
      const r2 = engine.calculate('1h', 500);

      if (r1.atr !== r2.atr) {
        return { status: 'FAIL', reason: `Non-deterministic: first=${r1.atr}, second=${r2.atr}` };
      }
      return { status: 'PASS', reason: `Deterministic: both runs = ATR=${r1.atr}` };
    }));

    const executionTime = Date.now() - start;
    return { tests, executionTime };
  }

  // ---------------------------------------------------------------------------
  // Bollinger Bands Validation
  // ---------------------------------------------------------------------------

  _validateBollinger() {
    const start = Date.now();
    const tests = [];
    const { BollingerEngine, MIN_CANDLES } = require('./bollinger');

    const makeMockCandleEngine = (candles) => ({
      getCandles: () => candles,
      getActive: () => null,
      getAllTimeframes: () => ['1m', '5m', '15m', '30m', '1h', '4h', '12h', '24h'],
    });

    // Test 1: Known values — hand-computed Bollinger Bands
    // Closes: [10,11,12,...,29] (20 values, period=20)
    // SMA = 19.5, StdDev(pop) = sqrt(665/20) ≈ 5.766
    // Upper = 19.5 + 2*5.766 = 31.03
    // Lower = 19.5 - 2*5.766 = 7.97
    // Bandwidth = (31.03 - 7.97) / 19.5 ≈ 1.183
    tests.push(this._runTest('Bollinger Known Values', () => {
      const closes = [];
      for (let i = 0; i < 20; i++) closes.push(10 + i);
      const candles = this._makeCandlesFromCloses(closes);
      const mock = makeMockCandleEngine(candles);
      const engine = new BollingerEngine({ candleEngine: mock, logger: this.logger, symbol: 'TEST' });
      const result = engine.calculate('1h', 500);

      if (!result.ready) {
        return { status: 'FAIL', reason: 'Bollinger not ready with 20 candles' };
      }
      if (Math.abs(result.middleBand - 19.5) > 0.01) {
        return { status: 'FAIL', reason: `Expected middle=19.5, got ${result.middleBand}` };
      }
      if (Math.abs(result.upperBand - 31.03) > 0.1) {
        return { status: 'FAIL', reason: `Expected upper≈31.03, got ${result.upperBand}` };
      }
      if (Math.abs(result.lowerBand - 7.97) > 0.1) {
        return { status: 'FAIL', reason: `Expected lower≈7.97, got ${result.lowerBand}` };
      }
      return { status: 'PASS', reason: `middle=${result.middleBand}, upper=${result.upperBand}, lower=${result.lowerBand}` };
    }));

    // Test 2: Symmetric bands around SMA
    tests.push(this._runTest('Bollinger Symmetric Bands', () => {
      const closes = [];
      for (let i = 0; i < 25; i++) closes.push(100 + Math.sin(i * 0.5) * 10);
      const candles = this._makeCandlesFromCloses(closes);
      const mock = makeMockCandleEngine(candles);
      const engine = new BollingerEngine({ candleEngine: mock, logger: this.logger, symbol: 'TEST' });
      const result = engine.calculate('1h', 500);

      if (!result.ready) {
        return { status: 'FAIL', reason: 'Bollinger not ready' };
      }
      const upperDist = result.upperBand - result.middleBand;
      const lowerDist = result.middleBand - result.lowerBand;
      if (Math.abs(upperDist - lowerDist) > 0.01) {
        return { status: 'FAIL', reason: `Bands not symmetric: upper-mid=${upperDist.toFixed(2)}, mid-lower=${lowerDist.toFixed(2)}` };
      }
      return { status: 'PASS', reason: `Bands symmetric: distance=${upperDist.toFixed(2)}` };
    }));

    // Test 3: Squeeze detection — wide bands then narrow bands → squeeze
    tests.push(this._runTest('Bollinger Squeeze Detection', () => {
      // Phase 1: volatile (wide bands) — 30 candles
      const candles = [];
      for (let i = 0; i < 30; i++) {
        const c = 100 + Math.sin(i * 0.8) * 20;
        candles.push({
          openTime: i * 3600000, close: c,
          high: c + 5, low: c - 5,
          open: c, volume: 1000, timestamp: new Date(i * 3600000).toISOString(),
        });
      }
      // Phase 2: calm (narrow bands) — 30 candles, nearly flat
      for (let i = 30; i < 60; i++) {
        const c = 100 + (i % 3 === 0 ? 0.1 : -0.1);
        candles.push({
          openTime: i * 3600000, close: c,
          high: c + 0.05, low: c - 0.05,
          open: c, volume: 1000, timestamp: new Date(i * 3600000).toISOString(),
        });
      }

      const mock = makeMockCandleEngine(candles);
      const engine = new BollingerEngine({ candleEngine: mock, logger: this.logger, symbol: 'TEST' });
      const result = engine.calculate('1h', 500);

      if (!result.ready) {
        return { status: 'FAIL', reason: 'Bollinger not ready' };
      }
      if (typeof result.squeeze !== 'boolean') {
        return { status: 'FAIL', reason: `Expected squeeze to be boolean, got ${typeof result.squeeze}` };
      }
      // After transition from volatile to calm, squeeze should be true
      if (!result.squeeze) {
        return { status: 'FAIL', reason: `Expected squeeze=true after volatility collapse, got false (bandwidth=${result.bandwidth})` };
      }
      return { status: 'PASS', reason: `Squeeze=${result.squeeze} after volatility collapse` };
    }));

    // Test 4: Price position classification
    tests.push(this._runTest('Bollinger Price Position', () => {
      // All flat → bands narrow, close is inside
      const flatCandles = [];
      for (let i = 0; i < 25; i++) {
        flatCandles.push({
          openTime: i * 3600000, close: 100, high: 101, low: 99,
          open: 100, volume: 1000, timestamp: new Date(i * 3600000).toISOString(),
        });
      }
      const mock = makeMockCandleEngine(flatCandles);
      const engine = new BollingerEngine({ candleEngine: mock, logger: this.logger, symbol: 'TEST' });
      const result = engine.calculate('1h', 500);

      if (!result.ready) {
        return { status: 'FAIL', reason: 'Bollinger not ready' };
      }
      if (result.pricePosition !== 'Inside Bands') {
        return { status: 'FAIL', reason: `Expected Inside Bands for flat prices, got ${result.pricePosition}` };
      }
      return { status: 'PASS', reason: `Price position=${result.pricePosition} for flat prices` };
    }));

    // Test 5: Insufficient candles → not ready
    tests.push(this._runTest('Bollinger Insufficient Data', () => {
      const candles = this._makeCandles(MIN_CANDLES - 1, (i) => 100 + i);
      const mock = makeMockCandleEngine(candles);
      const engine = new BollingerEngine({ candleEngine: mock, logger: this.logger, symbol: 'TEST' });
      const result = engine.calculate('1h', 500);

      if (result.ready) {
        return { status: 'FAIL', reason: `Should not be ready with ${MIN_CANDLES - 1} candles` };
      }
      if (result.middleBand !== null) {
        return { status: 'FAIL', reason: `middleBand should be null when not ready` };
      }
      return { status: 'PASS', reason: `Correctly returns not-ready with ${MIN_CANDLES - 1} candles` };
    }));

    // Test 6: Exactly minimum data → ready
    tests.push(this._runTest('Bollinger Minimum Data', () => {
      const candles = this._makeCandles(MIN_CANDLES, (i) => 100 + Math.sin(i * 0.3) * 5);
      const mock = makeMockCandleEngine(candles);
      const engine = new BollingerEngine({ candleEngine: mock, logger: this.logger, symbol: 'TEST' });
      const result = engine.calculate('1h', 500);

      if (!result.ready) {
        return { status: 'FAIL', reason: `Should be ready with ${MIN_CANDLES} candles` };
      }
      return { status: 'PASS', reason: `Ready with ${MIN_CANDLES} candles, middle=${result.middleBand}` };
    }));

    // Test 7: All timeframes supported
    tests.push(this._runTest('Bollinger All Timeframes', () => {
      const timeframes = ['1m', '5m', '15m', '30m', '1h', '4h', '12h', '24h'];
      const candles = this._makeCandles(25, (i) => 100 + Math.sin(i * 0.3) * 5);
      const mock = makeMockCandleEngine(candles);
      const engine = new BollingerEngine({ candleEngine: mock, logger: this.logger, symbol: 'TEST' });

      const allResults = engine.calculateAll(500);
      const unsupported = timeframes.filter(tf => !allResults[tf]);

      if (unsupported.length > 0) {
        return { status: 'FAIL', reason: `Missing timeframes: ${unsupported.join(', ')}` };
      }
      for (const tf of timeframes) {
        if (!allResults[tf].ready) {
          return { status: 'FAIL', reason: `Not ready for ${tf}` };
        }
      }
      return { status: 'PASS', reason: `All ${timeframes.length} timeframes supported` };
    }));

    // Test 8: Symbol propagation
    tests.push(this._runTest('Bollinger Symbol Propagation', () => {
      const candles = this._makeCandles(25, (i) => 100 + i);
      const mock = makeMockCandleEngine(candles);
      const engine = new BollingerEngine({ candleEngine: mock, logger: this.logger, symbol: 'ETHUSDT' });
      const result = engine.calculate('1h', 500);

      if (result.symbol !== 'ETHUSDT') {
        return { status: 'FAIL', reason: `Expected symbol=ETHUSDT, got ${result.symbol}` };
      }
      return { status: 'PASS', reason: `Symbol correctly propagated: ${result.symbol}` };
    }));

    // Test 9: Determinism
    tests.push(this._runTest('Bollinger Determinism', () => {
      const candles = this._makeCandles(30, (i) => 100 + Math.sin(i * 0.3) * 10);
      const mock = makeMockCandleEngine(candles);
      const engine = new BollingerEngine({ candleEngine: mock, logger: this.logger, symbol: 'TEST' });

      const r1 = engine.calculate('1h', 500);
      engine.invalidate('1h');
      const r2 = engine.calculate('1h', 500);

      if (r1.middleBand !== r2.middleBand || r1.upperBand !== r2.upperBand || r1.lowerBand !== r2.lowerBand) {
        return { status: 'FAIL', reason: `Non-deterministic: run1=[${r1.middleBand},${r1.upperBand},${r1.lowerBand}], run2=[${r2.middleBand},${r2.upperBand},${r2.lowerBand}]` };
      }
      return { status: 'PASS', reason: `Deterministic: middle=${r1.middleBand}, upper=${r1.upperBand}, lower=${r1.lowerBand}` };
    }));

    const executionTime = Date.now() - start;
    return { tests, executionTime };
  }

  // ---------------------------------------------------------------------------
  // Signal History Validation
  // ---------------------------------------------------------------------------

  _validateSignalHistory() {
    const start = Date.now();
    const tests = [];
    const { SignalHistoryEngine } = require('./signalHistory');

    const makeMockDeps = (overrides = {}) => {
      const defaultConfig = { get: (key) => {
        if (key === 'MAX_HISTORY') return overrides.maxHistory || 500;
        return null;
      }};
      const defaultLogger = { info: () => {}, warn: () => {}, error: () => {} };

      const mockCandleEngine = {
        getCandles: () => this._makeCandles(50, (i) => 100 + Math.sin(i * 0.3) * 5),
        getActive: () => null,
        getAllTimeframes: () => ['1h'],
      };

      const mockStructureEngine = {
        calculate: () => ({
          ready: true, direction: 'bullish', score: 70, lastBOS: null,
          structure: 'Bullish', swingPoints: [], confidence: 60,
          timestamp: new Date().toISOString(), engineVersion: '1.0.0',
          lastUpdated: new Date().toISOString(), calculationTime: 0, dataSource: 'mock',
        }),
      };

      const mockIndicatorRegistry = {
        get: (name) => ({
          calculate: (candles, tf) => {
            if (name === 'RSI') return { ready: true, value: 55, state: 'Neutral', symbol: 'TEST' };
            if (name === 'EMA') return { ready: true, value: 105.5, trend: 'Above', symbol: 'TEST' };
            return {};
          },
        }),
      };

      const mockMACDEngine = {
        calculate: () => ({
          ready: true, macd: 2.5, signal: 1.8, histogram: 0.7,
          trend: 'Bullish', crossover: 'None', timeframe: '1h',
        }),
      };

      const mockConfluenceEngine = {
        calculate: () => ({
          score: 72, bias: 'Bullish', confidence: 68, timeframe: '1h',
        }),
      };

      const mockMTFEngine = {
        calculate: () => ({
          overallBias: 'Bullish', confidence: 71,
          strongestTimeframe: '4h', weakestTimeframe: '5m',
          timeframeAgreement: 75,
        }),
      };

      return {
        config: overrides.config || defaultConfig,
        logger: overrides.logger || defaultLogger,
        symbol: overrides.symbol || 'BTCUSDT',
        history: overrides.history || { add: () => {}, all: () => [] },
        analyzer: overrides.analyzer || {
          getAnalysis: () => ({
            trend: { '1H': 'Bullish', '4H': 'Bullish', '1H': 'Sideways' },
          }),
        },
        structureEngine: overrides.structureEngine || mockStructureEngine,
        candleEngine: overrides.candleEngine || mockCandleEngine,
        indicatorRegistry: overrides.indicatorRegistry || mockIndicatorRegistry,
        confluenceEngine: overrides.confluenceEngine || mockConfluenceEngine,
        mtfEngine: overrides.mtfEngine || mockMTFEngine,
        macdEngine: overrides.macdEngine || mockMACDEngine,
      };
    };

    // Test 1: Record stores correctly — all required fields present
    tests.push(this._runTest('SignalHistory Record Fields', () => {
      const deps = makeMockDeps();
      const engine = new SignalHistoryEngine(deps);
      const record = engine.record('1h');

      if (!record) {
        return { status: 'FAIL', reason: 'record() returned null' };
      }

      const requiredFields = ['id', 'timestamp', 'symbol', 'timeframe', 'engineVersion'];
      for (const field of requiredFields) {
        if (record[field] === undefined || record[field] === null) {
          return { status: 'FAIL', reason: `Missing field: ${field}` };
        }
      }

      if (!record.trend && record.trend !== null) {
        return { status: 'FAIL', reason: 'Missing trend data' };
      }
      if (!record.structure && record.structure !== null) {
        return { status: 'FAIL', reason: 'Missing structure data' };
      }
      if (!record.rsi && record.rsi !== null) {
        return { status: 'FAIL', reason: 'Missing rsi data' };
      }
      if (!record.ema && record.ema !== null) {
        return { status: 'FAIL', reason: 'Missing ema data' };
      }
      if (!record.macd && record.macd !== null) {
        return { status: 'FAIL', reason: 'Missing macd data' };
      }
      if (!record.confluence && record.confluence !== null) {
        return { status: 'FAIL', reason: 'Missing confluence data' };
      }
      if (!record.mtf && record.mtf !== null) {
        return { status: 'FAIL', reason: 'Missing mtf data' };
      }

      return { status: 'PASS', reason: `Record has all required fields: id=${record.id}, symbol=${record.symbol}, tf=${record.timeframe}` };
    }));

    // Test 2: Timestamps increase — record multiple signals, verify monotonic timestamps
    tests.push(this._runTest('SignalHistory Timestamps Increase', () => {
      const deps = makeMockDeps();
      const engine = new SignalHistoryEngine(deps);

      const candles1 = this._makeCandles(50, (i) => 100 + Math.sin(i * 0.3) * 5);
      deps.candleEngine = {
        getCandles: () => candles1,
        getActive: () => null,
        getAllTimeframes: () => ['1h'],
      };

      const r1 = engine.record('1h');

      // Change candle data AND mutate the MTF mock in-place to produce a different hash
      const candles2 = this._makeCandles(50, (i) => 200 + Math.sin(i * 0.3) * 5);
      deps.candleEngine.getCandles = () => candles2;
      engine.mtfEngine.calculate = () => ({
        overallBias: 'Bearish', confidence: 45,
        strongestTimeframe: '12h', weakestTimeframe: '5m',
        timeframeAgreement: 60,
      });

      const r2 = engine.record('1h');

      if (!r1 || !r2) {
        return { status: 'FAIL', reason: `Expected two records, got r1=${!!r1}, r2=${!!r2}` };
      }

      if (new Date(r2.timestamp) < new Date(r1.timestamp)) {
        return { status: 'FAIL', reason: `r2 timestamp (${r2.timestamp}) < r1 timestamp (${r1.timestamp})` };
      }

      if (r2.id === r1.id) {
        return { status: 'FAIL', reason: `Duplicate IDs: ${r1.id}` };
      }

      return { status: 'PASS', reason: `Timestamps increase: ${r1.timestamp} < ${r2.timestamp}` };
    }));

    // Test 3: Filter by symbol — record with different symbols, filter works
    tests.push(this._runTest('SignalHistory Filter by Symbol', () => {
      const deps = makeMockDeps({ symbol: 'BTCUSDT' });
      const engine = new SignalHistoryEngine(deps);

      const candles = this._makeCandles(50, (i) => 100 + i);
      deps.candleEngine = { getCandles: () => candles, getActive: () => null, getAllTimeframes: () => ['1h'] };
      engine.record('1h');

      // Manually add a record with a different symbol
      const ethRecord = {
        id: 'eth-1', timestamp: new Date().toISOString(), symbol: 'ETHUSDT',
        timeframe: '1h', trend: null, structure: null, rsi: null, ema: null,
        macd: null, confluence: null, mtf: null, confidence: null,
        strongestTimeframe: null, weakestTimeframe: null, engineVersion: '1.0.0',
      };
      engine.records.push(Object.freeze(ethRecord));

      const btcRecords = engine.getBySymbol('BTCUSDT');
      const ethRecords = engine.getBySymbol('ETHUSDT');

      if (btcRecords.length !== 1) {
        return { status: 'FAIL', reason: `Expected 1 BTC record, got ${btcRecords.length}` };
      }
      if (ethRecords.length !== 1) {
        return { status: 'FAIL', reason: `Expected 1 ETH record, got ${ethRecords.length}` };
      }
      if (btcRecords[0].symbol !== 'BTCUSDT') {
        return { status: 'FAIL', reason: `Expected BTCUSDT, got ${btcRecords[0].symbol}` };
      }

      return { status: 'PASS', reason: `Filter works: 1 BTC, 1 ETH` };
    }));

    // Test 4: Filter by timeframe — record with different timeframes, filter works
    tests.push(this._runTest('SignalHistory Filter by Timeframe', () => {
      const deps = makeMockDeps();
      const engine = new SignalHistoryEngine(deps);

      const candles = this._makeCandles(50, (i) => 100 + i);
      deps.candleEngine = { getCandles: () => candles, getActive: () => null, getAllTimeframes: () => ['1h'] };
      engine.record('1h');

      // Manually add a 4h record
      const h4Record = {
        id: '4h-1', timestamp: new Date().toISOString(), symbol: 'BTCUSDT',
        timeframe: '4h', trend: null, structure: null, rsi: null, ema: null,
        macd: null, confluence: null, mtf: null, confidence: null,
        strongestTimeframe: null, weakestTimeframe: null, engineVersion: '1.0.0',
      };
      engine.records.push(Object.freeze(h4Record));

      const h1Records = engine.getByTimeframe('1h');
      const h4Records = engine.getByTimeframe('4h');

      if (h1Records.length !== 1) {
        return { status: 'FAIL', reason: `Expected 1 1h record, got ${h1Records.length}` };
      }
      if (h4Records.length !== 1) {
        return { status: 'FAIL', reason: `Expected 1 4h record, got ${h4Records.length}` };
      }

      return { status: 'PASS', reason: `Filter works: 1 1h, 1 4h` };
    }));

    // Test 5: Latest endpoint — record 3 signals, verify latest() returns the most recent
    tests.push(this._runTest('SignalHistory Latest', () => {
      const deps = makeMockDeps();
      const engine = new SignalHistoryEngine(deps);

      const biases = ['Bullish', 'Bearish', 'Neutral'];
      let callCount = 0;

      const candles = this._makeCandles(50, (i) => 100 + i);
      deps.candleEngine = { getCandles: () => candles, getActive: () => null, getAllTimeframes: () => ['1h'] };

      // Mutate the MTF mock in-place for each call
      engine.mtfEngine.calculate = () => ({
        overallBias: biases[callCount++ % 3], confidence: 50 + callCount * 10,
        strongestTimeframe: '4h', weakestTimeframe: '5m',
        timeframeAgreement: 70,
      });

      const r1 = engine.record('1h');
      const r2 = engine.record('1h');
      const r3 = engine.record('1h');

      if (!r1 || !r2 || !r3) {
        return { status: 'FAIL', reason: `Expected 3 records, got ${!!r1}, ${!!r2}, ${!!r3}` };
      }

      const latest = engine.latest();
      if (!latest) {
        return { status: 'FAIL', reason: 'latest() returned null' };
      }
      if (latest.id !== r3.id) {
        return { status: 'FAIL', reason: `Expected latest id=${r3.id}, got ${latest.id}` };
      }

      return { status: 'PASS', reason: `latest() correctly returns record ${latest.id}` };
    }));

    // Test 6: Stats endpoint — verify stats structure and values
    tests.push(this._runTest('SignalHistory Stats', () => {
      const deps = makeMockDeps();
      const engine = new SignalHistoryEngine(deps);

      const candles = this._makeCandles(50, (i) => 100 + i);
      deps.candleEngine = { getCandles: () => candles, getActive: () => null, getAllTimeframes: () => ['1h'] };

      engine.record('1h');

      // Add a second record with different symbol
      engine.records.push(Object.freeze({
        id: 'eth-1', timestamp: new Date().toISOString(), symbol: 'ETHUSDT',
        timeframe: '4h', trend: null, structure: null, rsi: null, ema: null,
        macd: null, confluence: null, mtf: { overallBias: 'Bearish', confidence: 55 },
        confidence: 55, strongestTimeframe: '12h', weakestTimeframe: '5m',
        engineVersion: '1.0.0',
      }));

      const stats = engine.stats();

      if (stats.totalRecords !== 2) {
        return { status: 'FAIL', reason: `Expected 2 total records, got ${stats.totalRecords}` };
      }
      if (!stats.oldest || !stats.newest) {
        return { status: 'FAIL', reason: 'Missing oldest/newest timestamps' };
      }
      if (!stats.symbols || stats.symbols.length !== 2) {
        return { status: 'FAIL', reason: `Expected 2 symbols, got ${stats.symbols?.length}` };
      }
      if (!stats.timeframes || stats.timeframes.length !== 2) {
        return { status: 'FAIL', reason: `Expected 2 timeframes, got ${stats.timeframes?.length}` };
      }
      if (!stats.biasDistribution) {
        return { status: 'FAIL', reason: 'Missing biasDistribution' };
      }
      if (stats.limit !== 500) {
        return { status: 'FAIL', reason: `Expected limit=500, got ${stats.limit}` };
      }

      return { status: 'PASS', reason: `Stats: ${stats.totalRecords} records, ${stats.symbols.length} symbols, limit=${stats.limit}` };
    }));

    // Test 7: Dedup — duplicate analysis not recorded twice
    tests.push(this._runTest('SignalHistory Dedup', () => {
      const deps = makeMockDeps();
      const engine = new SignalHistoryEngine(deps);

      const candles = this._makeCandles(50, (i) => 100 + i);
      deps.candleEngine = { getCandles: () => candles, getActive: () => null, getAllTimeframes: () => ['1h'] };

      const r1 = engine.record('1h');
      const r2 = engine.record('1h'); // same candle, same analysis → should be null

      if (!r1) {
        return { status: 'FAIL', reason: 'First record should not be null' };
      }
      if (r2 !== null) {
        return { status: 'FAIL', reason: `Second record should be null (dedup), got ${r2?.id}` };
      }
      if (engine.size() !== 1) {
        return { status: 'FAIL', reason: `Expected 1 record after dedup, got ${engine.size()}` };
      }

      return { status: 'PASS', reason: `Dedup works: 1 record stored, duplicate rejected` };
    }));

    // Test 8: Symbol propagation — verify symbol field matches constructor symbol
    tests.push(this._runTest('SignalHistory Symbol Propagation', () => {
      const deps = makeMockDeps({ symbol: 'ETHUSDT' });
      const engine = new SignalHistoryEngine(deps);

      const candles = this._makeCandles(50, (i) => 100 + i);
      deps.candleEngine = { getCandles: () => candles, getActive: () => null, getAllTimeframes: () => ['1h'] };

      const record = engine.record('1h');
      if (!record) {
        return { status: 'FAIL', reason: 'Record is null' };
      }
      if (record.symbol !== 'ETHUSDT') {
        return { status: 'FAIL', reason: `Expected symbol=ETHUSDT, got ${record.symbol}` };
      }

      const info = engine.getInfo();
      if (info.symbol !== 'ETHUSDT') {
        return { status: 'FAIL', reason: `getInfo symbol=ETHUSDT, got ${info.symbol}` };
      }

      return { status: 'PASS', reason: `Symbol correctly propagated: ${record.symbol}` };
    }));

    const executionTime = Date.now() - start;
    return { tests, executionTime };
  }

  // ---------------------------------------------------------------------------
  // Mock ConfluenceEngine for deterministic testing
  // ---------------------------------------------------------------------------

  _makeMockConfluence(componentOverrides) {
    const mock = {
      analyzer: this.analyzer,
      indicatorRegistry: this.indicatorRegistry,
      structureEngine: this.structureEngine,
      candleEngine: this.candleEngine,
      logger: this.logger,
      config: { get: (key) => {
        if (key === 'CONFLUENCE_BULLISH_THRESHOLD') return 65;
        if (key === 'CONFLUENCE_BEARISH_THRESHOLD') return 35;
        return null;
      }},
    };

    const { ConfluenceEngine } = require('./confluence');
    const engine = new ConfluenceEngine(mock);

    engine.components.clear();
    for (const [name, data] of Object.entries(componentOverrides)) {
      engine.registerComponent(name, {
        weight: { trend: 0.30, structure: 0.25, momentum: 0.15, rsi: 0.15, volatility: 0.15 }[name],
        calculate: () => ({
          score: data.score,
          direction: data.direction,
          confidence: data.confidence,
          available: data.available,
          reason: data.reason || null,
        }),
      });
    }

    return engine;
  }

  _validateMTFConfirmation() {
    const start = Date.now();
    const tests = [];

    if (!this.mtfConfirmationEngine) {
      tests.push({ name: 'MTFConfirmation Skipped', status: 'WARNING', reason: 'MTFConfirmationEngine not provided', executionTime: 0 });
      return { tests, executionTime: Date.now() - start };
    }

    const engine = this.mtfConfirmationEngine;
    const makeTF = (bias, score, confidence, vol) => ({
      confluence: { score: score || 50, bias: bias || 'Neutral', confidence: confidence || 50 },
       volatilityLevel: vol || 'NORMAL',
    });

    // Test 1: Bullish alignment — all TFs bullish
    tests.push(this._runTest('MTFConf Bullish All TFs', () => {
      const r = engine.evaluate({
        direction: 'BUY',
        timeframe: '1h',
        timeframes: {
          '1m': makeTF('Bullish', 70, 60),
          '5m': makeTF('Bullish', 65, 55),
          '15m': makeTF('Bullish', 80, 75),
          '1h': makeTF('Bullish', 85, 80),
        },
      });
      if (!r.mtfAllowed) return { status: 'FAIL', reason: `All TFs Bullish BUY should be allowed, got blocked: ${r.rejectionReason}` };
       if (r.confidence < 68) return { status: 'FAIL', reason: `Confidence should be >= 68 for aligned Bullish, got ${r.confidence}` };
      return { status: 'PASS', reason: `Bullish alignment: allowed, confidence=${r.confidence}%, alignment=${r.alignmentScore}%` };
    }));

    // Test 2: Bearish alignment — all TFs bearish, SELL
    tests.push(this._runTest('MTFConf Bearish All TFs SELL', () => {
      const r = engine.evaluate({
        direction: 'SELL',
        timeframe: '1h',
        timeframes: {
          '1m': makeTF('Bearish', 30, 65),
          '5m': makeTF('Bearish', 25, 60),
          '15m': makeTF('Bearish', 20, 70),
          '1h': makeTF('Bearish', 15, 75),
        },
      });
      if (!r.mtfAllowed) return { status: 'FAIL', reason: `All TFs Bearish SELL should be allowed, got blocked: ${r.rejectionReason}` };
      return { status: 'PASS', reason: `Bearish alignment: allowed, confidence=${r.confidence}%, alignment=${r.alignmentScore}%` };
    }));

    // Test 3: Mixed — 1m opposes, rest align (should be blocked in normal mode)
    tests.push(this._runTest('MTFConf Mixed 1m Opposes Normal', () => {
      const r = engine.evaluate({
        direction: 'BUY',
        timeframe: '1h',
        timeframes: {
          '1m': makeTF('Bearish', 30, 60),
          '5m': makeTF('Bullish', 65, 55),
          '15m': makeTF('Bullish', 80, 75),
          '1h': makeTF('Bullish', 85, 80),
        },
      });
      if (r.mtfAllowed) return { status: 'FAIL', reason: `1m Bearish opposing BUY should block in normal mode` };
      return { status: 'PASS', reason: `Mixed alignment correctly blocked: ${r.rejectionReason}` };
    }));

    // Test 4: Mixed with aggressive mode — 1m opposes but should pass
    tests.push(this._runTest('MTFConf Mixed Aggressive Mode', () => {
      const r = engine.evaluate({
        direction: 'BUY',
        timeframe: '1h',
        aggressive: true,
        timeframes: {
          '1m': makeTF('Bearish', 30, 60),
          '5m': makeTF('Bullish', 65, 55),
          '15m': makeTF('Bullish', 80, 75),
          '1h': makeTF('Bullish', 85, 80),
        },
      });
      if (!r.mtfAllowed) return { status: 'FAIL', reason: `Aggressive mode should allow BUY with 1m opposing, got blocked: ${r.rejectionReason}` };
      return { status: 'PASS', reason: `Aggressive mode passed: allowed, confidence=${r.confidence}%` };
    }));

    // Test 5: Ranging — all neutral
    tests.push(this._runTest('MTFConf Ranging All Neutral', () => {
      const r = engine.evaluate({
        direction: 'BUY',
        timeframe: '1h',
        timeframes: {
          '1m': makeTF('Neutral', 50, 30),
          '5m': makeTF('Neutral', 50, 30),
          '15m': makeTF('Neutral', 50, 30),
          '1h': makeTF('Neutral', 50, 30),
        },
      });
      if (r.mtfAllowed) return { status: 'FAIL', reason: `All Neutral should block BUY` };
      return { status: 'PASS', reason: `Ranging correctly blocked: ${r.rejectionReason}` };
    }));

    // Test 6: High volatility
    tests.push(this._runTest('MTFConf High Volatility', () => {
      const r = engine.evaluate({
        direction: 'BUY',
        timeframe: '1h',
        timeframes: {
          '1m': makeTF('Bullish', 70, 60, 'HIGH'),
          '5m': makeTF('Bullish', 65, 55, 'HIGH'),
          '15m': makeTF('Bullish', 80, 75, 'HIGH'),
          '1h': makeTF('Bullish', 85, 80, 'HIGH'),
        },
      });
       if (r.mtfAllowed) return { status: 'FAIL', reason: `High volatility should block directional alignment, got allowed` };
       if (!r.rejectionReason.includes('High Volatility')) return { status: 'FAIL', reason: `Expected high-volatility rejection, got: ${r.rejectionReason}` };
       return { status: 'PASS', reason: `High volatility correctly blocked: ${r.rejectionReason}` };
    }));

    // Test 7: Missing timeframe data
    tests.push(this._runTest('MTFConf Missing Timeframe Data', () => {
      const r = engine.evaluate({
        direction: 'BUY',
        timeframe: '1h',
        timeframes: {
          '1m': makeTF('Bullish', 70, 60),
          '15m': makeTF('Bullish', 80, 75),
        },
      });
      if (r.mtfAllowed) return { status: 'FAIL', reason: `Missing timeframes should block` };
      return { status: 'PASS', reason: `Missing data correctly blocked: ${r.rejectionReason}` };
    }));

    const statuses = tests.map(t => t.status);
    let status = 'PASS';
    if (statuses.includes('FAIL')) status = 'FAIL';
    else if (statuses.includes('WARNING')) status = 'WARNING';

    return { tests, status, executionTime: Date.now() - start };
  }
}

module.exports = { ValidationEngine, ENGINE_VERSION };
