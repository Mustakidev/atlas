const express = require('express');
const {
  ProductionReplayApplicationError,
} = require('../application/productionReplayApplication');
const { isCancellation } = require('../core/cancellation');

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const MIN_START_TIME = DAY_MS;
const MIN_HORIZON_MS = 51 * HOUR_MS;
const MAX_HORIZON_MS = 99 * DAY_MS - HOUR_MS;
const MAX_DATE_MS = 8_640_000_000_000_000;
const REQUEST_KEYS = Object.freeze(['symbol', 'startTime', 'endTime']);

const APP_ERROR_RESPONSES = new Map([
  ['INVALID_REQUEST', {
    status: 400,
    body: Object.freeze({
      error: 'Invalid canonical replay request',
      code: 'INVALID_REQUEST',
    }),
  }],
  ['MTF_SOURCE_FAILURE', {
    status: 502,
    body: Object.freeze({
      error: 'Canonical replay source unavailable',
      code: 'MTF_SOURCE_FAILURE',
    }),
  }],
  ['ANALYZER_SOURCE_FAILURE', {
    status: 502,
    body: Object.freeze({
      error: 'Canonical replay source unavailable',
      code: 'ANALYZER_SOURCE_FAILURE',
    }),
  }],
  ['SOURCE_MISMATCH', {
    status: 502,
    body: Object.freeze({
      error: 'Canonical replay source contract failure',
      code: 'SOURCE_MISMATCH',
    }),
  }],
  ['DEPENDENCY_FAILURE', {
    status: 500,
    body: Object.freeze({
      error: 'Canonical replay dependency failure',
      code: 'DEPENDENCY_FAILURE',
    }),
  }],
  ['REPLAY_FAILURE', {
    status: 500,
    body: Object.freeze({
      error: 'Canonical replay failed',
      code: 'REPLAY_FAILURE',
    }),
  }],
  ['CANCELLED', {
    status: 503,
    body: Object.freeze({ error: 'Server shutting down' }),
  }],
]);

function invalidRequest(res) {
  return res.status(400).json({
    error: 'Invalid canonical replay request',
    code: 'INVALID_REQUEST',
  });
}

function isValidDateMs(value) {
  return Number.isSafeInteger(value)
    && value >= 0
    && value <= MAX_DATE_MS
    && Number.isFinite(new Date(value).getTime());
}

function parseTimestamp(raw) {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;

  const value = Number(raw);
  if (!isValidDateMs(value)) return null;
  return value;
}

function parseCanonicalRequest(query) {
  if (!query || typeof query !== 'object' || Array.isArray(query)) return null;

  const keys = Reflect.ownKeys(query);
  if (keys.length !== REQUEST_KEYS.length
    || keys.some(key => typeof key !== 'string' || !REQUEST_KEYS.includes(key))) {
    return null;
  }

  for (const key of REQUEST_KEYS) {
    if (!Object.hasOwn(query, key) || typeof query[key] !== 'string') return null;
  }

  if (query.symbol !== 'BTCUSDT') return null;

  const startTime = parseTimestamp(query.startTime);
  const endTime = parseTimestamp(query.endTime);
  if (startTime === null || endTime === null) return null;
  if (startTime < MIN_START_TIME || endTime <= startTime) return null;
  if (startTime % HOUR_MS !== 0 || endTime % HOUR_MS !== 0) return null;

  const horizon = endTime - startTime;
  if (horizon < MIN_HORIZON_MS || horizon > MAX_HORIZON_MS) return null;
  if (!isValidDateMs(endTime + HOUR_MS)) return null;

  return {
    symbol: 'BTCUSDT',
    startTime,
    endTime,
  };
}

function logKnownApplicationError(logger, error) {
  const data = { code: error.code };
  if (typeof error.source === 'string') data.source = error.source;
  if (typeof error.phase === 'string') data.phase = error.phase;
  try {
    logger.error('CanonicalReplay', 'Canonical replay application failed', data);
  } catch {
    // Logging must never alter the public canonical error contract.
  }
}

function createProductionReplayRouter({ application, logger, lifecycle } = {}) {
  if (application !== null && application !== undefined
    && typeof application.run !== 'function') {
    throw new TypeError('application.run must be a function when application is provided');
  }
  if (!logger || typeof logger !== 'object' || typeof logger.error !== 'function') {
    throw new TypeError('logger.error must be a function');
  }

  const router = express.Router();

  router.get('/strategy/replay/v2', async (req, res, next) => {
    const request = parseCanonicalRequest(req.query);
    if (!request) return invalidRequest(res);

    if (application === null || application === undefined) {
      return res.status(503).json({
        error: 'Canonical replay application unavailable',
        code: 'CANONICAL_REPLAY_UNAVAILABLE',
      });
    }

    try {
      let replaySignal;
      const result = lifecycle
        ? await lifecycle.startReplay(({ signal }) => {
          replaySignal = signal;
          return application.run(request, { signal });
        })
        : await application.run(request);
      if (res.destroyed || res.writableEnded) return undefined;
      if (result === null
        || replaySignal?.aborted
        || lifecycle?.isShuttingDown?.()) {
        return res.status(503).json({ error: 'Server shutting down' });
      }
      return res.json(result);
    } catch (error) {
      if (res.destroyed || res.writableEnded) return undefined;
      if (isCancellation(error)) return res.status(503).json({ error: 'Server shutting down' });
      if (!(error instanceof ProductionReplayApplicationError)) return next(error);

      const response = APP_ERROR_RESPONSES.get(error.code);
      if (!response) return next(error);

      if (error.code === 'CANCELLED') return res.status(response.status).json(response.body);
      logKnownApplicationError(logger, error);
      return res.status(response.status).json(response.body);
    }
  });

  return router;
}

module.exports = { createProductionReplayRouter };
