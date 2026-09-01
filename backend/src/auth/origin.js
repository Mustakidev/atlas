const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function normalizeOrigin(value) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new TypeError('ATLAS_ORIGIN must be a canonical origin');
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError('ATLAS_ORIGIN must be a canonical origin');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || parsed.pathname !== '/'
    || parsed.origin !== value) {
    throw new TypeError('ATLAS_ORIGIN must be a canonical origin');
  }

  return parsed.origin;
}

function isLoopbackOrigin(origin) {
  return LOOPBACK_HOSTS.has(new URL(origin).hostname.toLowerCase());
}

function isSameOriginRequest(req, origin) {
  return req.headers.origin === origin;
}

module.exports = { isLoopbackOrigin, isSameOriginRequest, normalizeOrigin };
