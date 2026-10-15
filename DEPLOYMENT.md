# Deployment Contract

Atlas production runtime currently supports exactly one active application process per live-state/audit-state authority. Running multiple active Atlas workers against the same state or audit resources is unsupported until multi-process hardening is implemented.

## Market data

The default provider (`MARKET_DATA_PROVIDER=binance`) reads Binance spot klines from the public market-data host (`BINANCE_BASE_URL`, no API key). Startup seeds every timeframe from its native Binance interval and seeds `MAX_HISTORY` closed 1-minute bars into the analyzer history; each live cycle then ingests only the 1-minute bars closed since the last ingested bar, so a missed poll is back-filled on the next one. Keep `MAX_HISTORY` at 1440 or more so the 24H analyzer window is fully covered.

## Upgrading saved live state

The live-state file is bound to a fingerprint of the strategy revision and trading policy (thresholds, risk policy, `MAX_OPEN_POSITIONS`, `MAX_LEVERAGE`, `PAPER_FEE_PCT`, `PAPER_SLIPPAGE_PCT`). After an upgrade that changes the strategy revision, or after changing any of those settings, startup refuses the old file with `STATE_CONTEXT_MISMATCH` instead of mixing results produced under different rules. Stop Atlas, move `backend/runtime-data/live-execution-state.json` (or the path in `ATLAS_LIVE_STATE_FILE_PATH`) to an archive location, start Atlas, and initialize a fresh paper account from the dashboard.

## Audit log recovery

If the durable audit log cannot certify a write (I/O failure, corrupt tail, rotation failure), Atlas writes `<ATLAS_LOG_FILE_PATH>.unsafe` and refuses operations that require a certified audit record, including operator login. A full write queue no longer causes this. To recover after fixing the underlying storage problem: stop Atlas, inspect and archive the log directory, remove the `.unsafe` marker, and restart.
