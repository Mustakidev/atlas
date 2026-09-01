const SESSION_COOKIE = 'atlas_session';
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function parseSessionCookie(header) {
  if (typeof header !== 'string') return null;

  let value = null;
  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=');
    if (separator < 0) continue;

    const name = pair.slice(0, separator).trim();
    if (name !== SESSION_COOKIE) continue;
    if (value !== null) return null;

    const candidate = pair.slice(separator + 1).trim();
    if (!SESSION_TOKEN_PATTERN.test(candidate)) return null;
    value = candidate;
  }
  return value;
}

function serializeSessionCookie(value, { maxAge, secure }) {
  const attributes = [
    `${SESSION_COOKIE}=${value}`,
    `Max-Age=${maxAge}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
  ];
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}

function clearSessionCookie({ secure }) {
  return serializeSessionCookie('', { maxAge: 0, secure })
    + '; Expires=Thu, 01 Jan 1970 00:00:00 GMT';
}

module.exports = { clearSessionCookie, parseSessionCookie, serializeSessionCookie };
