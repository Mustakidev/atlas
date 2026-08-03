const MAX_DATE_MS = 8640000000000000;

function assertTimestamp(value, label = 'timestamp') {
  const date = new Date(value);
  if (!Number.isFinite(value)
    || !Number.isInteger(value)
    || value < 0
    || value > MAX_DATE_MS
    || !Number.isFinite(date.getTime())) {
    throw new TypeError(`${label} must be a finite integer valid for JavaScript Date`);
  }

  return value;
}

function assertMonotonicMs(value, label = 'monotonicMs') {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${label} must be finite`);
  }

  return value;
}

function createSystemClock() {
  return {
    nowMs: () => assertTimestamp(Date.now(), 'system nowMs'),
    monotonicMs: () => assertMonotonicMs(Number(process.hrtime.bigint()) / 1000000, 'system monotonicMs'),
  };
}

function resolveClock(clock) {
  if (clock == null) return createSystemClock();
  if (typeof clock !== 'object') {
    throw new TypeError('clock must be an object, null, or undefined');
  }

  const hasModernSource = Object.hasOwn(clock, 'nowMs') || Object.hasOwn(clock, 'monotonicMs');
  const nowSource = clock.nowMs ?? clock.now;
  const monotonicSource = clock.monotonicMs ?? clock.monotonic;
  if (typeof nowSource !== 'function') {
    throw new TypeError('clock.nowMs must be a function');
  }
  if (hasModernSource && typeof monotonicSource !== 'function') {
    throw new TypeError('clock.monotonicMs must be a function');
  }

  const systemClock = createSystemClock();
  return {
    nowMs: () => assertTimestamp(nowSource.call(clock), 'clock.nowMs()'),
    monotonicMs: () => assertMonotonicMs(
      (typeof monotonicSource === 'function' ? monotonicSource : systemClock.monotonicMs).call(clock),
      'clock.monotonicMs()'
    ),
  };
}

function readNowMs(clock) {
  return assertTimestamp(clock.nowMs(), 'clock.nowMs()');
}

function readMonotonicMs(clock) {
  return assertMonotonicMs(clock.monotonicMs(), 'clock.monotonicMs()');
}

function resolveCycleNowMs(clock, explicitNowMs) {
  return explicitNowMs === undefined
    ? readNowMs(clock)
    : assertTimestamp(explicitNowMs, 'cycle nowMs');
}

function captureCycleTime(clock) {
  const nowMs = readNowMs(clock);
  const date = new Date(nowMs);

  return Object.freeze({
    nowMs,
    isoNow: date.toISOString(),
    localeTime: date.toLocaleTimeString(),
  });
}

function formatTimestamp(nowMs) {
  return new Date(assertTimestamp(nowMs)).toISOString();
}

function utcDateKey(nowMs) {
  return formatTimestamp(nowMs).slice(0, 10);
}

function elapsedMs(clock, startMs) {
  const duration = readMonotonicMs(clock) - startMs;
  if (!Number.isFinite(duration) || duration < 0) {
    throw new TypeError('monotonicMs must not move backwards');
  }

  return duration;
}

module.exports = {
  assertTimestamp,
  captureCycleTime,
  createSystemClock,
  elapsedMs,
  formatTimestamp,
  readNowMs,
  readMonotonicMs,
  resolveClock,
  resolveCycleNowMs,
  utcDateKey,
};
