/**
 * OpenAI can reject a delegated access token before its stored `expires_at`,
 * for example after the person signs out of ChatGPT elsewhere. The stored
 * expiry alone would then keep serving the dead token until it lapses, failing
 * every request in between.
 */
const REJECTED_TOKEN_STATUS = 401;
const REJECTED_TOKEN_CODES: ReadonlySet<unknown> = new Set(['token_expired', 'token_revoked']);

export function isChatGptAccessTokenRejected(status: number, body: unknown): boolean {
  if (status !== REJECTED_TOKEN_STATUS) return false;
  if (typeof body !== 'object' || body === null || !('error' in body)) return false;
  const error = body.error;
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    REJECTED_TOKEN_CODES.has(error.code)
  );
}
