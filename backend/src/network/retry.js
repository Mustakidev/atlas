const {
  throwIfAborted,
  isCancellation,
  createAbortError,
} = require('../core/cancellation');

class RetryHandler {
  constructor(config, logger) {
    this.logger = logger;
    this.maxRetries = config.get('MAX_RETRIES');
    this.initialBackoff = config.get('INITIAL_BACKOFF');
  }

  async execute(fn, { signal } = {}) {
    let lastError;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      throwIfAborted(signal);
      try {
        const result = await fn();
        throwIfAborted(signal);
        return result;
      } catch (err) {
        lastError = err;

        if (isCancellation(err, signal)) throw err;
        if (attempt === this.maxRetries) break;

        throwIfAborted(signal);
        const delay = this.calculateDelay(attempt, err);
        this.logger.warn('RetryHandler', `Attempt ${attempt + 1} failed, retrying`, {
          error: err.message,
          status: err.status,
          delayMs: delay,
          attempt: attempt + 1,
          maxRetries: this.maxRetries,
        });

        await this.sleep(delay, signal);
        throwIfAborted(signal);
      }
    }

    this.logger.error('RetryHandler', 'All retries exhausted', {
      error: lastError.message,
      attempts: this.maxRetries + 1,
    });
    throw lastError;
  }

  calculateDelay(attempt, err) {
    let base = this.initialBackoff * Math.pow(2, attempt);

    if (err.status === 429) {
      const retryAfter = err.headers?.['retry-after'];
      if (retryAfter) {
        base = Math.max(base, Number(retryAfter) * 1000);
      } else {
        base *= 2;
      }
    }

    const jitter = base * 0.2 * Math.random();
    return Math.floor(base + jitter);
  }

  sleep(ms, signal) {
    if (signal?.aborted) return Promise.reject(createAbortError(signal.reason));

    return new Promise((resolve, reject) => {
      let settled = false;
      let timer;

      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
      };

      const settle = (settler, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        settler(value);
      };

      const onAbort = () => settle(reject, createAbortError(signal.reason));

      timer = setTimeout(() => settle(resolve), ms);
      signal?.addEventListener?.('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }
}

module.exports = { RetryHandler };
