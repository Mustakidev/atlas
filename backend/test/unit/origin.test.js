const assert = require('node:assert/strict');
const test = require('node:test');

const { isLoopbackOrigin, normalizeOrigin } = require('../../src/auth/origin');

test('canonical origins accept only root HTTP or HTTPS origins', () => {
  assert.equal(normalizeOrigin('http://localhost:3000'), 'http://localhost:3000');
  assert.equal(normalizeOrigin('https://atlas.example.com'), 'https://atlas.example.com');
});

test('origin normalization rejects trailing slash, paths, queries, hashes, credentials, and schemes', () => {
  for (const value of [
    '',
    'http://localhost:3000/',
    'http://localhost:3000/app',
    'http://localhost:3000/?x=1',
    'http://localhost:3000/#x',
    'http://user@localhost:3000',
    'ftp://localhost:3000',
    'not-an-origin',
  ]) {
    assert.throws(() => normalizeOrigin(value), /canonical origin/);
  }
});

test('loopback classification is restricted to accepted local hosts', () => {
  assert.equal(isLoopbackOrigin('http://localhost:3000'), true);
  assert.equal(isLoopbackOrigin('http://127.0.0.1:3000'), true);
  assert.equal(isLoopbackOrigin('http://[::1]:3000'), true);
  assert.equal(isLoopbackOrigin('https://atlas.example.com'), false);
});
