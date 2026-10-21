import 'server-only';
import { createHash } from 'node:crypto';

/**
 * Short, non-reversible identifier for an OAuth `state` value, safe to attach
 * to logs and Sentry events. The signed state embeds the owner, user id, and
 * nonce, so the raw value must never be logged; an 8-hex-char SHA-256 prefix
 * is enough to correlate a callback failure back to its initiating request.
 *
 * The `provider_oauth_attempts.state_hash` column stores the *full* digest
 * because it is used for equality matching; this helper is for observability
 * correlation only and intentionally truncates.
 */
export function oauthStateHash(state: string | null): string | null {
  return state ? createHash('sha256').update(state).digest('hex').slice(0, 8) : null;
}

/**
 * Validate a raw OAuth authorization code before handing it to a provider
 * token exchange. Returns the code unchanged, or `null` when it is missing,
 * over-length, or contains characters outside the RFC 6749 code alphabet.
 */
export function validOAuthCode(code: string | null): string | null {
  if (!code || code.length > 2048 || !/^[A-Za-z0-9._~+/-]+$/.test(code)) return null;
  return code;
}
