const assert = require('node:assert/strict');
const test = require('node:test');

const { parseSessionCookie } = require('../../src/auth/cookie');
const { SESSION_TTL_MS, SingleOperatorSessionStore } = require('../../src/auth/sessionStore');

test('issues a 32-byte base64url token and stores one operator session', () => {
  const store = new SingleOperatorSessionStore({ now: () => 1_000 });
  const issued = store.issue();

  assert.match(issued.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(issued.expiresAt, 1_000 + SESSION_TTL_MS);
  assert.deepEqual(store.lookup(issued.token), { type: 'session', principal: 'operator' });
});

test('random invalid tokens never create or reveal session state', () => {
  const store = new SingleOperatorSessionStore({ now: () => 1_000 });
  assert.equal(store.lookup('a'.repeat(43)), null);
  assert.equal(store.lookup('b'.repeat(43)), null);
});

test('malformed token syntax is rejected before digest lookup', () => {
  const store = new SingleOperatorSessionStore();
  store.issue();
  for (const token of ['', 'short', 'a'.repeat(42), 'a'.repeat(44), `${'a'.repeat(42)}!`]) {
    assert.equal(store.lookup(token), null);
  }
});

test('expired sessions are removed and rejected', () => {
  let now = 1_000;
  const store = new SingleOperatorSessionStore({ now: () => now });
  const issued = store.issue();
  now += SESSION_TTL_MS;

  assert.equal(store.lookup(issued.token), null);
  now -= 1;
  assert.equal(store.lookup(issued.token), null);
});

test('new login replaces the previous active session', () => {
  const store = new SingleOperatorSessionStore({ now: () => 1_000 });
  const first = store.issue();
  const second = store.issue();

  assert.equal(store.lookup(first.token), null);
  assert.deepEqual(store.lookup(second.token), { type: 'session', principal: 'operator' });
});

test('logout invalidates only the matching session', () => {
  const store = new SingleOperatorSessionStore();
  const issued = store.issue();

  store.invalidate('a'.repeat(43));
  assert.deepEqual(store.lookup(issued.token), { type: 'session', principal: 'operator' });
  store.invalidate(issued.token);
  assert.equal(store.lookup(issued.token), null);
});

test('session cookie parser accepts only the single restricted token', () => {
  const token = 'a'.repeat(43);
  assert.equal(parseSessionCookie(`other=x; atlas_session=${token}`), token);
  assert.equal(parseSessionCookie(`atlas_session = ${token}`), token);
  assert.equal(parseSessionCookie(`atlas_session=${token}; atlas_session=${token}`), null);
  assert.equal(parseSessionCookie('atlas_session=bad!'), null);
  assert.equal(parseSessionCookie('atlas_session="quoted"'), null);
});

test('session store keeps no raw token in the active record', () => {
  const store = new SingleOperatorSessionStore();
  const issued = store.issue();

  assert.equal(Object.hasOwn(store.session, 'token'), false);
  assert.equal(Object.hasOwn(store.session, 'tokenDigest'), true);
  assert.equal(store.session.tokenDigest.toString('base64url') === issued.token, false);
});
