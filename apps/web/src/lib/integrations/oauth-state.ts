import 'server-only';
import { createSignedToken, verifySignedToken } from '@/lib/signed-token';
import { validateReturnPath } from '@/lib/integrations/validate-return-path';

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

/** Maximum age of a state token in seconds (10 minutes). */
export const OAUTH_STATE_TTL_SECONDS = 10 * 60;

export type VerifiedOAuthState = {
  /** The original owner string (`user_<id>` or `org_<id>`) */
  owner: string;
  /** The user ID that initiated the OAuth flow */
  userId: string;
  /** Optional relative path to return to after the OAuth callback. */
  returnTo?: string;
};

/**
 * Build a signed OAuth state parameter.
 *
 * @param owner  – owner string, e.g. `user_abc123` or `org_xyz789`
 * @param userId – the ID of the currently-authenticated user initiating the flow
 */
export function createOAuthState(owner: string, userId: string, returnTo?: string): string {
  const safeReturnTo = returnTo ? validateReturnPath(returnTo) : null;
  return createSignedToken({
    owner,
    uid: userId,
    ...(safeReturnTo ? { returnTo: safeReturnTo } : {}),
  });
}

/**
 * Verify a signed OAuth state parameter and return the embedded payload.
 *
 * Returns `null` if the state is missing, malformed, the signature is
 * invalid, or the token has expired.
 */
export function verifyOAuthState(state: string | null): VerifiedOAuthState | null {
  return verifySignedToken(state, {
    ttlSeconds: OAUTH_STATE_TTL_SECONDS,
    parse: payload => {
      if (typeof payload.owner !== 'string' || typeof payload.uid !== 'string') return null;

      const returnTo =
        typeof payload.returnTo === 'string' ? validateReturnPath(payload.returnTo) : null;

      return {
        owner: payload.owner,
        userId: payload.uid,
        ...(returnTo ? { returnTo } : {}),
      };
    },
  });
}
