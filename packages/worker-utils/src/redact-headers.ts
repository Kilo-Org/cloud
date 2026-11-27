// Credential headers whose names contain none of the terms below.
const SENSITIVE_HEADERS = new Set([
  'x-kilo-briefing-settlement',
  'x-kilo-runtime-proxy-attestation',
  'x-kilo-runtime-proxy-origin',
  'x-vercel-sc-headers',
]);

const SENSITIVE_NAME_TERMS = [
  'token',
  'secret',
  'signature',
  'auth',
  'cookie',
  'api-key',
  'password',
];

function isSensitiveHeader(name: string, extraHeaders: ReadonlySet<string> | undefined): boolean {
  return (
    SENSITIVE_HEADERS.has(name) ||
    extraHeaders?.has(name) === true ||
    SENSITIVE_NAME_TERMS.some(term => name.includes(term))
  );
}

/**
 * Returns a shallow copy of the headers record with auth-bearing header
 * values replaced by `"[REDACTED]"`. Matching is case-insensitive. A header
 * is redacted when its name is in the built-in list or contains `token`,
 * `secret`, `signature`, `auth`, `cookie`, `api-key` or `password`.
 *
 * Pass `extraHeaders` to redact additional header names (e.g. custom webhook
 * auth headers).
 */
export function redactSensitiveHeaders(
  headers: Record<string, string>,
  extraHeaders?: readonly string[]
): Record<string, string> {
  const extra = extraHeaders && new Set(extraHeaders.map(h => h.toLowerCase()));
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    result[key] = isSensitiveHeader(key.toLowerCase(), extra) ? '[REDACTED]' : value;
  }
  return result;
}
