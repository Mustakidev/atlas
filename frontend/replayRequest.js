(function(root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AtlasReplayRequest = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  var HOUR_MS = 3_600_000;
  var DAY_MS = 86_400_000;
  var DEFAULT_REPLAY_DAYS = 30;
  var MIN_START_TIME = DAY_MS;
  var MAX_DATE_MS = 8_640_000_000_000_000;

  function assertNowMs(nowMs) {
    if (typeof nowMs !== 'number' || !Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new TypeError('nowMs must be a non-negative safe integer');
    }
  }

  function createReplayRequest(nowMs) {
    assertNowMs(nowMs);

    var endTime = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
    var startTime = endTime - (DEFAULT_REPLAY_DAYS * DAY_MS);

    if (startTime < MIN_START_TIME) {
      throw new RangeError('nowMs is too early for the canonical replay horizon');
    }
    if (!Number.isSafeInteger(endTime)
      || endTime + HOUR_MS > MAX_DATE_MS) {
      throw new RangeError('nowMs is outside the canonical replay date range');
    }

    return Object.freeze({
      symbol: 'BTCUSDT',
      startTime: startTime,
      endTime: endTime,
    });
  }

  function buildUrl(apiBase, nowMs) {
    if (typeof apiBase !== 'string') throw new TypeError('apiBase must be a string');

    var request = createReplayRequest(nowMs);
    var params = new URLSearchParams();
    params.set('symbol', request.symbol);
    params.set('startTime', String(request.startTime));
    params.set('endTime', String(request.endTime));

    return apiBase.replace(/\/+$/, '') + '/api/strategy/replay/v2?' + params.toString();
  }

  return Object.freeze({
    HOUR_MS: HOUR_MS,
    DAY_MS: DAY_MS,
    DEFAULT_REPLAY_DAYS: DEFAULT_REPLAY_DAYS,
    createReplayRequest: createReplayRequest,
    buildUrl: buildUrl,
  });
}));
