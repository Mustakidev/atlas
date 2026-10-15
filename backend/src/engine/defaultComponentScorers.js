function scoreTrend(candles, tf, ctx) {
  const analysis = ctx.analysis;
  if (!analysis || !analysis.trend) {
    return { score: null, direction: null, available: false, reason: 'No analysis data' };
  }

  const trendVal = analysis.trend[ctx.analyzerTf];
  const confVal = analysis.confidence ? analysis.confidence[ctx.analyzerTf] || 0 : 0;

  if (!trendVal) {
    return { score: null, direction: null, available: false, reason: `No trend data for ${ctx.analyzerTf}` };
  }

  let score;
  if (trendVal === 'Bullish') {
    score = 65 + Math.min(confVal * 0.35, 35);
  } else if (trendVal === 'Bearish') {
    score = 35 - Math.min(confVal * 0.35, 35);
  } else {
    score = 50;
  }

  return {
    score: Math.round(Math.max(0, Math.min(100, score))),
    direction: trendVal.toLowerCase(),
    available: true,
    confidence: confVal,
  };
}

function scoreStructure(candles, tf, ctx, structureEngine) {
  const result = structureEngine.calculate(candles);

  if (!result.ready) {
    return { score: null, direction: null, available: false, reason: result.reason };
  }

  return {
    score: result.score,
    direction: result.direction,
    available: true,
    confidence: result.confidence,
  };
}

function scoreMomentum(candles, tf, ctx) {
  const analysis = ctx.analysis;
  if (!analysis || !analysis.momentum) {
    return { score: null, direction: null, available: false, reason: 'No analysis data' };
  }

  const momVal = analysis.momentum[ctx.analyzerTf];
  if (momVal === undefined || momVal === null) {
    return { score: null, direction: null, available: false, reason: `No momentum data for ${ctx.analyzerTf}` };
  }

  let direction = 'neutral';
  if (momVal > 55) direction = 'bullish';
  else if (momVal < 45) direction = 'bearish';

  return {
    score: Math.round(Math.max(0, Math.min(100, momVal))),
    direction,
    available: true,
    confidence: analysis.confidence ? analysis.confidence[ctx.analyzerTf] || 50 : 50,
  };
}

function scoreRsi(candles, tf, ctx, indicatorRegistry) {
  const rsiIndicator = indicatorRegistry.get('RSI');
  if (!rsiIndicator) {
    return { score: null, direction: null, available: false, reason: 'RSI indicator not registered' };
  }

  const result = rsiIndicator.calculate(candles, tf);
  if (!result.ready) {
    return { score: null, direction: null, available: false, reason: result.reason || 'RSI not ready' };
  }

  // The confluence score is directional (50 = neutral), so RSI contributes its
  // value, not its distance from 50. The value is clamped to 30-70 so extreme
  // readings confirm direction without dominating the other components.
  const value = Number.isFinite(result.value) ? result.value : 50;
  const score = Math.round(Math.max(30, Math.min(70, value)));
  let direction = 'neutral';
  if (value > 55) direction = 'bullish';
  else if (value < 45) direction = 'bearish';

  return {
    score,
    direction,
    available: true,
    confidence: result.confidence || 50,
  };
}

function scoreVolatility(candles, tf, ctx) {
  const analysis = ctx.analysis;
  if (!analysis || !analysis.volatility) {
    return { score: null, direction: null, available: false, reason: 'No analysis data' };
  }

  const volVal = analysis.volatility[ctx.analyzerTf];
  if (!volVal) {
    return { score: null, direction: null, available: false, reason: `No volatility data for ${ctx.analyzerTf}` };
  }

  // Volatility has no direction. It stays a reported component but always votes
  // neutral so that calm markets are not read as bullish or volatile ones as bearish.
  return {
    score: 50,
    direction: null,
    available: true,
    confidence: analysis.confidence ? analysis.confidence[ctx.analyzerTf] || 50 : 50,
  };
}

function createDefaultComponents({ structureEngine, indicatorRegistry }) {
  return [
    {
      name: 'trend',
      weight: 0.30,
      calculate: scoreTrend,
    },
    {
      name: 'structure',
      weight: 0.25,
      calculate: (candles, tf, ctx) => scoreStructure(candles, tf, ctx, structureEngine),
    },
    {
      name: 'momentum',
      weight: 0.15,
      calculate: scoreMomentum,
    },
    {
      name: 'rsi',
      weight: 0.15,
      calculate: (candles, tf, ctx) => scoreRsi(candles, tf, ctx, indicatorRegistry),
    },
    {
      name: 'volatility',
      weight: 0.15,
      calculate: scoreVolatility,
    },
  ];
}

module.exports = { createDefaultComponents };
