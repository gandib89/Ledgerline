const SENSITIVE_KEY = /password|secret|token|authorization|cookie|jwt/i;

function redact(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redact);
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : redact(val);
  }
  return out;
}

// Error.message/.stack are non-enumerable own props (spread/Object.entries
// skip them, so redact() alone would silently drop them) — pulled out
// explicitly so they still reach the log, while any *other* own prop (status,
// code, or anything future code attaches, e.g. a raw request body) is
// redacted by key name before it does.
export function safeErrorLog(err) {
  const { message, stack, ...rest } = err;
  return { message, stack, ...redact(rest) };
}
