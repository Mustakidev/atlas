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

  // Exchange-bar mode: each closed 1m bar becomes one analyzer observation and one
  // exact candle update; the pipeline then checks trades against those bars and
  // the current price. Bars already ingested are ignored by the candle engine.
  const processBarSnapshot = snapshot => {
    const ingestedBars = [];
    for (const bar of snapshot.bars) {
      const result = candleEngine.ingestBar(bar);
      if (!result.ingested) continue;
      ingestedBars.push(result.bar);
      history.add({
        symbol: snapshot.symbol,
        exchange: snapshot.exchange,
        price: result.bar.close,
        volume: snapshot.volume,
        change24h: snapshot.change24h,
        timestamp: new Date(result.bar.openTime + 60_000).toISOString(),
      });
    }
    candleEngine.setFormingBar(snapshot.forming || null);

    analyzer.analyze(history);
    signalHistoryEngine.record();
    executionPipeline.run(
      { symbol: snapshot.symbol, price: snapshot.price, timestamp: snapshot.timestamp },
      { lifecycleCandles: ingestedBars },
    );
    assertDurablePipelineCompletion();
  };

  const processAdmittedSnapshot = (snapshot, transition) => {
    if (transition === undefined && candleEngine && Array.isArray(snapshot?.bars)) {
      return processBarSnapshot(snapshot);
    }
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
