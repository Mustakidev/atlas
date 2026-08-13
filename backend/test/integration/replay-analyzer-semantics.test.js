const test = require('node:test');
const assert = require('node:assert/strict');

const { createReplayDependencies } = require('../../src/engine/replayDependencies');
const { createReplayPipelineRunner } = require('../../src/engine/replayPipelineRunner');
const { normalizeReplayAnalyzerInput } = require('../../src/engine/replayAnalyzerInput');
const { createReplayAnalyzerHistory } = require('../../src/engine/replayAnalyzerHistory');
const { createReplayAnalyzerOrchestrator } = require('../../src/engine/replayAnalyzerOrchestrator');
const { MarketAnalyzer } = require('../../src/engine/analyzer');

const BASE_TIME = Date.parse('2024-01-01T00:00:00.000Z');
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const SYMBOL = 'BTCUSDT';
const logger = { info() {}, warn() {}, error() {}, system() {} };
const config = {
  get(key) {
    if (key === 'CONFLUENCE_BULLISH_THRESHOLD') return 65;
    if (key === 'CONFLUENCE_BEARISH_THRESHOLD') return 35;
    if (key === 'MAX_HISTORY') return 500;
    return undefined;
  },
};

function normalizedCandleInput(count = 16) {
  const candles = Array.from({ length: count }, (_, index) => {
    const openTime = BASE_TIME + index * HOUR;
    const close = 100 + index;
    return Object.freeze({
      openTime,
      timestamp: new Date(openTime).toISOString(),
      open: close,
      high: close + 1,
      low: close - 1,
      close,
      volume: 7,
    });
  });

  return Object.freeze({
    schemaVersion: 1,
    timeframe: '1h',
    candles: Object.freeze(candles),
  });
}

function rawSnapshot(timestampMs, price, volume, change24h) {
  return {
    timestamp: new Date(timestampMs).toISOString(),
    price,
    volume,
    change24h,
  };
}

function normalizedAnalyzerInput(snapshots) {
  return normalizeReplayAnalyzerInput({
    schemaVersion: 1,
    symbol: SYMBOL,
    snapshots,
  });
}

function causalPath(prices, { volume = 1000, change24h = 0, intervalMs = MINUTE } = {}) {
  return normalizedAnalyzerInput(prices.map((price, index) => rawSnapshot(
    BASE_TIME + (index + 1) * intervalMs,
    price,
    volume + index,
    change24h + index / 100,
  )));
}

function makeClock() {
  let monotonic = 0;
  return {
    nowMs: () => BASE_TIME,
    monotonicMs: () => monotonic++,
  };
}

function makeBundle(normalizedInput, analyzerInput) {
  return createReplayDependencies({
    logger,
    symbol: SYMBOL,
    config,
    normalizedInput,
    analyzerInput,
    clock: makeClock(),
  });
}

function runGraph(normalizedInput, analyzerInput) {
  const bundle = makeBundle(normalizedInput, analyzerInput);
  const runner = createReplayPipelineRunner({ dependencies: bundle, normalizedInput });
  let result = null;
  while (runner.hasNext()) result = runner.runNextCycle();
  return { bundle, result };
}

function semanticAnalysis(analysis) {
  const { analyzedAt, ...semantic } = analysis;
  return semantic;
}

function analyzerAtBoundary(input, boundaryTimeMs) {
  const history = createReplayAnalyzerHistory(input, { symbol: SYMBOL, maxHistory: 500 });
  const analyzer = new MarketAnalyzer(logger, SYMBOL);
  const orchestrator = createReplayAnalyzerOrchestrator({
    source: input,
    history,
    analyzer,
    symbol: SYMBOL,
  });
  const metadata = orchestrator.runForBoundary(boundaryTimeMs);
  return { analysis: analyzer.getAnalysis(), history, metadata };
}

test('identical candle OHLC with different causal raw paths produces different Analyzer and pipeline semantics', () => {
  const candles = normalizedCandleInput();
  const pathA = causalPath(Array.from({ length: 20 }, (_, index) => 100 + index), {
    volume: 1000,
    change24h: 2,
  });
  const pathB = causalPath(Array.from({ length: 20 }, (_, index) => 200 + (index % 2 === 0 ? 1 : -1)), {
    volume: 2000,
    change24h: -2,
  });
  const boundaryTimeMs = candles.candles[candles.candles.length - 1].openTime + HOUR;

  assert.deepEqual(candles, normalizedCandleInput());
  assert.notDeepEqual(pathA, pathB);
  assert.equal(pathA.snapshots.every(snapshot => Date.parse(snapshot.timestamp) <= boundaryTimeMs), true);
  assert.equal(pathB.snapshots.every(snapshot => Date.parse(snapshot.timestamp) <= boundaryTimeMs), true);

  const resultA = runGraph(candles, pathA).result;
  const resultB = runGraph(candles, pathB).result;
  const trendA = resultA.decision.engines.trend;
  const trendB = resultB.decision.engines.trend;

  assert.notEqual(trendA.trend['24H'], trendB.trend['24H']);
  assert.notEqual(trendA.momentum['24H'], trendB.momentum['24H']);
  assert.notEqual(trendA.confidence['24H'], trendB.confidence['24H']);
  assert.notEqual(trendA.price, trendB.price);
  assert.notEqual(trendA.volume24h, trendB.volume24h);
  assert.notEqual(trendA.change24h, trendB.change24h);
  assert.notEqual(trendA.analyzedAt, undefined);
  assert.notEqual(trendB.analyzedAt, undefined);

  const pipelineA = {
    trend: {
      direction: resultA.decision.engines.trend.trend['24H'],
      momentum: resultA.decision.engines.trend.momentum['24H'],
      volatility: resultA.decision.engines.trend.volatility['24H'],
      confidence: resultA.decision.engines.trend.confidence['24H'],
    },
    confluence: resultA.decision.confluence,
    marketRegime: resultA.decision.marketRegime,
    verdict: resultA.decision.verdict,
  };
  const pipelineB = {
    trend: {
      direction: resultB.decision.engines.trend.trend['24H'],
      momentum: resultB.decision.engines.trend.momentum['24H'],
      volatility: resultB.decision.engines.trend.volatility['24H'],
      confidence: resultB.decision.engines.trend.confidence['24H'],
    },
    confluence: resultB.decision.confluence,
    marketRegime: resultB.decision.marketRegime,
    verdict: resultB.decision.verdict,
  };

  assert.notDeepEqual(pipelineA.trend, pipelineB.trend);
  assert.notEqual(pipelineA.confluence.score, pipelineB.confluence.score);
  assert.notEqual(pipelineA.confluence.bias, pipelineB.confluence.bias);
  assert.equal(pipelineA.verdict.tradeOpened, pipelineB.verdict.tradeOpened);
  assert.notEqual(pipelineA.verdict.rejectionReason, pipelineB.verdict.rejectionReason);
});

test('same candle and raw input produce deterministic Analyzer semantics across fresh graphs', () => {
  const candles = normalizedCandleInput();
  const raw = causalPath(Array.from({ length: 20 }, (_, index) => 100 + index));
  const first = runGraph(candles, raw).result;
  const second = runGraph(candles, raw).result;

  assert.deepEqual(
    semanticAnalysis(first.decision.engines.trend),
    semanticAnalysis(second.decision.engines.trend),
  );
  assert.deepEqual(first.decision.confluence.components, second.decision.confluence.components);
  assert.deepEqual(first.decision.marketRegime, second.decision.marketRegime);
  assert.deepEqual(first.decision.verdict, second.decision.verdict);
  assert.equal(typeof first.decision.engines.trend.analyzedAt, 'string');
  assert.equal(typeof second.decision.engines.trend.analyzedAt, 'string');
});

test('Analyzer sampling density is semantically relevant even for similar broad movement', () => {
  const sparse = causalPath([100, 105, 110, 115, 120], { intervalMs: 5 * MINUTE });
  const dense = causalPath(Array.from({ length: 41 }, (_, index) => 100 + index / 2), { intervalMs: 30 * 1000 });
  const boundaryTimeMs = BASE_TIME + HOUR;
  const sparseResult = analyzerAtBoundary(sparse, boundaryTimeMs);
  const denseResult = analyzerAtBoundary(dense, boundaryTimeMs);

  assert.equal(sparseResult.metadata.eventTimestampMs <= boundaryTimeMs, true);
  assert.equal(denseResult.metadata.eventTimestampMs <= boundaryTimeMs, true);
  assert.equal(sparseResult.analysis.price, denseResult.analysis.price);
  assert.equal(sparseResult.analysis.trend['24H'], denseResult.analysis.trend['24H']);
  assert.notEqual(sparseResult.analysis.dataPoints['24H'], denseResult.analysis.dataPoints['24H']);
  assert.notEqual(sparseResult.analysis.confidence['24H'], denseResult.analysis.confidence['24H']);
});

test('replay Analyzer volume24h and change24h are raw snapshot fields, not candle volume or OHLC reconstruction', () => {
  const input = causalPath([100, 101], { volume: 987654, change24h: 12.34 });
  const result = analyzerAtBoundary(input, BASE_TIME + HOUR);

  assert.equal(result.analysis.volume24h, 987655);
  assert.equal(result.analysis.change24h, 12.35);
  assert.notEqual(result.analysis.volume24h, 2);
  assert.equal(Object.hasOwn(input.snapshots[1], 'volume'), true);
  assert.equal(Object.hasOwn(input.snapshots[1], 'change24h'), true);
});

test('canonical replay retains causal boundary semantics rather than exact live event timing parity', () => {
  const candles = normalizedCandleInput(16);
  const raw = causalPath([100, 101]);
  const boundaryTimeMs = candles.candles[candles.candles.length - 1].openTime + HOUR;
  const { bundle, result } = runGraph(candles, raw);

  assert.equal(bundle.analyzerHistory.getEventTimestamp(), BASE_TIME + 2 * MINUTE);
  assert.equal(bundle.analyzerHistory.getEventTimestamp() <= boundaryTimeMs, true);
  assert.equal(bundle.clock.nowMs(), boundaryTimeMs);
  assert.equal(result.timestamp, new Date(boundaryTimeMs).toISOString());
  assert.equal(result.decision.engines.trend.timestamp, new Date(BASE_TIME + 2 * MINUTE).toISOString());
  assert.equal(result.decision.timestamp, new Date(boundaryTimeMs).toISOString());
});
