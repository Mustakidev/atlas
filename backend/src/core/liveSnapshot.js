function registerLiveSnapshotHandler({
  eventBus,
  history,
  analyzer,
  signalHistoryEngine,
  executionPipeline,
  commitCoordinator,
}) {
  const processSnapshot = (snapshot, transition) => {
    analyzer.analyze(history);
    signalHistoryEngine.record();

    const lifecycleCandle = transition?.finalized?.['1h'];
    if (lifecycleCandle) {
      executionPipeline.run(snapshot, { lifecycleCandle });
    } else {
      executionPipeline.run(snapshot);
    }
  };

  const handler = (snapshot, transition) => {
    if (!commitCoordinator) return processSnapshot(snapshot, transition);
    return commitCoordinator.runMutation({
      name: 'live-snapshot',
      mutate: () => processSnapshot(snapshot, transition),
    });
  };

  eventBus.on('market:snapshot', handler);
  return handler;
}

module.exports = { registerLiveSnapshotHandler };
