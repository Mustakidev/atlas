const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  LiveStateError,
  deserializeLiveExecutionState,
  serializeLiveExecutionState,
} = require('./liveExecutionStateSchema');

const DEFAULT_STATE_FILE_PATH = path.resolve(__dirname, '../../runtime-data/live-execution-state.json');
const TEMP_SUFFIX_PATTERN = /^[0-9]+\.[0-9a-f]+\.tmp$/;

function assertAbsoluteFilePath(filePath) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
    throw new TypeError('filePath must be an absolute path');
  }
  return filePath;
}

function getFsApi(fsAdapter) {
  const api = fsAdapter?.promises || fsAdapter;
  if (!api || typeof api.readFile !== 'function' || typeof api.open !== 'function'
    || typeof api.rename !== 'function' || typeof api.mkdir !== 'function'
    || typeof api.readdir !== 'function' || typeof api.unlink !== 'function') {
    throw new TypeError('fsAdapter must expose the required promise filesystem methods');
  }
  return api;
}

function getFsConstants(fsAdapter) {
  return fsAdapter?.constants || fs.constants;
}

function makeStoreError(code, message, cause, phase, durability = null, recovery = null) {
  if (cause instanceof LiveStateError && code === cause.code) return cause;
  return new LiveStateError(code, message, { cause, phase, durability, recovery });
}

function isNotFound(error) {
  return error?.code === 'ENOENT';
}

function tempPatternFor(basename) {
  const escaped = basename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\.${escaped}\\.${TEMP_SUFFIX_PATTERN.source.slice(1, -1)}$`);
}

async function matchingTempPresent(api, parent, basename) {
  let entries;
  try {
    entries = await api.readdir(parent);
  } catch (error) {
    if (isNotFound(error)) return false;
    throw makeStoreError(
      'STATE_RECOVERY_FAILED',
      'Unable to inspect live execution state recovery files',
      error,
      'recovery-scan',
    );
  }
  const pattern = tempPatternFor(basename);
  return entries.some(entry => typeof entry === 'string' && pattern.test(entry));
}

function createAtomicJsonStateStore({ filePath = DEFAULT_STATE_FILE_PATH, fsAdapter = fs.promises, now = () => Date.now() } = {}) {
  const primaryPath = assertAbsoluteFilePath(filePath);
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  const api = getFsApi(fsAdapter);
  const constants = getFsConstants(fsAdapter);
  const parent = path.dirname(primaryPath);
  const basename = path.basename(primaryPath);
  let writeActive = false;

  function contextWithNow(expectedContext) {
    if (!expectedContext || typeof expectedContext !== 'object' || Array.isArray(expectedContext)) {
      throw new TypeError('expectedContext must be an object');
    }
    return Object.hasOwn(expectedContext, 'nowMs')
      ? expectedContext
      : { ...expectedContext, nowMs: now() };
  }

  async function read(expectedContext) {
    const context = contextWithNow(expectedContext);
    let bytes;
    try {
      bytes = await api.readFile(primaryPath);
    } catch (error) {
      if (!isNotFound(error)) {
        throw makeStoreError(
          'STATE_RECOVERY_FAILED',
          'Unable to read live execution state',
          error,
          'read',
        );
      }
      const tempPresent = await matchingTempPresent(api, parent, basename);
      if (tempPresent) {
        throw makeStoreError(
          'STATE_RECOVERY_FAILED',
          'Primary live execution state is missing while a recovery temp exists',
          null,
          'recovery',
          null,
          { tempPresent: true },
        );
      }
      return { status: 'NOT_FOUND' };
    }

    let state;
    try {
      state = deserializeLiveExecutionState(bytes, context);
    } catch (cause) {
      const tempPresent = await matchingTempPresent(api, parent, basename);
      if (tempPresent) {
        throw makeStoreError(
          'STATE_RECOVERY_FAILED',
          'Primary live execution state is invalid while a recovery temp exists',
          cause,
          'recovery',
          null,
          { tempPresent: true },
        );
      }
      throw cause;
    }

    const tempPresent = await matchingTempPresent(api, parent, basename);
    return { status: 'VALID', state, recovery: { tempPresent } };
  }

  async function write(snapshot, expectedContext) {
    if (writeActive) {
      throw new LiveStateError(
        'STATE_WRITE_IN_PROGRESS',
        'A live execution state write is already in progress',
        { phase: 'guard' },
      );
    }
    writeActive = true;

    let tempPath = null;
    let renamed = false;
    let tempHandle = null;
    let directoryHandle = null;
    let phase = 'serialize';

    try {
      const context = contextWithNow(expectedContext);
      const bytes = serializeLiveExecutionState(snapshot, context);

      phase = 'mkdir';
      await api.mkdir(parent, { recursive: true });

      const random = crypto.randomBytes(16).toString('hex');
      tempPath = path.join(parent, `.${basename}.${process.pid}.${random}.tmp`);

      phase = 'temp-open';
      tempHandle = await api.open(tempPath, 'wx', 0o600);
      phase = 'temp-write';
      await tempHandle.writeFile(bytes);
      phase = 'temp-fsync';
      await tempHandle.sync();
      phase = 'temp-close';
      await tempHandle.close();
      tempHandle = null;

      phase = 'rename';
      await api.rename(tempPath, primaryPath);
      renamed = true;
      tempPath = null;

      if (!Number.isInteger(constants.O_RDONLY) || !Number.isInteger(constants.O_DIRECTORY)) {
        throw new Error('Directory fsync flags are unavailable');
      }
      const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY;
      phase = 'directory-open';
      directoryHandle = await api.open(parent, directoryFlags);
      phase = 'directory-fsync';
      await directoryHandle.sync();
      phase = 'directory-close';
      await directoryHandle.close();
      directoryHandle = null;

      return { status: 'WRITTEN' };
    } catch (cause) {
      if (phase === 'serialize' && cause instanceof LiveStateError
        && ['STATE_VALIDATION_FAILED', 'STATE_SCHEMA_UNSUPPORTED', 'STATE_CONTEXT_MISMATCH'].includes(cause.code)) {
        throw cause;
      }
      if (tempHandle) {
        try {
          await tempHandle.close();
        } catch {
          // Preserve the original storage failure.
        }
      }
      if (directoryHandle) {
        try {
          await directoryHandle.close();
        } catch {
          // Preserve the original directory durability failure.
        }
      }
      if (!renamed && tempPath) {
        try {
          await api.unlink(tempPath);
        } catch {
          // Best-effort cleanup must not hide the original failure.
        }
      }

      const durability = renamed ? 'uncertified' : null;
      const code = phase === 'rename'
        ? 'STATE_RENAME_FAILED'
        : phase.startsWith('directory-') || phase === 'temp-fsync'
          ? 'STATE_FSYNC_FAILED'
          : 'STATE_WRITE_FAILED';
      throw makeStoreError(
        code,
        renamed
          ? 'Live execution state durability could not be certified after rename'
          : 'Live execution state atomic write failed',
        cause,
        phase,
        durability,
      );
    } finally {
      writeActive = false;
    }
  }

  return Object.freeze({ read, write });
}

module.exports = {
  DEFAULT_STATE_FILE_PATH,
  createAtomicJsonStateStore,
};
