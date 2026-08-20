(function(root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AtlasReplayPresentation = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  var MINUTE_MS = 60_000;
  var HOUR_MS = 3_600_000;
  var DAY_MS = 86_400_000;
  var INVALID_PAYLOAD_MESSAGE = 'Invalid canonical replay payload';

  function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    var prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function rejectPayload() {
    throw new TypeError(INVALID_PAYLOAD_MESSAGE);
  }

  function optionalValue(source, key) {
    return source[key] === undefined ? null : source[key];
  }

  function freeze(value, seen) {
    if (!value || typeof value !== 'object') return value;
    seen = seen || [];
    if (seen.indexOf(value) !== -1) return value;
    seen.push(value);
    Object.keys(value).forEach(function(key) { freeze(value[key], seen); });
    return Object.freeze(value);
  }

  function directionStats(stats, direction) {
    if (stats === undefined || stats === null) return null;
    var source = stats[direction];
    if (source === undefined || source === null) return null;
    if (!isPlainObject(source)) rejectPayload();
    return {
      total: optionalValue(source, 'total'),
      wins: optionalValue(source, 'wins'),
      losses: optionalValue(source, 'losses'),
      winRate: optionalValue(source, 'winRate'),
      totalPnl: optionalValue(source, 'totalPnl'),
    };
  }

  function outcome(status, pnl) {
    if (status === 'PENDING') return 'PENDING';
    if (status === 'OPEN' || status === 'ACTIVE') return 'OPEN';
    if (status === 'CLOSED') {
      if (typeof pnl === 'number' && Number.isFinite(pnl)) {
        if (pnl > 0) return 'PROFIT';
        if (pnl < 0) return 'LOSS';
        return 'BREAKEVEN';
      }
      return 'CLOSED';
    }
    if (status == null) return null;
    rejectPayload();
  }

  function formatDuration(durationMs) {
    if (typeof durationMs !== 'number'
      || !Number.isFinite(durationMs)
      || durationMs < 0) return '--';

    if (durationMs < MINUTE_MS) return Math.floor(durationMs / 1000) + 's';
    if (durationMs < HOUR_MS) return Math.floor(durationMs / MINUTE_MS) + 'm';
    if (durationMs < DAY_MS) {
      var hours = Math.floor(durationMs / HOUR_MS);
      var minutes = Math.floor((durationMs % HOUR_MS) / MINUTE_MS);
      return hours + 'h ' + minutes + 'm';
    }

    var days = Math.floor(durationMs / DAY_MS);
    var remainingHours = Math.floor((durationMs % DAY_MS) / HOUR_MS);
    return days + 'd ' + remainingHours + 'h';
  }

  function presentTrade(trade) {
    if (!isPlainObject(trade)) rejectPayload();
    var pnl = optionalValue(trade, 'pnl');
    return {
      tradeId: optionalValue(trade, 'tradeId'),
      direction: optionalValue(trade, 'direction'),
      entry: optionalValue(trade, 'entryPrice'),
      exit: optionalValue(trade, 'exitPrice'),
      stopLoss: optionalValue(trade, 'stopLoss'),
      takeProfit: optionalValue(trade, 'takeProfit'),
      status: optionalValue(trade, 'status'),
      outcome: outcome(trade.status, pnl),
      exitReason: optionalValue(trade, 'exitReason'),
      durationMs: optionalValue(trade, 'duration'),
      durationText: formatDuration(trade.duration),
      entryTime: optionalValue(trade, 'entryTime'),
      exitTime: optionalValue(trade, 'exitTime'),
      pnl: pnl,
    };
  }

  function presentCanonicalReplay(data) {
    if (!isPlainObject(data) || !isPlainObject(data.replay)) rejectPayload();
    if (!isPlainObject(data.replay.stats) || !Array.isArray(data.replay.trades)) {
      rejectPayload();
    }
    if (data.replay.runnerState !== undefined
      && data.replay.runnerState !== null
      && !isPlainObject(data.replay.runnerState)) rejectPayload();

    var stats = data.replay.stats;
    var profitFactor = stats.profitFactor;
    if (profitFactor !== undefined
      && !((typeof profitFactor === 'number' && Number.isFinite(profitFactor))
        || profitFactor === 'Infinity')) rejectPayload();
    var directionMap = stats.byDirection;
    if (directionMap !== undefined && directionMap !== null && !isPlainObject(directionMap)) {
      rejectPayload();
    }
    var runnerState = data.replay.runnerState || {};

    var trades = data.replay.trades;
    for (var i = 0; i < trades.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(trades, i)) rejectPayload();
    }

    return freeze({
      completion: {
        status: optionalValue(runnerState, 'status'),
        cyclesProcessed: optionalValue(runnerState, 'cycleCount'),
      },
      summary: {
        totalTrades: optionalValue(stats, 'totalTrades'),
        winRate: optionalValue(stats, 'winRate'),
        profitFactor: optionalValue(stats, 'profitFactor'),
        expectancy: optionalValue(stats, 'expectancy'),
        maxDrawdownPct: optionalValue(stats, 'maxDrawdownPct'),
        totalPnl: optionalValue(stats, 'totalPnl'),
      },
      directions: {
        BUY: directionStats(directionMap, 'BUY'),
        SELL: directionStats(directionMap, 'SELL'),
      },
      trades: trades.map(presentTrade),
    });
  }

  return Object.freeze({ presentCanonicalReplay: presentCanonicalReplay, formatDuration: formatDuration });
}));
