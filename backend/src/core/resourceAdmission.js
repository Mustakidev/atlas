const ANALYTICAL_CAPACITY = 1;
const GENERATED_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;
const RETRY_AFTER_SECONDS = 1;
const ANALYTICAL_PATHS = new Set([
  '/strategy/replay/v2',
  '/backtest',
  '/analytics',
  '/validation',
]);

function analyticalCapacityResponse(res) {
  res.set('Retry-After', String(RETRY_AFTER_SECONDS));
  return res.status(429).json({
    error: 'Analytical capacity exceeded',
    code: 'ANALYTICAL_CAPACITY_EXCEEDED',
  });
}

function createResourceAdmission() {
  let activeAnalyticalCount = 0;
  let analyticalCapacityRejects = 0;
  let responseBudgetRejects = 0;

  function isAnalyticalRequest(req) {
    return req.method === 'GET' && ANALYTICAL_PATHS.has(req.path);
  }

  function acquireAnalytical() {
    if (activeAnalyticalCount >= ANALYTICAL_CAPACITY) {
      analyticalCapacityRejects++;
      return null;
    }

    activeAnalyticalCount++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      activeAnalyticalCount--;
    };
  }

  function middleware() {
    return (req, res, next) => {
      if (!isAnalyticalRequest(req)) return next();

      const release = acquireAnalytical();
      if (!release) return analyticalCapacityResponse(res);

      req.resourceAdmission = admission;
      res.once('finish', release);
      res.once('close', release);
      return next();
    };
  }

  function sendGeneratedJson(res, result) {
    const serialized = JSON.stringify(result);
    const bytes = Buffer.byteLength(serialized, 'utf8');
    if (bytes > GENERATED_RESPONSE_MAX_BYTES) {
      responseBudgetRejects++;
      return res.status(500).json({
        error: 'Response exceeds resource budget',
        code: 'RESPONSE_TOO_LARGE',
      });
    }

    return res.type('json').send(serialized);
  }

  const admission = Object.freeze({
    acquireAnalytical,
    middleware,
    sendGeneratedJson,
    getStatus: () => Object.freeze({
      activeAnalyticalCount,
      analyticalCapacityRejects,
      responseBudgetRejects,
    }),
  });

  return admission;
}

module.exports = {
  ANALYTICAL_CAPACITY,
  ANALYTICAL_PATHS,
  GENERATED_RESPONSE_MAX_BYTES,
  RETRY_AFTER_SECONDS,
  createResourceAdmission,
};
