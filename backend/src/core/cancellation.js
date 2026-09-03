function createAbortError(reason) {
  const message = reason instanceof Error && reason.message
    ? reason.message
    : 'The operation was aborted';
  const error = new Error(message);
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  if (reason !== undefined) error.cause = reason;
  return error;
}

function isCancellation(error, signal) {
  if (signal?.aborted) return true;
  return error?.name === 'AbortError'
    || error?.code === 'ABORT_ERR'
    || error?.type === 'aborted';
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw createAbortError(signal.reason);
}

module.exports = { throwIfAborted, isCancellation, createAbortError };
