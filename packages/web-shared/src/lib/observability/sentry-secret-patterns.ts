// Secret redaction shared by the Node.js and edge Sentry initializers and by
// code that puts upstream text into Sentry data. Keep this module edge-safe: no
// SDK runtime values and no Node builtins.

export const FILTERED_VALUE = '[Filtered]';
export const MAX_REDACTED_TEXT_LENGTH = 32 * 1024;
const TRUNCATED_MARKER = '[Truncated]';
const CIRCULAR = '[Circular]';
const MAX_DEPTH = 12;
const MAX_ENTRIES = 1000;

const BEARER_PATTERN = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{16,}/gi;
const BASIC_PATTERN = /\b(Basic)\s+[A-Za-z0-9+/]{16,}={0,2}/gi;

const SECRET_VALUE_PATTERNS = [
  // A JWS has three segments and a JWE has five; a JWE can have an empty key segment.
  // The first segment stops before another `-eyJ`, so a run such as `eyJ-eyJ-...`
  // is scanned once and not once for every start, which keeps the match linear.
  /\beyJ(?:[A-Za-z0-9_]|-(?!eyJ))+(?:\.[A-Za-z0-9_-]*){2,4}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[a-z]-[A-Za-z0-9-]{10,}/g,
];

const SENSITIVE_KEY_WORDS = new Set([
  'apikey',
  'auth',
  'authorization',
  'bearer',
  'cookie',
  'cookies',
  'credential',
  'credentials',
  'jwt',
  'passphrase',
  'passwd',
  'password',
  'pepper',
  'secret',
  'session',
  'token',
]);

const SENSITIVE_KEY_PAIRS = new Set([
  'access key',
  'api key',
  'auth header',
  'authorization header',
  'cookie header',
  'encryption key',
  'private key',
  'secret key',
  'signing key',
]);

// Every character that a secret pattern can match after its prefix.
const SECRET_CHARACTER = /[A-Za-z0-9._~+/=-]/;

function withoutTrailingSecretCharacters(text: string): string {
  let end = text.length;
  while (end > 0 && SECRET_CHARACTER.test(text[end - 1])) {
    end--;
  }
  return text.slice(0, end);
}

// Text over the limit is cut first, so the patterns never run on unbounded
// input. The characters before the cut that could be the start of a secret are
// dropped too, because a cut secret is too short for its pattern to match.
export function redactSecretValues(text: string, maxLength = MAX_REDACTED_TEXT_LENGTH): string {
  const truncated = text.length > maxLength;
  const kept = truncated ? withoutTrailingSecretCharacters(text.slice(0, maxLength)) : text;
  let redacted = kept
    .replace(BEARER_PATTERN, `$1 ${FILTERED_VALUE}`)
    .replace(BASIC_PATTERN, `$1 ${FILTERED_VALUE}`);
  for (const pattern of SECRET_VALUE_PATTERNS) {
    redacted = redacted.replace(pattern, FILTERED_VALUE);
  }
  return truncated ? `${redacted}${TRUNCATED_MARKER}` : redacted;
}

function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(word => word.length > 0);
}

// Only the last word decides, so `sessionId` and `inputTokens` stay readable
// while `accessToken` and `x-api-key` are filtered.
export function isSensitiveKey(key: string): boolean {
  const words = keyWords(key);
  const last = words.at(-1);
  if (last === undefined) {
    return false;
  }
  return SENSITIVE_KEY_WORDS.has(last) || SENSITIVE_KEY_PAIRS.has(words.slice(-2).join(' '));
}

function scrubObject(
  value: object,
  depth: number,
  ancestors: WeakSet<object>
): Record<string, unknown> {
  const scrubbed: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value).slice(0, MAX_ENTRIES)) {
    scrubbed[key] = isSensitiveKey(key) ? FILTERED_VALUE : scrubValue(entry, depth + 1, ancestors);
  }
  return scrubbed;
}

function scrubValue(value: unknown, depth: number, ancestors: WeakSet<object>): unknown {
  if (typeof value === 'string') {
    return redactSecretValues(value);
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  if (depth >= MAX_DEPTH) {
    return FILTERED_VALUE;
  }
  if (ancestors.has(value)) {
    return CIRCULAR;
  }
  ancestors.add(value);
  const scrubbed = Array.isArray(value)
    ? value.slice(0, MAX_ENTRIES).map(item => scrubValue(item, depth + 1, ancestors))
    : scrubObject(value, depth, ancestors);
  ancestors.delete(value);
  return scrubbed;
}

export function scrubSecrets(value: unknown): unknown {
  return scrubValue(value, 0, new WeakSet());
}

export function scrubSecretRecord(record: Record<string, unknown>): Record<string, unknown> {
  return scrubObject(record, 0, new WeakSet([record]));
}
