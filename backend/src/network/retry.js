const {
  throwIfAborted,
  isCancellation,
  createAbortError,
} = require('../core/cancellation');

const MAX_RETRY_BUDGET_MS = 180000;

class RetryHandler {
  constructor(config, logger, { now = () => Date.now() } = {}) {
    this.logger = logger;
    this.maxRetries = config.get('MAX_RETRIES');
    this.initialBackoff = config.get('INITIAL_BACKOFF');
    this.requestTimeout = config.get('REQUEST_TIMEOUT');
    this.now = now;
    this.retryBudgetMs = this._calculateBudget();
  }

  async execute(fn, { signal } = {}) {
    let lastError;
    const startedAt = this.now();

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
        if (!this._fitsRetryBudget(startedAt, delay)) break;
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
      if (retryAfter !== undefined && retryAfter !== null && retryAfter !== '') {
        const retryAfterMs = Number(retryAfter) * 1000;
        if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
          base = Math.max(base, retryAfterMs);
        } else {
          return Infinity;
        }
      } else {
        base *= 2;
      }
    }

    const jitter = base * 0.2 * Math.random();
    return Math.floor(base + jitter);
  }

  _calculateBudget() {
    if (!Number.isSafeInteger(this.requestTimeout) || this.requestTimeout <= 0
      || !Number.isSafeInteger(this.maxRetries) || this.maxRetries < 0
      || !Number.isSafeInteger(this.initialBackoff) || this.initialBackoff < 0) {
      return Infinity;
    }

    return (this.maxRetries + 1) * this.requestTimeout
      + 2.4 * this.initialBackoff * (2 ** this.maxRetries - 1);
  }

  _fitsRetryBudget(startedAt, delay) {
    if (!Number.isFinite(this.retryBudgetMs)) return true;
    if (!Number.isFinite(delay) || delay < 0) return false;

    const elapsed = Math.max(0, this.now() - startedAt);
    const remaining = this.retryBudgetMs - elapsed;
    return remaining >= this.requestTimeout + delay;
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

module.exports = { MAX_RETRY_BUDGET_MS, RetryHandler };
