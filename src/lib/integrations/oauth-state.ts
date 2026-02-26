import 'server-only';
import crypto from 'node:crypto';
import { NEXTAUTH_SECRET } from '@/lib/config.server';

/**
 * HMAC-signed OAuth state parameter.
 *
 * The plain owner string (`user_<id>` / `org_<id>`) that was previously used
 * as the OAuth `state` is guessable and does not bind the flow to the user
 * who initiated it, leaving the callback vulnerable to CSRF / authorization-
 * code injection.
 *
 * This module produces a state value of the form:
 *
 *   base64url({ owner, uid, iat, nonce }) . HMAC-SHA256(payload, secret)
 *
 * where `owner` is the original owner string, `uid` is the ID of the
 * authenticated user who started the flow, `iat` is the issued-at timestamp
 * (seconds since epoch), and `nonce` is random bytes to ensure uniqueness.
 *
 * On the callback we:
 *
 *  1. Verify the HMAC (state was created by us, not forged).
 *  2. Check `iat` is within the allowed TTL window (default 10 minutes).
 *  3. Extract `uid` and confirm it matches the session user (same user
 *     who initiated the flow is completing it).
 *  4. Return the `owner` string so the rest of the callback logic is
 *     unchanged.
 */

const HMAC_ALGORITHM = 'sha256';

/** Maximum age of a state token in seconds (10 minutes). */
const STATE_TTL_SECONDS = 10 * 60;

/** Number of random bytes for the nonce (16 bytes = 128 bits). */
const NONCE_BYTES = 16;

function sign(data: string): string {
  return crypto.createHmac(HMAC_ALGORITHM, NEXTAUTH_SECRET).update(data).digest('base64url');
}

/**
 * Build a signed OAuth state parameter.
 *
 * @param owner  – owner string, e.g. `user_abc123` or `org_xyz789`
 * @param userId – the ID of the currently-authenticated user initiating the flow
 */
export function createOAuthState(owner: string, userId: string): string {
  const iat = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(NONCE_BYTES).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ owner, uid: userId, iat, nonce })).toString(
    'base64url'
  );
  const signature = sign(payload);
  return `${payload}.${signature}`;
}

export type VerifiedOAuthState = {
  /** The original owner string (`user_<id>` or `org_<id>`) */
  owner: string;
  /** The user ID that initiated the OAuth flow */
  userId: string;
};

/**
 * Verify a signed OAuth state parameter and return the embedded payload.
 *
 * Returns `null` if the state is missing, malformed, the signature is
 * invalid, or the token has expired.
 */
export function verifyOAuthState(state: string | null): VerifiedOAuthState | null {
  if (!state) return null;

  const dotIndex = state.indexOf('.');
  if (dotIndex === -1) return null;

  const payload = state.slice(0, dotIndex);
  const providedSig = state.slice(dotIndex + 1);

  // Constant-time comparison to prevent timing attacks
  const expectedSig = sign(payload);
  if (
    providedSig.length !== expectedSig.length ||
    !crypto.timingSafeEqual(Buffer.from(providedSig), Buffer.from(expectedSig))
  ) {
    return null;
  }

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      owner?: string;
      uid?: string;
      iat?: number;
      nonce?: string;
    };
    if (typeof data.owner !== 'string' || typeof data.uid !== 'string') return null;

    // Enforce TTL: reject tokens that are too old or have no timestamp
    if (typeof data.iat !== 'number') return null;
    const ageSeconds = Math.floor(Date.now() / 1000) - data.iat;
    if (ageSeconds < 0 || ageSeconds > STATE_TTL_SECONDS) return null;

    // Require nonce to be present (guards against old-format tokens)
    if (typeof data.nonce !== 'string' || data.nonce.length === 0) return null;

    return { owner: data.owner, userId: data.uid };
  } catch {
    return null;
  }
}
