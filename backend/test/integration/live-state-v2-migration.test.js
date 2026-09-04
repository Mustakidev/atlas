const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const { API_KEY, createLiveProcess } = require('../helpers/live-process');

async function seedV1State() {
  const processHarness = await createLiveProcess();
  await processHarness.start({ marketMode: 'open' });
  await processHarness.waitForLiveState('UNINITIALIZED');
  const initialize = await processHarness.request('/api/live-state/initialize', {
    method: 'POST',
    headers: { 'x-api-key': API_KEY },
    body: {},
  });
  assert.equal(initialize.statusCode, 201);
  await processHarness.waitForReady();
  const opened = await processHarness.waitForState(candidate => candidate.mutationSequence === 1);
  const close = await processHarness.request('/api/paper-trades/close', {
    method: 'POST',
    headers: { 'x-api-key': API_KEY },
    body: { tradeId: opened.paperTrading.trades[0].tradeId },
  });
  assert.equal(close.statusCode, 200);
  const closed = await processHarness.waitForState(candidate => candidate.mutationSequence === 2);
  await processHarness.stopGracefully();

  const legacy = {
    ...closed,
    schemaVersion: 1,
    paperTrading: { ...closed.paperTrading },
  };
  delete legacy.paperTrading.lifetimeSummary;
  await fs.promises.writeFile(processHarness.statePath, JSON.stringify(legacy));
  return { processHarness, legacy };
}

test('startup migrates V1 before restore and creates certified V2 state', async () => {
  const { processHarness, legacy } = await seedV1State();
  try {
    await processHarness.start({ marketMode: 'idle' });
    await processHarness.waitForReady();
    const migrated = JSON.parse(await fs.promises.readFile(processHarness.statePath, 'utf8'));
    assert.equal(migrated.schemaVersion, 2);
    assert.equal(migrated.mutationSequence, legacy.mutationSequence);
    assert.equal(migrated.configFingerprint, legacy.configFingerprint);
    assert.equal(migrated.paperTrading.lifetimeSummary.totalClosedTrades, 1);
    assert.deepEqual(migrated.paperTrading.closedTrades.map(trade => trade.tradeId), ['PT-1']);
  } finally {
    await processHarness.dispose();
  }
});

test('certified V1 migration survives an abrupt death before activation', async () => {
  const { processHarness } = await seedV1State();
  try {
    await processHarness.start({ mode: 'init-after-write', marketMode: 'idle' });
    await processHarness.waitForBarrier(processHarness.markerPath);
    const migrated = JSON.parse(await fs.promises.readFile(processHarness.statePath, 'utf8'));
    assert.equal(migrated.schemaVersion, 2);
    assert.equal(migrated.paperTrading.lifetimeSummary.totalClosedTrades, 1);
    await processHarness.killAbruptly();

    await processHarness.start({ marketMode: 'idle' });
    await processHarness.waitForReady();
    assert.deepEqual(JSON.parse(await fs.promises.readFile(processHarness.statePath, 'utf8')), migrated);
  } finally {
    await processHarness.dispose();
  }
});
