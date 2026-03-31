const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-gitlab-token',
  'x-hub-signature',
  'x-hub-signature-256',
]);

/**
 * Returns a shallow copy of the headers record with auth-bearing header
 * values replaced by `"[REDACTED]"`. Matching is case-insensitive.
 *
 * Pass `extraHeaders` to redact additional header names beyond the
 * built-in allowlist (e.g. custom webhook auth headers).
 */
export function redactSensitiveHeaders(
  headers: Record<string, string>,
  extraHeaders?: readonly string[]
): Record<string, string> {
  const sensitive = extraHeaders
    ? new Set([...SENSITIVE_HEADERS, ...extraHeaders.map(h => h.toLowerCase())])
    : SENSITIVE_HEADERS;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    result[key] = sensitive.has(key.toLowerCase()) ? '[REDACTED]' : value;
  }
  return result;
}
