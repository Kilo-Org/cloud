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
 * GitHub user-to-server (`ghu_`) and refresh (`ghr_`) token prefixes.
 * These must never appear in logs or URLs.
 */
const GITHUB_TOKEN_RE = /gh[ur]_[A-Za-z0-9_-]+/g;

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

/**
 * Redact GitHub user-to-server (`ghu_`) and refresh (`ghr_`) tokens
 * from an arbitrary string. Safe for use in logs and error messages.
 */
export function redactGitHubTokens(value: string): string {
  return value.replace(GITHUB_TOKEN_RE, '[REDACTED]');
}
