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

  let direction = 'neutral';
  if (result.state === 'Overbought') direction = 'neutral';
  else if (result.state === 'Oversold') direction = 'neutral';
  else {
    if (result.value > 55) direction = 'bullish';
    else if (result.value < 45) direction = 'bearish';
  }

  return {
    score: result.strength,
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

  let score;
  if (volVal === 'Low') score = 85;
  else if (volVal === 'Medium') score = 50;
  else score = 15;

  return {
    score,
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
