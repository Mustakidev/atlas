const REDACTED = '[REDACTED]';
const MAX_INPUT_STRING_BYTES = 64 * 1024;
const DEFAULT_MAX_DEPTH = 6;
const DEFAULT_MAX_MEMBERS = 64;

const SENSITIVE_KEY_PATTERN = /(?:password|secret|token|cookie|authorization|api[-_]?key|session|private[-_]?key|seed|mnemonic|credential|passphrase|set[-_]?cookie)/i;
const SECRET_QUERY_PATTERN = /^(?:password|pass|secret|token|access[_-]?token|refresh[_-]?token|api[-_]?key|x[-_]?api[-_]?key|apikey|key|authorization|cookie|session|private[-_]?key|seed|mnemonic|credential|passphrase)$/i;
const STRING_SECRET_PATTERN = /(?:\bAuthorization\s*:\s*(?:Bearer|Basic)\s+[^\s,;]+|\bBearer\s+[^\s,;]+|\bBasic\s+[^\s,;]+|\bAuthorization\s*:\s*[^\s,;]+|\b(?:x[-_]?api[-_]?key|token|api[_-]?key|apikey|password|secret|session|cookie|authorization|set[-_]?cookie)\s*=\s*[^&\s,;]+)/gi;
const URL_CREDENTIAL_PATTERN = /(\bhttps?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi;
const HAS_OWN = Object.prototype.hasOwnProperty;

function truncateUtf8(value, maxBytes) {
  const stringValue = String(value);
  if (Buffer.byteLength(stringValue, 'utf8') <= maxBytes) return stringValue;

  let result = Buffer.from(stringValue, 'utf8').subarray(0, maxBytes).toString('utf8');
  while (Buffer.byteLength(result, 'utf8') > maxBytes) result = result.slice(0, -1);
  return result;
}

function redactUrlQuery(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return value;
  }

  if (!parsed.username && !parsed.password) {
    for (const [key] of parsed.searchParams) {
      if (SECRET_QUERY_PATTERN.test(key)) parsed.searchParams.set(key, REDACTED);
    }
    return parsed.toString();
  }

  parsed.username = REDACTED;
  parsed.password = REDACTED;
  for (const [key] of parsed.searchParams) {
    if (SECRET_QUERY_PATTERN.test(key)) parsed.searchParams.set(key, REDACTED);
  }
  return parsed.toString();
}

function redactString(value, secretValues = []) {
  let result = truncateUtf8(value, MAX_INPUT_STRING_BYTES);

  for (const secret of secretValues) {
    if (typeof secret !== 'string' || secret.length === 0) continue;
    result = result.split(secret).join(REDACTED);
  }

  result = result.replace(URL_CREDENTIAL_PATTERN, `$1${REDACTED}@`);
  result = result.replace(STRING_SECRET_PATTERN, match => {
    const separator = match.match(/\s*=\s*|\s*:\s*/)?.[0] || ' ';
    const prefix = match.slice(0, match.length - match.trimStart().length);
    if (/^\s*(?:Bearer|Basic)\s/i.test(match)) {
      return match.replace(/(Bearer|Basic)\s+[^\s,;]+/i, `$1 ${REDACTED}`);
    }
    const key = match.split(separator)[0];
    return `${prefix}${key}${separator}${REDACTED}`;
  });

  const urlCandidate = result.trim();
  if (/^https?:\/\//i.test(urlCandidate)) result = redactUrlQuery(result);
  return result;
}

function cloneError(error, options, depth, seen) {
  const safe = {};
  const name = redactString(error.name || 'Error', options.secretValues);
  const code = error.code === undefined || error.code === null
    ? undefined
    : redactString(error.code, options.secretValues);
  const message = redactString(error.message || '', options.secretValues);

  safe.name = name;
  if (code !== undefined) safe.code = code;
  safe.message = message;
  return safe;
}

function redactValue(value, options, depth, seen, root = false) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'bigint') return redactString(`${value}n`, options.secretValues);
  if (typeof value === 'string') return redactString(value, options.secretValues);
  if (typeof value === 'undefined') return undefined;
  if (typeof value === 'function' || typeof value === 'symbol') return REDACTED;

  if (value instanceof Error) return cloneError(value, options, depth, seen);
  if (depth >= options.maxDepth) return REDACTED;
  if (seen.has(value)) return REDACTED;
  seen.add(value);

  if (Array.isArray(value)) {
    const result = [];
    const count = Math.min(value.length, options.maxMembers);
    for (let index = 0; index < count; index += 1) {
      result.push(redactValue(value[index], options, depth + 1, seen));
    }
    if (value.length > count) result.push(REDACTED);
    seen.delete(value);
    return result;
  }

  if (!root) return REDACTED;

  const result = {};
  let count = 0;
  try {
    for (const key in value) {
      if (!HAS_OWN.call(value, key)) continue;
      if (count >= options.maxMembers) {
        result._redaction = REDACTED;
        break;
      }
      count += 1;
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        result[key] = REDACTED;
        continue;
      }
      try {
        result[key] = redactValue(value[key], options, depth + 1, seen);
      } catch {
        result[key] = REDACTED;
      }
    }
  } catch {
    return REDACTED;
  }
  seen.delete(value);
  return result;
}

function redactAllowedObject(value, options, allowedKeys, depth, seen) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return REDACTED;
  if (seen.has(value)) return REDACTED;
  seen.add(value);

  const result = {};
  const count = Math.min(allowedKeys.length, options.maxMembers);
  for (let index = 0; index < count; index += 1) {
    const key = allowedKeys[index];
    try {
      if (!HAS_OWN.call(value, key)) continue;
      result[key] = redactValue(value[key], options, depth + 1, seen);
    } catch {
      result[key] = REDACTED;
    }
  }
  seen.delete(value);
  return result;
}

function redact(value, {
  maxDepth = DEFAULT_MAX_DEPTH,
  maxMembers = DEFAULT_MAX_MEMBERS,
  secretValues = [],
  allowedKeys = null,
} = {}) {
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0) {
    throw new TypeError('maxDepth must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(maxMembers) || maxMembers < 1) {
    throw new TypeError('maxMembers must be a positive safe integer');
  }

  const options = { maxDepth, maxMembers, secretValues };
  const seen = new WeakSet();
  if (Array.isArray(allowedKeys)) return redactAllowedObject(value, options, allowedKeys, 0, seen);
  return redactValue(value, options, 0, seen, true);
}

module.exports = {
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_MEMBERS,
  REDACTED,
  redact,
  redactString,
  truncateUtf8,
};
