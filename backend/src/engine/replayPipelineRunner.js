const { assertTimestamp } = require('../core/clock');
const { createExecutionPipeline } = require('../core/executionPipeline');

const REQUIRED_DEPENDENCY_METHODS = Object.freeze({
  candleEngine: ['hasNext', 'nextActive', 'getActive', 'getCandles', 'finalizeActive'],
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
  paperTradeEngine: ['evaluateTrades', 'onCandle', 'signal', 'open', 'closed', 'getBalance'],
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

function failureDetails(error, index, openTime) {
  return {
    code: typeof error?.code === 'string' ? error.code : 'CYCLE_FAILED',
    message: error instanceof Error ? error.message : String(error),
    index,
    openTime,
  };
}

function createReplayPipelineRunner({ dependencies, normalizedInput } = {}) {
  validateDependencies(dependencies);
  validateNormalizedInput(normalizedInput, dependencies.candleEngine);

  const executionPipeline = createExecutionPipeline(dependencies);
  let status = 'READY';
  let cycleCount = 0;
  let nextIndex = 0;
  let lastResult = null;
  let failure = null;

  function hasNext() {
    return status === 'READY'
      && nextIndex < normalizedInput.candles.length
      && dependencies.candleEngine.hasNext();
  }

  function runNextCycle() {
    if (status === 'FAILED') {
      throw new ReplayPipelineRunnerError(
        'RUNNER_FAILED',
        `Replay pipeline runner failed at cycle index ${failure.index}`,
      );
    }
    if (status === 'EXHAUSTED' || !hasNext()) {
      status = 'EXHAUSTED';
      throw new ReplayPipelineRunnerError('NO_REMAINING_CANDLES', 'No remaining replay candles');
    }

    const index = nextIndex;
    const expectedCandle = normalizedInput.candles[index];
    let activeCandle = null;

    try {
      dependencies.clockController.advanceTo(expectedCandle.openTime);
      activeCandle = dependencies.candleEngine.nextActive();

      if (activeCandle !== expectedCandle || activeCandle.openTime !== expectedCandle.openTime) {
        fail('CANDLE_MISMATCH', `Activated candle does not match normalizedInput.candles[${index}]`);
      }

      executionPipeline.run({
        price: expectedCandle.close,
        timestamp: expectedCandle.timestamp,
      });

      const decision = executionPipeline.getLastDecision();
      if (!decision) fail('MISSING_DECISION', 'Canonical execution pipeline produced no decision');
      const frozenDecision = cloneAndFreeze(decision);

      const result = cloneAndFreeze({
        index,
        openTime: expectedCandle.openTime,
        timestamp: expectedCandle.timestamp,
        price: expectedCandle.close,
        decision: frozenDecision,
      });
      const completedNextIndex = index + 1;
      const completedStatus = completedNextIndex >= normalizedInput.candles.length
        ? 'EXHAUSTED'
        : 'READY';

      dependencies.candleEngine.finalizeActive();

      lastResult = result;
      nextIndex = completedNextIndex;
      cycleCount += 1;
      status = completedStatus;

      return result;
    } catch (error) {
      if (activeCandle !== null) {
        failure = Object.freeze(failureDetails(error, index, expectedCandle.openTime));
        status = 'FAILED';
      }
      throw error;
    }
  }

  function getState() {
    return cloneAndFreeze({
      status,
      cycleCount,
      nextIndex,
      lastResult: lastResult === null ? null : cloneAndFreeze(lastResult),
      failure: failure === null ? null : cloneAndFreeze(failure),
    });
  }

  return Object.freeze({ hasNext, runNextCycle, getState });
}

module.exports = { createReplayPipelineRunner };
