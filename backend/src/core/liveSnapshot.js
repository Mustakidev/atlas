function registerLiveSnapshotHandler({
  eventBus,
  history,
  analyzer,
  signalHistoryEngine,
  executionPipeline,
  commitCoordinator,
  candleEngine,
  logger,
}) {
  function assertDurablePipelineCompletion() {
    if (!commitCoordinator || !executionPipeline?.getLastRunStatus) return;

    const status = executionPipeline.getLastRunStatus();
    const failure = status?.failure;
    const coupledFailure = status?.status === 'FAILED'
      && failure
      && typeof failure.engine === 'string'
      && ['LIFECYCLE_ENGINE_FAILURE', 'RISK_STATE_SYNC_FAILURE', 'EXECUTION_ENGINE_FAILURE'].includes(failure.code);

    if (coupledFailure) {
      const error = new Error('Live durable operation failed before commit completion');
      error.code = failure.code;
      error.cause = failure.error ? new Error(failure.error) : null;
      throw error;
    }
  }

  const processSnapshot = (snapshot, transition) => {
    analyzer.analyze(history);
    signalHistoryEngine.record();

    const lifecycleCandle = transition?.finalized?.['1h'];
    if (lifecycleCandle) {
      executionPipeline.run(snapshot, { lifecycleCandle });
    } else {
      executionPipeline.run(snapshot);
    }
    assertDurablePipelineCompletion();
  };

  const processAdmittedSnapshot = (snapshot, transition) => {
    let effectiveTransition = transition;
    if (effectiveTransition === undefined && candleEngine) {
      history.add(snapshot);
      effectiveTransition = candleEngine.ingest(snapshot);
    }
    return processSnapshot(snapshot, effectiveTransition);
  };

  const handler = (snapshot, transition) => {
    if (!commitCoordinator) return processAdmittedSnapshot(snapshot, transition);
    const operation = commitCoordinator.runMutation({
      name: 'live-snapshot',
      mutate: () => processAdmittedSnapshot(snapshot, transition),
    });
    return operation.catch(error => {
      if (error?.code !== 'STATE_QUEUE_FULL') throw error;
      logger?.warn?.('ResourceAdmission', 'Live snapshot skipped because commit capacity is full', {
        code: error.code,
      });
      return Object.freeze({ status: 'SKIPPED', code: error.code });
    });
  };

  eventBus.on('market:snapshot', handler);
  return handler;
}

module.exports = { registerLiveSnapshotHandler };
