import 'server-only';

import { z } from 'zod';
import { createSignedToken, verifySignedTokenDetailed } from '@/lib/signed-token';
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
  purpose?: 'provider_install';
};

/**
 * Build a signed OAuth state parameter.
 *
 * @param owner  – owner string, e.g. `user_abc123` or `org_xyz789`
 * @param userId – the ID of the currently-authenticated user initiating the flow
 */
export function createOAuthState(
  owner: string,
  userId: string,
  returnTo?: string,
  purpose?: 'provider_install'
): string {
  const safeReturnTo = returnTo ? validateReturnPath(returnTo) : null;
  return createSignedToken({
    owner,
    uid: userId,
    ...(safeReturnTo ? { returnTo: safeReturnTo } : {}),
    ...(purpose ? { purpose } : {}),
  });
}

/**
 * Verify a signed OAuth state parameter and return the embedded payload.
 *
 * Returns `null` if the state is missing, malformed, the signature is
 * invalid, or the token has expired.
 */
export function verifyOAuthState(state: string | null): VerifiedOAuthState | null {
  const result = verifyOAuthStateDetailed(state);
  return result.status === 'valid' ? result.state : null;
}

export type OAuthStateVerificationFailureReason =
  | 'state_missing'
  | 'state_malformed'
  | 'signature_invalid'
  | 'state_expired'
  | 'state_from_future';

export type OAuthStateVerificationResult =
  | { status: 'valid'; state: VerifiedOAuthState }
  | { status: 'invalid'; reason: OAuthStateVerificationFailureReason };

const OAuthStatePayloadSchema = z.object({
  owner: z.string(),
  uid: z.string(),
  iat: z.number().finite(),
  nonce: z.string().min(1),
  returnTo: z.unknown().optional(),
  purpose: z.enum(['provider_install']).optional(),
});

export function verifyOAuthStateDetailed(state: string | null): OAuthStateVerificationResult {
  const result = verifySignedTokenDetailed(state, {
    ttlSeconds: OAUTH_STATE_TTL_SECONDS,
    parse: payload => {
      const parsed = OAuthStatePayloadSchema.safeParse(payload);
      if (!parsed.success) return null;

      const returnTo =
        typeof parsed.data.returnTo === 'string' ? validateReturnPath(parsed.data.returnTo) : null;

      return {
        owner: parsed.data.owner,
        userId: parsed.data.uid,
        ...(returnTo ? { returnTo } : {}),
        ...(parsed.data.purpose ? { purpose: parsed.data.purpose } : {}),
      };
    },
  });

  if (result.status === 'valid') return { status: 'valid', state: result.value };

  switch (result.reason) {
    case 'token_missing':
      return { status: 'invalid', reason: 'state_missing' };
    case 'token_malformed':
    case 'payload_invalid':
      return { status: 'invalid', reason: 'state_malformed' };
    case 'signature_invalid':
      return { status: 'invalid', reason: 'signature_invalid' };
    case 'token_expired':
      return { status: 'invalid', reason: 'state_expired' };
    case 'token_from_future':
      return { status: 'invalid', reason: 'state_from_future' };
  }
}
