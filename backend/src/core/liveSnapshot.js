function registerLiveSnapshotHandler({
  eventBus,
  history,
  analyzer,
  signalHistoryEngine,
  executionPipeline,
}) {
  const handler = (snapshot, transition) => {
    analyzer.analyze(history);
    signalHistoryEngine.record();

    const lifecycleCandle = transition?.finalized?.['1h'];
    if (lifecycleCandle) {
      executionPipeline.run(snapshot, { lifecycleCandle });
    } else {
      executionPipeline.run(snapshot);
    }
  };

  eventBus.on('market:snapshot', handler);
  return handler;
}

module.exports = { registerLiveSnapshotHandler };
