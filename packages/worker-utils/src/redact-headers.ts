const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-gitlab-token',
  'x-hub-signature',
  'x-hub-signature-256',
]);

/**
 * Returns a shallow copy of the headers record with auth-bearing header
 * values replaced by `"[REDACTED]"`. Matching is case-insensitive.
 */
export function redactSensitiveHeaders(
  headers: Record<string, string>
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    result[key] = SENSITIVE_HEADERS.has(key.toLowerCase()) ? '[REDACTED]' : value;
  }
  return result;
}
