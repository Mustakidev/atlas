const assert = require('node:assert/strict');
const test = require('node:test');

const {
  calculateHardAcceptanceChecks,
  createHardAcceptanceState,
  createVerificationMetrics,
  evaluateChecks,
  parseArgs,
  processHealthResults,
  recordEndpointObservation,
} = require('../../verify-pipeline');

function setup({ durationMs = 600000, pollIntervalMs = 3000 } = {}) {
  const metrics = createVerificationMetrics({
    startTime: 1000000,
    startMonotonicMs: 0,
    requestedDurationMs: durationMs,
    pollIntervalMs,
  });
  const acceptance = createHardAcceptanceState({
    metrics,
    startMonotonicMs: 0,
    durationMs,
    pollIntervalMs,
  });
  return { metrics, acceptance };
}

function inspector(cycle, timestamp = '2026-01-01T00:00:00.000Z') {
  return { cycle, timestamp };
}

function statusResponse(overrides = {}) {
  return {
    liveStateReadiness: 'READY',
    durabilityHealthy: true,
    riskStateHealthy: true,
    mutationSequence: 1,
    uptime: 100,
    pipeline: {
      pipelineCycleCount: 1,
      pipelineErrors: 0,
      riskSyncFailure: false,
      lastRunStatus: null,
    },
    ...overrides,
  };
}

function fulfilled(value) {
  return { status: 'fulfilled', value };
}

function rejected(message = 'transport failure') {
  return { status: 'rejected', reason: new Error(message) };
}

function healthyRun(sourceCycles = 16, pollAttempts = 170, inspectorSuccesses = pollAttempts, firstSourceAt = 0) {
  const context = setup();
  for (let cycle = 1; cycle <= sourceCycles; cycle++) {
    const monotonicTimestamp = cycle === 1
      ? firstSourceAt
      : firstSourceAt + Math.min(510000 + (cycle - 16) * 30000, 600000);
    context.acceptance.observeSource(inspector(cycle), 1000000 + cycle, monotonicTimestamp);
  }
  context.metrics.polling.observationPollAttempts = pollAttempts;
  context.metrics.polling.actualPollAttempts = pollAttempts;
  const inspectorFailures = new Set(Array.from({ length: pollAttempts - inspectorSuccesses }, (_, index) => (
    Math.floor(index * pollAttempts / Math.max(1, pollAttempts - inspectorSuccesses))
  )));
  for (const endpoint of ['inspector', 'paper', 'readiness', 'status']) {
    for (let attempt = 0; attempt < pollAttempts; attempt++) {
      recordEndpointObservation(context.metrics, endpoint, endpoint !== 'inspector' || !inspectorFailures.has(attempt), attempt, 'observation');
    }
  }
  context.metrics.health.pipelineErrorBaseline = 0;
  context.metrics.health.pipelineErrorFinal = 0;
  context.acceptance.complete(firstSourceAt + 600000, 1600000 + firstSourceAt);
  return context;
}

test('default source threshold is 16 for a ten-minute observation', () => {
  const { metrics } = setup();
  assert.equal(metrics.source.idealSourceSlots, 20);
  assert.equal(metrics.source.minimumRequiredSourceCycles, 16);
});

test('first source at the exact startup deadline is allowed, one tick later fails', () => {
  const exact = setup();
  exact.acceptance.checkProgress(180000);
  exact.acceptance.observeSource(inspector(1), 1000000, 180000);
  assert.equal(exact.acceptance.getState().phase, 'OBSERVING');
  assert.equal(exact.acceptance.getState().failed, false);

  const late = setup();
  late.acceptance.checkProgress(180001);
  assert.equal(late.acceptance.getState().phase, 'FAILED');
  assert.equal(late.acceptance.getState().failureReasons[0].code, 'FIRST_SOURCE_DEADLINE_EXCEEDED');
});

test('source stall boundary is inclusive at 90000ms and fails above it', () => {
  const exact = setup();
  exact.acceptance.observeSource(inspector(1), 1000000, 0);
  exact.acceptance.checkProgress(90000);
  assert.equal(exact.acceptance.getState().failed, false);

  const late = setup();
  late.acceptance.observeSource(inspector(1), 1000000, 0);
  late.acceptance.checkProgress(90001);
  assert.equal(late.acceptance.getState().failureReasons[0].code, 'SOURCE_STALL_EXCEEDED');
});

test('duplicates do not reset source timing and increasing cycles do', () => {
  const { metrics, acceptance } = setup({ durationMs: 1000, pollIntervalMs: 100 });
  acceptance.observeSource(inspector(1), 1000000, 0);
  acceptance.observeSource(inspector(1), 1000100, 100);
  assert.equal(metrics.source.uniqueSourceCycles, 1);
  assert.equal(metrics.source.duplicateSourceObservations, 1);
  acceptance.observeSource(inspector(2), 1000200, 200);
  assert.equal(metrics.source.uniqueSourceCycles, 2);
  assert.equal(metrics.source.maximumObservedSourceStallMs, 200);
});

test('cycle and timestamp regressions fail immediately', () => {
  const cycleRegression = setup();
  cycleRegression.acceptance.observeSource(inspector(2), 1000000, 0);
  cycleRegression.acceptance.observeSource(inspector(1), 1000001, 1);
  assert.equal(cycleRegression.acceptance.getState().failureReasons[0].code, 'SOURCE_CYCLE_REGRESSION');

  const timestampRegression = setup();
  timestampRegression.acceptance.observeSource(inspector(1, '2026-01-01T00:00:02.000Z'), 1000000, 0);
  timestampRegression.acceptance.observeSource(inspector(2, '2026-01-01T00:00:01.000Z'), 1000001, 1);
  assert.equal(timestampRegression.acceptance.getState().failureReasons[0].code, 'SOURCE_TIMESTAMP_REGRESSION');
});

test('poll-loop gap boundaries use interval plus timeout plus tolerance', () => {
  const exact = setup({ durationMs: 1000, pollIntervalMs: 3000 });
  exact.acceptance.observePollBatchStart(0, 1000000);
  exact.acceptance.observePollBatchStart(13000, 1013000);
  assert.equal(exact.acceptance.getState().failed, false);

  const late = setup({ durationMs: 1000, pollIntervalMs: 3000 });
  late.acceptance.observePollBatchStart(0, 1000000);
  late.acceptance.observePollBatchStart(13001, 1013001);
  assert.equal(late.acceptance.getState().failureReasons[0].code, 'POLL_LOOP_GAP_EXCEEDED');
});

test('endpoint ratios use actual observation attempts, not ideal slots', () => {
  const { metrics, acceptance } = setup({ durationMs: 1000, pollIntervalMs: 100 });
  for (let i = 0; i < 10; i++) {
    recordEndpointObservation(metrics, 'inspector', i !== 0, i, 'observation');
  }
  metrics.health = {
    readinessDrops: 0,
    durabilityFailures: 0,
    riskStateFailures: 0,
    riskSyncFailures: 0,
    pipelineFailures: 0,
    pipelineErrorBaseline: 0,
    pipelineErrorFinal: 0,
    sequenceRegressions: 0,
  };
  acceptance.complete(1000, 1001000);
  const evaluation = calculateHardAcceptanceChecks([], { metrics });
  const check = evaluation.checks.find(item => item.name === 'inspector endpoint availability');
  assert.equal(check.observed, 9);
  assert.equal(check.pass, true);
});

test('minimum poll coverage is 170 for the default ten-minute contract', () => {
  const { metrics } = setup();
  assert.equal(metrics.polling.idealPollSlots, 200);
  assert.equal(metrics.polling.minimumPollAttempts, 170);
});

test('sixteen source cycles satisfy the locked default threshold while fifteen do not', () => {
  const passing = setup();
  for (let cycle = 1; cycle <= 16; cycle++) {
    passing.acceptance.observeSource(inspector(cycle), 1000000 + cycle, cycle === 1 ? 0 : cycle === 16 ? 510000 : (cycle - 1) * 30000);
  }
  passing.acceptance.complete(600000, 1600000);
  assert.equal(passing.metrics.source.uniqueSourceCycles, 16);
  assert.equal(passing.metrics.source.minimumRequiredSourceCycles, 16);
  assert.equal(passing.metrics.source.finalSourceStallMs, 90000);

  const failing = setup();
  for (let cycle = 1; cycle <= 15; cycle++) {
    failing.acceptance.observeSource(inspector(cycle), 1000000 + cycle, (cycle - 1) * 40000);
  }
  failing.acceptance.complete(600000, 1600000);
  assert.equal(failing.acceptance.getState().failureReasons[0].code, 'INSUFFICIENT_SOURCE_CYCLES');
});

test('readiness, durability, and risk failures are terminal and latched', () => {
  const readiness = setup({ durationMs: 1000, pollIntervalMs: 100 });
  processHealthResults({
    readinessResult: fulfilled({ status: 'not_ready', liveState: 'UNSAFE' }),
    statusResult: fulfilled(statusResponse()),
    metrics: readiness.metrics,
    acceptance: readiness.acceptance,
    phase: 'startup',
    wallTimestamp: 1000000,
    monotonicTimestamp: 0,
  });
  assert.equal(readiness.acceptance.getState().failureReasons[0].code, 'READINESS_DROP');

  const durability = setup({ durationMs: 1000, pollIntervalMs: 100 });
  processHealthResults({
    readinessResult: fulfilled({ status: 'ok', liveState: 'READY', durabilityHealthy: true }),
    statusResult: fulfilled(statusResponse({ durabilityHealthy: false })),
    metrics: durability.metrics,
    acceptance: durability.acceptance,
    phase: 'startup',
    wallTimestamp: 1000000,
    monotonicTimestamp: 0,
  });
  assert.equal(durability.acceptance.getState().failureReasons[0].code, 'DURABILITY_UNHEALTHY');

  const risk = setup({ durationMs: 1000, pollIntervalMs: 100 });
  processHealthResults({
    readinessResult: fulfilled({ status: 'ok', liveState: 'READY', durabilityHealthy: true }),
    statusResult: fulfilled(statusResponse({ riskStateHealthy: false })),
    metrics: risk.metrics,
    acceptance: risk.acceptance,
    phase: 'startup',
    wallTimestamp: 1000000,
    monotonicTimestamp: 0,
  });
  assert.equal(risk.acceptance.getState().failureReasons[0].code, 'RISK_STATE_UNHEALTHY');
  assert.equal(risk.metrics.polling.endpointStats.status.successes, 0);
});

test('endpoint outage is allowed at 30000ms and fails above it', () => {
  const context = setup({ durationMs: 1000, pollIntervalMs: 100 });
  const healthyStatus = fulfilled(statusResponse());
  processHealthResults({ readinessResult: rejected(), statusResult: healthyStatus, metrics: context.metrics, acceptance: context.acceptance, phase: 'observation', wallTimestamp: 1000000, monotonicTimestamp: 0 });
  processHealthResults({ readinessResult: rejected(), statusResult: healthyStatus, metrics: context.metrics, acceptance: context.acceptance, phase: 'observation', wallTimestamp: 1000030000, monotonicTimestamp: 30000 });
  assert.equal(context.acceptance.getState().failed, false);
  processHealthResults({ readinessResult: rejected(), statusResult: healthyStatus, metrics: context.metrics, acceptance: context.acceptance, phase: 'observation', wallTimestamp: 1000030001, monotonicTimestamp: 30001 });
  assert.equal(context.acceptance.getState().failureReasons[0].code, 'ENDPOINT_OUTAGE_EXCEEDED');
});

test('pipeline error, run-status, and mutation-sequence failures are terminal', () => {
  const errors = setup({ durationMs: 1000, pollIntervalMs: 100 });
  processHealthResults({ readinessResult: fulfilled({ status: 'ok', liveState: 'READY', durabilityHealthy: true }), statusResult: fulfilled(statusResponse()), metrics: errors.metrics, acceptance: errors.acceptance, phase: 'startup', wallTimestamp: 1000000, monotonicTimestamp: 0 });
  processHealthResults({ readinessResult: fulfilled({ status: 'ok', liveState: 'READY', durabilityHealthy: true }), statusResult: fulfilled(statusResponse({ pipeline: { ...statusResponse().pipeline, pipelineErrors: 1 } })), metrics: errors.metrics, acceptance: errors.acceptance, phase: 'observation', wallTimestamp: 1000001, monotonicTimestamp: 1 });
  assert.equal(errors.acceptance.getState().failureReasons[0].code, 'PIPELINE_ERRORS_INCREASED');

  const failedRun = setup({ durationMs: 1000, pollIntervalMs: 100 });
  processHealthResults({ readinessResult: fulfilled({ status: 'ok', liveState: 'READY', durabilityHealthy: true }), statusResult: fulfilled(statusResponse({ pipeline: { ...statusResponse().pipeline, lastRunStatus: { status: 'FAILED', failure: null } } })), metrics: failedRun.metrics, acceptance: failedRun.acceptance, phase: 'startup', wallTimestamp: 1000000, monotonicTimestamp: 0 });
  assert.equal(failedRun.acceptance.getState().failureReasons[0].code, 'PIPELINE_RUN_FAILED');

  const sequence = setup({ durationMs: 1000, pollIntervalMs: 100 });
  processHealthResults({ readinessResult: fulfilled({ status: 'ok', liveState: 'READY', durabilityHealthy: true }), statusResult: fulfilled(statusResponse()), metrics: sequence.metrics, acceptance: sequence.acceptance, phase: 'startup', wallTimestamp: 1000000, monotonicTimestamp: 0 });
  processHealthResults({ readinessResult: fulfilled({ status: 'ok', liveState: 'READY', durabilityHealthy: true }), statusResult: fulfilled(statusResponse({ mutationSequence: 0 })), metrics: sequence.metrics, acceptance: sequence.acceptance, phase: 'observation', wallTimestamp: 1000001, monotonicTimestamp: 1 });
  assert.equal(sequence.acceptance.getState().failureReasons[0].code, 'MUTATION_SEQUENCE_REGRESSION');

  const riskSync = setup({ durationMs: 1000, pollIntervalMs: 100 });
  processHealthResults({
    readinessResult: fulfilled({ status: 'ok', liveState: 'READY', durabilityHealthy: true }),
    statusResult: fulfilled(statusResponse({ pipeline: { ...statusResponse().pipeline, riskSyncFailure: true } })),
    metrics: riskSync.metrics,
    acceptance: riskSync.acceptance,
    phase: 'startup',
    wallTimestamp: 1000000,
    monotonicTimestamp: 0,
  });
  assert.equal(riskSync.acceptance.getState().failureReasons[0].code, 'RISK_SYNC_FAILURE');
  assert.equal(riskSync.metrics.polling.endpointStats.status.successes, 0);
});

test('hard acceptance remains failed after later healthy samples', () => {
  const context = healthyRun();
  context.acceptance.fail('POLL_LOOP_STALL', 'simulated hard failure', 100);
  processHealthResults({
    readinessResult: fulfilled({ status: 'ok', liveState: 'READY', durabilityHealthy: true }),
    statusResult: fulfilled(statusResponse()),
    metrics: context.metrics,
    acceptance: context.acceptance,
    phase: 'observation',
    wallTimestamp: 1000100,
    monotonicTimestamp: 100,
  });
  const evaluation = calculateHardAcceptanceChecks([], { metrics: context.metrics });
  assert.equal(context.acceptance.getState().phase, 'FAILED');
  assert.equal(context.acceptance.getState().failed, true);
  assert.equal(evaluation.allPass, false);
});

test('malformed readiness and status responses fail contract checks without endpoint successes', () => {
  const readiness = setup({ durationMs: 1000, pollIntervalMs: 100 });
  processHealthResults({
    readinessResult: fulfilled({ malformed: true }),
    statusResult: fulfilled(statusResponse()),
    metrics: readiness.metrics,
    acceptance: readiness.acceptance,
    phase: 'observation',
    wallTimestamp: 1000000,
    monotonicTimestamp: 0,
  });
  assert.equal(readiness.metrics.polling.endpointStats.readiness.successes, 0);
  assert.equal(readiness.metrics.polling.endpointStats.readiness.failures, 1);
  assert.equal(readiness.acceptance.getState().failureReasons[0].code, 'READINESS_CONTRACT_INVALID');

  const status = setup({ durationMs: 1000, pollIntervalMs: 100 });
  processHealthResults({
    readinessResult: fulfilled({ status: 'ok', liveState: 'READY', durabilityHealthy: true }),
    statusResult: fulfilled({ malformed: true }),
    metrics: status.metrics,
    acceptance: status.acceptance,
    phase: 'observation',
    wallTimestamp: 1000000,
    monotonicTimestamp: 0,
  });
  assert.equal(status.metrics.polling.endpointStats.status.successes, 0);
  assert.equal(status.metrics.polling.endpointStats.status.failures, 1);
  assert.equal(status.acceptance.getState().failureReasons[0].code, 'STATUS_CONTRACT_INVALID');
});

test('unsafe HTTP 503 readiness is a hard health failure, not endpoint success', () => {
  const context = setup({ durationMs: 1000, pollIntervalMs: 100 });
  processHealthResults({
    readinessResult: fulfilled({
      statusCode: 503,
      body: { status: 'not_ready', liveState: 'UNSAFE', durabilityHealthy: false },
    }),
    statusResult: fulfilled(statusResponse()),
    metrics: context.metrics,
    acceptance: context.acceptance,
    phase: 'observation',
    wallTimestamp: 1000000,
    monotonicTimestamp: 0,
  });
  assert.equal(context.metrics.polling.endpointStats.readiness.successes, 0);
  assert.equal(context.metrics.polling.endpointStats.readiness.failures, 1);
  assert.equal(context.acceptance.getState().failureReasons[0].code, 'READINESS_DROP');
});

test('healthy 16, 18, 19, and 20 cycle runs pass hard acceptance', () => {
  for (const sourceCycles of [16, 18, 19, 20]) {
    const context = healthyRun(sourceCycles);
    assert.equal(calculateHardAcceptanceChecks([], { metrics: context.metrics }).allPass, true);
  }
});

test('startup time does not reduce a full observation window', () => {
  const context = healthyRun(16, 170, 170, 179999);
  assert.equal(context.metrics.runtime.startupElapsedMs, 179999);
  assert.equal(context.metrics.runtime.observationElapsedMs, 600000);
  assert.equal(context.metrics.runtime.totalElapsedMs, 779999);
  assert.equal(calculateHardAcceptanceChecks([], { metrics: context.metrics }).allPass, true);
});

test('endpoint success ratio and poll coverage boundaries are enforced', () => {
  const exactRatio = healthyRun(16, 200, 180);
  assert.equal(calculateHardAcceptanceChecks([], { metrics: exactRatio.metrics }).allPass, true);

  const belowRatio = healthyRun(16, 200, 179);
  assert.equal(calculateHardAcceptanceChecks([], { metrics: belowRatio.metrics }).allPass, false);
  assert.equal(belowRatio.acceptance.getState().failureReasons[0].code, 'ENDPOINT_SUCCESS_RATIO');

  const exactCoverage = healthyRun(16, 170);
  assert.equal(calculateHardAcceptanceChecks([], { metrics: exactCoverage.metrics }).allPass, true);

  const extendedCoverage = healthyRun(16, 180);
  assert.equal(calculateHardAcceptanceChecks([], { metrics: extendedCoverage.metrics }).allPass, true);

  const belowCoverage = healthyRun(16, 169);
  assert.equal(calculateHardAcceptanceChecks([], { metrics: belowCoverage.metrics }).allPass, false);
  assert.equal(belowCoverage.acceptance.getState().failureReasons[0].code, 'POLL_COVERAGE');
});

test('production CLI duration and interval bounds accept endpoints and reject outside values', () => {
  assert.deepEqual(parseArgs(['node', 'verify-pipeline.js', '--duration', '10', '--interval', '1']), { duration: 10, interval: 1 });
  assert.deepEqual(parseArgs(['node', 'verify-pipeline.js', '--duration', '1440', '--interval', '30']), { duration: 1440, interval: 30 });
  for (const args of [
    ['--duration', '9'],
    ['--duration', '1441'],
    ['--interval', '0'],
    ['--interval', '31'],
  ]) {
    assert.throws(() => parseArgs(['node', 'verify-pipeline.js', ...args]));
  }
});
