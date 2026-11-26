// Secret redaction shared by the Node.js and edge Sentry initializers and by
// code that puts upstream text into Sentry data. Keep this module edge-safe: no
// SDK runtime values and no Node builtins.

import { sanitizeAnalyticsText as sanitizeAnalyticsPaths } from '@kilocode/web-shared/lib/sanitize-analytics-url';

export const FILTERED_VALUE = '[Filtered]';
export const MAX_REDACTED_TEXT_LENGTH = 32 * 1024;
const TRUNCATED_MARKER = '[Truncated]';
const CIRCULAR = '[Circular]';
const MAX_DEPTH = 12;
const MAX_ENTRIES = 1000;

const BEARER_PATTERN = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{16,}/gi;
const BASIC_PATTERN = /\b(Basic)\s+[A-Za-z0-9+/]{16,}={0,2}/gi;

// The body class has no `-`, so a match ends at the next dash and a run of
// headers with no end line is scanned once. The end line is optional, so a body
// cut at the length limit is still removed.
const PRIVATE_KEY_PATTERN =
  /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----[A-Za-z0-9+/=\s\\]*(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----)?/g;

// The path of these webhook URLs is the credential.
const WEBHOOK_URL_PATTERNS = [
  /\b(https?:\/\/hooks\.slack\.com\/)[A-Za-z0-9/_-]+/gi,
  /\b(https?:\/\/(?:[a-z]+\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/)[A-Za-z0-9/_-]+/gi,
];

const URL_USERINFO_PATTERN = /\b([a-z][a-z0-9+.-]{1,20}:\/\/)[^\s/?#@"'<>]+@/gi;

// The base64 JSON payload cannot contain the underscore delimiter.
const SENTRY_ORG_TOKEN_PATTERN =
  /\bsntrys_eyJ[A-Za-z0-9+/]+={0,2}_[A-Za-z0-9+/]{43}(?![A-Za-z0-9+/=_])/g;

function sanitizeAnalyticsText(text: string): string {
  // The base64 secret can contain a slash segment that looks like a capability path.
  return sanitizeAnalyticsPaths(text.replace(SENTRY_ORG_TOKEN_PATTERN, FILTERED_VALUE));
}

const SECRET_VALUE_PATTERNS = [
  // A JWS has three segments and a JWE has five; a JWE can have an empty key segment.
  // The first segment stops before another `-eyJ`, so a run such as `eyJ-eyJ-...`
  // is scanned once and not once for every start, which keeps the match linear.
  /\beyJ(?:[A-Za-z0-9_]|-(?!eyJ))+(?:\.[A-Za-z0-9_-]*){2,4}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[a-z]-[A-Za-z0-9-]{10,}/g,
  /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /\bwhsec_[A-Za-z0-9+/=]{16,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bya29\.[A-Za-z0-9_-]{20,}/g,
  /\bAIza[A-Za-z0-9_-]{30,}/g,
  /\bAQ\.[A-Za-z0-9_-]{20,}/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\bsntryu_[A-Fa-f0-9]{64}\b/g,
];

// A `name=value` pair in a query, a form body, a cookie or a log line, also in
// its percent-encoded form inside another URL. The value stops at `?` and `%3F`,
// so a nested URL in an allowed value is read as its own query. The two value
// alternatives never match the same character, so no character is read twice.
const PARAMETER_PATTERN =
  /(^|[?&;,\s]|%3[Ff]|%26)([A-Za-z0-9_.[\]-]{1,64})(=|%3[Dd])((?:[^&#\s"'<>%?;,]|%(?!26|3[Ff]))*)/g;

// A `"name": "value"` or `"name": 123` pair of serialized JSON. The two string
// value alternatives never match the same character, so no character is read
// twice, and the scan of a string value stops at the next quote.
const JSON_PAIR_PATTERN =
  /"([A-Za-z0-9_.-]{1,64})"([ \t]{0,8}:[ \t]{0,8})(?:"((?:[^"\\]|\\.)*)"|(\d{1,20}))/g;

// The same pair in Node's `util.inspect` form: `{ access_token: 'abc' }`, also
// with a quoted name: `{ 'x-api-key': 'abc' }`.
const INSPECT_PAIR_PATTERN =
  /(^|[\s{,])(?:'([A-Za-z0-9_.$-]{1,64})'|([A-Za-z_$][\w$]{0,63}))(:[ \t]{0,8})(?:'((?:[^'\\]|\\.)*)'|(\d{1,20}))/g;

// A `Name: value` header line in log or error text. An authorization or cookie
// header at the start of the text or of a line, after at most a short indent and
// a `>` or `<` marker (curl's verbose request and response lines), is filtered
// to the end of that line, because its value can hold any scheme or several
// cookies. The lookbehind for that line start has a bounded length. Elsewhere,
// such as inside a one-line provider payload, an authorization value is filtered
// with the word before it, and the fields after it stay. Any other value is
// either quoted or a run whose class excludes every character the prefix can be,
// so no match attempt starts inside an earlier value and each character is read
// a bounded number of times.
const HEADER_LINE_PATTERN =
  /(^|[\s"'{,])(?:(?<=(?:^|[\r\n])[ \t]{0,8}(?:[<>][ \t]{0,8})?)((?:proxy-)?authorization|(?:set-)?cookie)(:[ \t]{0,8})([^\r\n]*)|((?:proxy-)?authorization)(:[ \t]{0,8})([A-Za-z][\w-]{0,24}[ \t]{1,8})?(?:"(?:[^"\\]|\\.)*"|[^\s"',;{}]+)|([A-Za-z0-9_.-]{1,64})(:[ \t]{0,8})((?:basic|bearer|bot|digest|dpop|key|negotiate|token)[ \t]{1,8})?(?:"((?:[^"\\]|\\.)*)"|([^\s"',;{}]+)))/gi;
// A known authorization scheme stays readable in front of the filtered value.
const AUTHORIZATION_SCHEME = /^(?:basic|bearer|bot|digest|dpop|key|negotiate|token)[ \t]{1,8}/i;

// A one-time code is 6 to 8 digits (Kilo's are six); an opaque token is a long
// run with letters and digits, such as a Google `4/0A…` authorization code.
// Database states and provider error numbers such as `23505` or `1113` are neither.
const DIGIT_CODE = /^\d{6,8}$/;
const OPAQUE_TOKEN = /^[A-Za-z0-9_.+/=~-]{20,}$/;
const CODE_SUFFIX = /code$/i;
// `errorCode`, `statusCode`, `exitCode`: diagnostic codes, never credentials.
const DIAGNOSTIC_CODE_QUALIFIERS = new Set(['error', 'status', 'exit']);

// Names that carry a credential only as a parameter, matched whole: `key` is a
// Google API key, `code` an OAuth or one-time code, `sig` a signed-URL signature.
const SENSITIVE_PARAMETER_NAMES = new Set([
  'code',
  'hmac',
  'key',
  'otp',
  'sig',
  'signature',
  'ticket',
  'x-amz-signature',
]);

// Every sensitive key word and pair contains one of these, so a name without one
// skips the word split. A long query has many pairs, and most of them are plain.
const SENSITIVE_NAME_HINT =
  /auth|bearer|cookie|credential|device.?code|jwt|key|otp|pass|pem|pepper|pin|secret|session|token|user.?code/i;

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
  'otp',
  'passphrase',
  'passwd',
  'password',
  'pem',
  'pepper',
  'pin',
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
  // OAuth device flow codes.
  'device code',
  'user code',
]);

// Every character that a secret pattern can match after its prefix.
const SECRET_CHARACTER = /[A-Za-z0-9._~+/=%:@-]/;

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
  let redacted = sanitizeAnalyticsText(kept).replace(PRIVATE_KEY_PATTERN, FILTERED_VALUE);
  for (const pattern of WEBHOOK_URL_PATTERNS) {
    redacted = redacted.replace(pattern, `$1${FILTERED_VALUE}`);
  }
  redacted = redacted
    .replace(URL_USERINFO_PATTERN, `$1${FILTERED_VALUE}@`)
    .replace(BEARER_PATTERN, `$1 ${FILTERED_VALUE}`)
    .replace(BASIC_PATTERN, `$1 ${FILTERED_VALUE}`);
  for (const pattern of SECRET_VALUE_PATTERNS) {
    redacted = redacted.replace(pattern, FILTERED_VALUE);
  }
  redacted = redacted
    .replace(PARAMETER_PATTERN, redactSensitiveParameter)
    .replace(JSON_PAIR_PATTERN, redactSensitiveJsonPair)
    .replace(INSPECT_PAIR_PATTERN, redactSensitiveInspectPair)
    .replace(HEADER_LINE_PATTERN, redactSensitiveHeaderLine);
  return truncated ? `${redacted}${TRUNCATED_MARKER}` : redacted;
}

function redactSensitiveParameter(
  match: string,
  prefix: string,
  name: string,
  separator: string,
  value: string
): string {
  const sensitive =
    value.length > 0 &&
    (SENSITIVE_PARAMETER_NAMES.has(name.toLowerCase()) || isSensitiveName(name));
  return sensitive ? `${prefix}${name}${separator}${FILTERED_VALUE}` : match;
}

function redactSensitiveJsonPair(
  match: string,
  name: string,
  separator: string,
  text: string | undefined,
  number: string | undefined
): string {
  const value = text ?? number ?? '';
  return value.length > 0 && isSensitiveEntry(name, value)
    ? `"${name}"${separator}"${FILTERED_VALUE}"`
    : match;
}

function redactSensitiveInspectPair(
  match: string,
  prefix: string,
  quotedName: string | undefined,
  bareName: string | undefined,
  separator: string,
  text: string | undefined,
  number: string | undefined
): string {
  const name = quotedName ?? bareName ?? '';
  const value = text ?? number ?? '';
  if (value.length === 0 || !isSensitiveEntry(name, value)) {
    return match;
  }
  const shownName = quotedName === undefined ? name : `'${name}'`;
  return `${prefix}${shownName}${separator}'${FILTERED_VALUE}'`;
}

function redactSensitiveHeaderLine(
  match: string,
  prefix: string,
  lineName: string | undefined,
  lineSeparator: string | undefined,
  lineValue: string | undefined,
  authName: string | undefined,
  authSeparator: string | undefined,
  authScheme: string | undefined,
  name: string | undefined,
  separator: string | undefined,
  scheme: string | undefined,
  quoted: string | undefined
): string {
  if (lineName !== undefined) {
    if (!lineValue) {
      return match;
    }
    const keptScheme = AUTHORIZATION_SCHEME.exec(lineValue)?.[0] ?? '';
    return `${prefix}${lineName}${lineSeparator}${keptScheme}${FILTERED_VALUE}`;
  }
  if (authName !== undefined) {
    const keptScheme = AUTHORIZATION_SCHEME.exec(authScheme ?? '')?.[0] ?? '';
    return `${prefix}${authName}${authSeparator}${keptScheme}${FILTERED_VALUE}`;
  }
  if (name === undefined || !isSensitiveName(name)) {
    return match;
  }
  const filtered = quoted === undefined ? FILTERED_VALUE : `"${FILTERED_VALUE}"`;
  return `${prefix}${name}${separator}${scheme ?? ''}${filtered}`;
}

function isSensitiveName(name: string): boolean {
  return SENSITIVE_NAME_HINT.test(name) && isSensitiveWords(keyWords(name));
}

function looksLikeCode(value: unknown): boolean {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string') {
    return false;
  }
  return (
    DIGIT_CODE.test(text) || (OPAQUE_TOKEN.test(text) && /\d/.test(text) && /[A-Za-z]/.test(text))
  );
}

// A key whose last word is `code` (`code`, `verificationCode`) holds a credential
// only when its value looks like a one-time code or an opaque token, and not when
// the word before it marks a diagnostic code. A key with neither a sensitive word
// nor a `code` ending returns before the word split.
export function isSensitiveEntry(key: string, value: unknown): boolean {
  const hinted = SENSITIVE_NAME_HINT.test(key);
  if (!hinted && !CODE_SUFFIX.test(key)) {
    return false;
  }
  const words = keyWords(key);
  if (isSensitiveWords(words)) {
    return true;
  }
  return (
    words.at(-1) === 'code' &&
    !DIAGNOSTIC_CODE_QUALIFIERS.has(words.at(-2) ?? '') &&
    looksLikeCode(value)
  );
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
function isSensitiveWords(words: string[]): boolean {
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
    scrubbed[key] = isSensitiveEntry(key, entry)
      ? FILTERED_VALUE
      : scrubValue(entry, depth + 1, ancestors);
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
