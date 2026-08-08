const { assertTimestamp } = require('../core/clock');
const { createExecutionPipeline } = require('../core/executionPipeline');

const PRIMARY_CANDLE_DURATION_MS = 3_600_000;

const REQUIRED_DEPENDENCY_METHODS = Object.freeze({
  candleEngine: ['hasNext', 'prepareBoundary', 'commitBoundary', 'getActive', 'getCandles'],
  clockController: ['advanceTo'],
  config: ['get'],
  logger: ['info', 'warn', 'error'],
  regimeEngine: ['calculate'],
  confluenceEngine: ['calculate'],
  atrEngine: ['calculate'],
  analyzer: ['getAnalysis'],
  structureEngine: ['calculate'],
  indicatorRegistry: ['get'],
  macdEngine: ['calculate'],
  bollingerEngine: ['calculate'],
  regimeDecisionEngine: ['evaluate'],
  mtfConfirmationEngine: ['evaluate'],
  advanceRiskEngine: ['evaluate', 'onTradeClosed'],
  mtfEngine: ['calculate'],
  paperTradeEngine: ['evaluateTrades', 'onCandle', 'signal', 'open', 'close', 'closed', 'getBalance'],
});

class ReplayPipelineRunnerError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = 'ReplayPipelineRunnerError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ReplayPipelineRunnerError(code, message);
}

function assertObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_INPUT', `${name} must be a non-array object`);
  }
}

function assertMethods(value, name, methods) {
  assertObject(value, name);
  for (const method of methods) {
    if (typeof value[method] !== 'function') {
      fail('INVALID_DEPENDENCIES', `${name}.${method} must be a function`);
    }
  }
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;

  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
}

function cloneAndFreeze(value) {
  return deepFreeze(structuredClone(value));
}

function validateDependencies(dependencies) {
  assertObject(dependencies, 'dependencies');

  for (const [name, methods] of Object.entries(REQUIRED_DEPENDENCY_METHODS)) {
    assertMethods(dependencies[name], name, methods);
  }

  assertObject(dependencies.clock, 'dependencies.clock');
  if (typeof dependencies.clock.nowMs !== 'function'
    || typeof dependencies.clock.monotonicMs !== 'function') {
    fail('INVALID_DEPENDENCIES', 'dependencies.clock must expose nowMs() and monotonicMs()');
  }
  if (typeof dependencies.symbol !== 'string' || dependencies.symbol.trim() === '') {
    fail('INVALID_DEPENDENCIES', 'dependencies.symbol must be a non-empty string');
  }
  if (typeof dependencies.candleEngine.timeframe !== 'string') {
    fail('INVALID_DEPENDENCIES', 'dependencies.candleEngine.timeframe must be a string');
  }
}

function validateNormalizedInput(normalizedInput, candleEngine) {
  assertObject(normalizedInput, 'normalizedInput');
  if (normalizedInput.schemaVersion !== 1) {
    fail('INVALID_INPUT', 'normalizedInput.schemaVersion must be 1');
  }
  if (normalizedInput.timeframe !== '1h') {
    fail('INVALID_TIMEFRAME', 'Unit 2E replay timeframe must be exactly 1h');
  }
  if (!Array.isArray(normalizedInput.candles) || !Object.isFrozen(normalizedInput.candles)) {
    fail('INVALID_CANDLES', 'normalizedInput.candles must be a frozen array');
  }
  if (normalizedInput.candles.length === 0) {
    fail('INVALID_CANDLES', 'normalizedInput.candles must contain at least one candle');
  }
  if (candleEngine.timeframe !== normalizedInput.timeframe) {
    fail('TIMEFRAME_MISMATCH', 'Replay candle engine timeframe must match normalizedInput.timeframe');
  }

  normalizedInput.candles.forEach((candle, index) => {
    if (!candle || typeof candle !== 'object' || Array.isArray(candle) || !Object.isFrozen(candle)) {
      fail('INVALID_CANDLE', `normalizedInput.candles[${index}] must be a frozen object`);
    }
    try {
      assertTimestamp(candle.openTime, `normalizedInput.candles[${index}].openTime`);
    } catch (error) {
      fail('INVALID_CANDLE', error.message);
    }
    if (!Number.isFinite(candle.close) || candle.close <= 0) {
      fail('INVALID_CANDLE', `normalizedInput.candles[${index}].close must be finite and greater than zero`);
    }
  });
}

function failureDetails(error, {
  phase,
  index,
  openTime,
  boundaryTime,
  commitConfirmed,
  clockAdvanced,
}) {
  return {
    code: 'CYCLE_FAILED',
    message: error instanceof Error ? error.message : String(error),
    phase,
    sourceIndex: index,
    openTime,
    boundaryTime,
    commitConfirmed,
    clockAdvanced,
    causeCode: typeof error?.code === 'string' ? error.code : null,
    causeName: typeof error?.name === 'string' ? error.name : null,
  };
}

function isRetryableClockFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  const isHistoricalInvariant = message === 'historical clock cannot move backwards'
    || message.startsWith('historical clock timestamp must be');
  return error?.retryable === true && !isHistoricalInvariant;
}

function createReplayPipelineRunner({ dependencies, normalizedInput } = {}) {
  validateDependencies(dependencies);
  validateNormalizedInput(normalizedInput, dependencies.candleEngine);

  const executionPipeline = createExecutionPipeline(dependencies);
  let status = 'READY';
  let cycleCount = 0;
  let lastResult = null;
  let failure = null;

  function queryHasNext() {
    return dependencies.candleEngine.hasNext();
  }

  function hasNext() {
    return status === 'READY' && queryHasNext();
  }

  function settleEndOfData(boundaryTime) {
    const candidates = dependencies.paperTradeEngine.open();
    const context = Object.freeze({ nowMs: boundaryTime });

    for (const candidate of candidates) {
      const closedTrade = dependencies.paperTradeEngine.close(
        candidate.tradeId,
        'End of Data',
        context,
      );
      if (!closedTrade || closedTrade.status !== 'CLOSED') {
        fail('EOD_CLOSE_FAILED', `End-of-data close failed for trade ${candidate.tradeId}`);
      }
      dependencies.advanceRiskEngine.onTradeClosed(closedTrade.pnl, context);
    }
  }

  function runNextCycle() {
    if (status === 'FAILED') {
      throw new ReplayPipelineRunnerError(
        'RUNNER_FAILED',
        `Replay pipeline runner failed at cycle index ${failure.sourceIndex}`,
      );
    }
    if (status === 'EXHAUSTED') {
      status = 'EXHAUSTED';
      throw new ReplayPipelineRunnerError('NO_REMAINING_CANDLES', 'No remaining replay candles');
    }

    const index = cycleCount;
    const expectedCandle = normalizedInput.candles[index];
    let boundaryTime = null;
    let phase = 'PREFLIGHT';
    let commitConfirmed = false;
    let clockAdvanced = false;

    let available;
    try {
      available = queryHasNext();
    } catch (error) {
      failure = Object.freeze(failureDetails(error, {
        phase,
        index,
        openTime: expectedCandle?.openTime ?? null,
        boundaryTime,
        commitConfirmed,
        clockAdvanced,
      }));
      status = 'FAILED';
      throw new ReplayPipelineRunnerError('CYCLE_FAILED', failure.message);
    }

    if (!available) {
      status = 'EXHAUSTED';
      throw new ReplayPipelineRunnerError('NO_REMAINING_CANDLES', 'No remaining replay candles');
    }

    try {
      phase = 'PREFLIGHT';
      boundaryTime = assertTimestamp(
        expectedCandle.openTime + PRIMARY_CANDLE_DURATION_MS,
        `normalizedInput.candles[${index}].closeTime`,
      );
      const closeTimestamp = new Date(boundaryTime).toISOString();

      phase = 'PREPARE';
      const plan = dependencies.candleEngine.prepareBoundary({ boundaryTime });
      phase = 'CLOCK';
      dependencies.clockController.advanceTo(boundaryTime);
      clockAdvanced = true;
      phase = 'COMMIT';
      const transition = dependencies.candleEngine.commitBoundary(plan);
      commitConfirmed = true;

      phase = 'TRANSITION_VALIDATION';
      if (transition.sourceIndex !== index || transition.lifecycleCandle !== expectedCandle) {
        fail('CANDLE_MISMATCH', `Committed candle does not match normalizedInput.candles[${index}]`);
      }

      phase = 'SNAPSHOT';
      const price = transition.active === null
        ? expectedCandle.close
        : transition.active.open;
      const snapshot = {
        price,
        timestamp: closeTimestamp,
      };

      phase = 'PIPELINE';
      executionPipeline.run(snapshot, {
        lifecycleCandle: transition.lifecycleCandle,
      });

      phase = 'DECISION_CAPTURE';
      const decision = executionPipeline.getLastDecision();
      if (!decision) fail('MISSING_DECISION', 'Canonical execution pipeline produced no decision');

      phase = 'DECISION_CLONE';
      const frozenDecision = cloneAndFreeze(decision);

      phase = 'RESULT_CAPTURE';
      const result = cloneAndFreeze({
        index,
        openTime: expectedCandle.openTime,
        timestamp: closeTimestamp,
        price,
        decision: frozenDecision,
      });

      phase = 'EXHAUSTION';
      const completedStatus = queryHasNext()
        ? 'READY'
        : 'EXHAUSTED';

      if (completedStatus === 'EXHAUSTED') {
        phase = 'EOD_SETTLEMENT';
        settleEndOfData(boundaryTime);
      }

      lastResult = result;
      cycleCount += 1;
      status = completedStatus;

      return result;
    } catch (error) {
      if (phase === 'CLOCK' && isRetryableClockFailure(error)) {
        throw error;
      }

      failure = Object.freeze(failureDetails(error, {
        phase,
        index,
        openTime: expectedCandle?.openTime ?? null,
        boundaryTime,
        commitConfirmed,
        clockAdvanced,
      }));
      status = 'FAILED';
      throw new ReplayPipelineRunnerError('CYCLE_FAILED', failure.message);
    }
  }

  function getState() {
    return cloneAndFreeze({
      status,
      cycleCount,
      lastResult: lastResult === null ? null : cloneAndFreeze(lastResult),
      failure: failure === null ? null : cloneAndFreeze(failure),
    });
  }

  return Object.freeze({ hasNext, runNextCycle, getState });
}

module.exports = { createReplayPipelineRunner };
