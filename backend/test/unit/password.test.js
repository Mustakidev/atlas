const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const {
  DERIVED_BYTES,
  FORMAT,
  SALT_BYTES,
  isValidPasswordVerifier,
  parsePasswordVerifier,
  verifyPassword,
} = require('../../src/auth/password');

const PASSWORD = 'correct horse battery staple';
const SALT = Buffer.from('0123456789abcdef');

function verifier(password = PASSWORD, salt = SALT) {
  const derived = crypto.scryptSync(password, salt, DERIVED_BYTES, {
    N: 16_384,
    r: 8,
    p: 1,
    maxmem: 32 * 1024 * 1024,
  });
  return `${FORMAT}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

test('PH-2B verifier uses the fixed scrypt parameter tuple', () => {
  assert.equal(FORMAT, 'scrypt$N=16384$r=8$p=1');
  assert.equal(SALT_BYTES, 16);
  assert.equal(DERIVED_BYTES, 32);
  assert.equal(isValidPasswordVerifier(verifier()), true);
});

test('valid password verifies successfully', async () => {
  assert.equal(await verifyPassword(PASSWORD, verifier()), true);
});

test('incorrect password verifies unsuccessfully', async () => {
  assert.equal(await verifyPassword('not the configured password', verifier()), false);
});

test('password verifier parser returns only the expected binary fields', () => {
  const parsed = parsePasswordVerifier(verifier());
  assert.deepEqual(Object.keys(parsed), ['salt', 'derived']);
  assert.equal(parsed.salt.length, SALT_BYTES);
  assert.equal(parsed.derived.length, DERIVED_BYTES);
});

test('unsupported scrypt parameters are rejected', () => {
  const unsupported = verifier().replace('N=16384', 'N=32768');
  assert.equal(isValidPasswordVerifier(unsupported), false);
});

test('bad salt encoding or length is rejected', () => {
  const badEncoding = `${FORMAT}$not-base64!$${'a'.repeat(43)}`;
  const badLength = `${FORMAT}$${Buffer.from('short').toString('base64url')}$${'a'.repeat(43)}`;
  assert.equal(isValidPasswordVerifier(badEncoding), false);
  assert.equal(isValidPasswordVerifier(badLength), false);
});

test('bad derived-key encoding or length is rejected', () => {
  const badEncoding = `${FORMAT}$${SALT.toString('base64url')}$not-base64!`;
  const badLength = `${FORMAT}$${SALT.toString('base64url')}$${'a'.repeat(42)}`;
  assert.equal(isValidPasswordVerifier(badEncoding), false);
  assert.equal(isValidPasswordVerifier(badLength), false);
});

test('extra verifier fields are rejected without exposing verifier material', () => {
  const malformed = `${verifier()}$extra`;
  assert.throws(() => parsePasswordVerifier(malformed), error => {
    assert.equal(error.message, 'Invalid password verifier');
    assert.equal(error.message.includes(malformed), false);
    return true;
  });
});

test('non-string passwords fail without plaintext comparison', async () => {
  assert.equal(await verifyPassword(undefined, verifier()), false);
  assert.equal(await verifyPassword(null, verifier()), false);
});

test('malformed verifier fails before scrypt and remains generic', () => {
  assert.throws(() => verifyPassword(PASSWORD, 'secret-hash-material'), error => {
    assert.equal(error.message, 'Invalid password verifier');
    assert.equal(error.message.includes('secret-hash-material'), false);
    return true;
  });
});
