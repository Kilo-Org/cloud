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
 *   base64url({ provider, owner, uid, iat, nonce }) . HMAC-SHA256(payload, secret)
 *
 * where `provider` names the integration flow that minted the state, `owner`
 * is the original owner string, `uid` is the ID of the authenticated user who
 * started the flow, `iat` is the issued-at timestamp (seconds since epoch),
 * and `nonce` is random bytes to ensure uniqueness.
 *
 * On the callback we:
 *
 *  1. Verify the HMAC (state was created by us, not forged).
 *  2. Check `iat` is within the allowed TTL window (default 10 minutes).
 *  3. Extract `uid` and confirm it matches the session user (same user
 *     who initiated the flow is completing it).
 *  4. Check `provider` names the flow the callback serves.
 *  5. Return the `owner` string so the rest of the callback logic is
 *     unchanged.
 */

/** Maximum age of a state token in seconds (10 minutes). */
export const OAUTH_STATE_TTL_SECONDS = 10 * 60;

/** Integration flows that mint shared signed OAuth state. */
export const OAUTH_STATE_PROVIDERS = [
  'github',
  'gitlab',
  'bitbucket',
  'slack',
  'discord',
  'linear',
  'dolthub',
  'google',
] as const;

export type OAuthStateProvider = (typeof OAUTH_STATE_PROVIDERS)[number];

const OAuthStateProviderSchema = z.enum(OAUTH_STATE_PROVIDERS);

export type VerifiedOAuthState = {
  /** The integration flow that minted this state. */
  provider: OAuthStateProvider;
  /** The original owner string (`user_<id>` or `org_<id>`) */
  owner: string;
  /** The user ID that initiated the OAuth flow */
  userId: string;
  /** Optional relative path to return to after the OAuth callback. */
  returnTo?: string;
  purpose?: 'provider_install';
  issuedAt: number;
};

export type CreateOAuthStateOptions = {
  /** The integration flow minting this state. */
  provider: OAuthStateProvider;
  /** Marks a provider-install state that a callback must consume exactly once. */
  purpose?: 'provider_install';
};

/**
 * Build a signed OAuth state parameter.
 *
 * @param owner   – owner string, e.g. `user_abc123` or `org_xyz789`
 * @param userId  – the ID of the currently-authenticated user initiating the flow
 * @param options – the minting flow and, for reserved install flows, the purpose
 */
export function createOAuthState(
  owner: string,
  userId: string,
  returnTo: string | undefined,
  options: CreateOAuthStateOptions
): string {
  const safeReturnTo = returnTo ? validateReturnPath(returnTo) : null;
  return createSignedToken({
    provider: options.provider,
    owner,
    uid: userId,
    ...(safeReturnTo ? { returnTo: safeReturnTo } : {}),
    ...(options.purpose ? { purpose: options.purpose } : {}),
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
  provider: OAuthStateProviderSchema,
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
        provider: parsed.data.provider,
        owner: parsed.data.owner,
        userId: parsed.data.uid,
        issuedAt: parsed.data.iat,
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
