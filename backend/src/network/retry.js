class RetryHandler {
  constructor(config, logger) {
    this.logger = logger;
    this.maxRetries = config.get('MAX_RETRIES');
    this.initialBackoff = config.get('INITIAL_BACKOFF');
  }

  async execute(fn) {
    let lastError;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;

        if (attempt === this.maxRetries) break;

        const delay = this.calculateDelay(attempt, err);
        this.logger.warn('RetryHandler', `Attempt ${attempt + 1} failed, retrying`, {
          error: err.message,
          status: err.status,
          delayMs: delay,
          attempt: attempt + 1,
          maxRetries: this.maxRetries,
        });

        await this.sleep(delay);
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

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

module.exports = { RetryHandler };
