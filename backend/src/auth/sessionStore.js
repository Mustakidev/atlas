const crypto = require('node:crypto');

const SESSION_TOKEN_BYTES = 32;
const SESSION_TOKEN_LENGTH = 43;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function digestToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest();
}

function sameDigest(left, right) {
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

class SingleOperatorSessionStore {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.session = null;
  }

  issue() {
    const token = crypto.randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
    const now = this.now();
    this.session = {
      tokenDigest: digestToken(token),
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
      principal: 'operator',
    };
    return { token, expiresAt: this.session.expiresAt };
  }

  lookup(token) {
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token) || !this.session) return null;

    if (this.session.expiresAt <= this.now()) {
      this.session = null;
      return null;
    }

    if (!sameDigest(digestToken(token), this.session.tokenDigest)) return null;
    return Object.freeze({ type: 'session', principal: this.session.principal });
  }

  invalidate(token) {
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token) || !this.session) return;
    if (sameDigest(digestToken(token), this.session.tokenDigest)) this.session = null;
  }
}

module.exports = { SESSION_TTL_MS, SESSION_TOKEN_LENGTH, SingleOperatorSessionStore };
