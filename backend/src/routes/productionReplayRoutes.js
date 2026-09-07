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
const REPLAY_EXECUTION_DEADLINE_MS = 180_000;
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

function createReplayCancellation({ req, res, deadlineMs } = {}) {
  const controller = new AbortController();
  let completed = false;
  let deadlineExpired = false;
  let disconnected = false;
  let lifecycleSignal = null;

  const abort = reason => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  const onRequestAbort = () => {
    disconnected = true;
    abort(new Error('Replay client disconnected'));
  };
  const onResponseClose = () => {
    if (completed) return;
    disconnected = true;
    abort(new Error('Replay client disconnected'));
  };
  const onLifecycleAbort = () => abort(lifecycleSignal.reason);
  const timer = setTimeout(() => {
    deadlineExpired = true;
    abort(new Error('Replay execution deadline exceeded'));
  }, deadlineMs);

  req.once('aborted', onRequestAbort);
  res.once('close', onResponseClose);

  function attachLifecycle(signal) {
    lifecycleSignal = signal;
    if (!signal) return;
    if (signal.aborted) onLifecycleAbort();
    else signal.addEventListener('abort', onLifecycleAbort, { once: true });
  }

  function cleanup() {
    clearTimeout(timer);
    req.removeListener('aborted', onRequestAbort);
    res.removeListener('close', onResponseClose);
    lifecycleSignal?.removeEventListener('abort', onLifecycleAbort);
  }

  function complete() {
    completed = true;
    cleanup();
  }

  return Object.freeze({
    signal: controller.signal,
    attachLifecycle,
    complete,
    cleanup,
    get deadlineExpired() { return deadlineExpired; },
    get disconnected() { return disconnected; },
  });
}

function createProductionReplayRouter({
  application,
  logger,
  lifecycle,
  deadlineMs = REPLAY_EXECUTION_DEADLINE_MS,
} = {}) {
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

    const cancellation = createReplayCancellation({
      req,
      res,
      deadlineMs,
    });

    try {
      let replaySignal;
      const replay = ({ signal }) => {
        replaySignal = signal;
        cancellation.attachLifecycle(signal);
        return application.run(request, { signal: cancellation.signal });
      };
      const task = lifecycle ? lifecycle.startReplay(replay) : replay({ signal: undefined });
      if (task === null) {
        cancellation.complete();
        return res.status(503).json({ error: 'Server shutting down' });
      }
      const result = await task;
      if (cancellation.deadlineExpired) {
        cancellation.complete();
        return res.status(504).json({
          error: 'Replay execution timed out',
          code: 'REPLAY_TIMEOUT',
        });
      }
      if (res.destroyed || res.writableEnded || cancellation.disconnected) {
        cancellation.complete();
        return undefined;
      }
      if (result === null
        || replaySignal?.aborted
        || lifecycle?.isShuttingDown?.()) {
        cancellation.complete();
        return res.status(503).json({ error: 'Server shutting down' });
      }
      const send = req.resourceAdmission?.sendGeneratedJson;
      const response = typeof send === 'function'
        ? send(res, result)
        : res.json(result);
      cancellation.complete();
      return response;
    } catch (error) {
      if (cancellation.deadlineExpired) {
        cancellation.complete();
        if (res.destroyed || res.writableEnded) return undefined;
        return res.status(504).json({
          error: 'Replay execution timed out',
          code: 'REPLAY_TIMEOUT',
        });
      }
      if (res.destroyed || res.writableEnded || cancellation.disconnected) {
        cancellation.complete();
        return undefined;
      }
      cancellation.complete();
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
