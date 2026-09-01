const crypto = require('node:crypto');

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SALT_BYTES = 16;
const DERIVED_BYTES = 32;
const SCRYPT_MAXMEM = 32 * 1024 * 1024;
const FORMAT = `scrypt$N=${SCRYPT_N}$r=${SCRYPT_R}$p=${SCRYPT_P}`;

function decodeBase64Url(value, expectedBytes) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new TypeError('Invalid password verifier encoding');
  }

  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length !== expectedBytes || decoded.toString('base64url') !== value) {
    throw new TypeError('Invalid password verifier encoding');
  }
  return decoded;
}

function parsePasswordVerifier(encoded) {
  if (typeof encoded !== 'string') throw new TypeError('Invalid password verifier');

  const parts = encoded.split('$');
  if (parts.length !== 6 || parts.slice(0, 4).join('$') !== FORMAT) {
    throw new TypeError('Invalid password verifier');
  }

  return Object.freeze({
    salt: decodeBase64Url(parts[4], SALT_BYTES),
    derived: decodeBase64Url(parts[5], DERIVED_BYTES),
  });
}

function isValidPasswordVerifier(encoded) {
  try {
    parsePasswordVerifier(encoded);
    return true;
  } catch {
    return false;
  }
}

function verifyPassword(password, encoded) {
  if (typeof password !== 'string') return Promise.resolve(false);

  const verifier = parsePasswordVerifier(encoded);
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password,
      verifier.salt,
      DERIVED_BYTES,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM },
      (error, derived) => {
        if (error) {
          reject(new Error('Password verification failed'));
          return;
        }
        resolve(crypto.timingSafeEqual(derived, verifier.derived));
      },
    );
  });
}

module.exports = {
  DERIVED_BYTES,
  FORMAT,
  SALT_BYTES,
  isValidPasswordVerifier,
  parsePasswordVerifier,
  verifyPassword,
};
