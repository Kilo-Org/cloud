import {
  type IssuedToken,
  type TokenResponse,
  type UtsAccessTokenClaims,
  UTS_ACCESS_TOKEN_LIFETIME_SECONDS,
  UtsAccessTokenClaimsSchema,
  audienceOfScope,
} from '@kilocode/uts-contracts';
import { withDORetry } from '@kilocode/worker-utils';
import { getSignerStub } from '../dos/stubs';
import type { SignResult } from '../dos/UtsSignerDO';
import type { Env, UtsConfig } from '../env';
import type { Minted } from '../grants/store';
import { signerForGrant } from '../keys/signer-choice';

/**
 * Access tokens for one mint statement: one token per scope, each with one audience and one
 * scope (design 5.3), all signed by the signer object the grant id picks (design 5.7).
 */

/**
 * The claim sets of one mint, in the order of `minted.scopes`. `act` and `req` stay absent: a
 * token minted from a grant is not delegated.
 */
export function accessTokenClaims(
  config: UtsConfig,
  clientId: string,
  grantId: string,
  minted: Minted,
  nowSeconds: number
): UtsAccessTokenClaims[] {
  return minted.scopes.map((scope, index) =>
    UtsAccessTokenClaimsSchema.parse({
      iss: config.endpoints.issuer,
      exp: nowSeconds + UTS_ACCESS_TOKEN_LIFETIME_SECONDS,
      aud: audienceOfScope(scope),
      sub: minted.subjectId,
      client_id: clientId,
      iat: nowSeconds,
      jti: minted.tokenIds[index],
      scope,
      ...(minted.orgId === null ? {} : { org: minted.orgId }),
      sid: grantId,
      auth_time: Math.floor(minted.authTime.getTime() / 1000),
      amr: minted.amr,
      env: config.environment,
    })
  );
}

/**
 * `unavailable`: a signer call failed after its retries, so a later call can succeed.
 * `misconfigured`: the signer refused to load or refused the claims, which no retry fixes.
 */
export type SignOutcome =
  | { status: 'signed'; tokens: string[] }
  | { status: 'unavailable' }
  | { status: 'misconfigured' };

export type SignerAccess = (
  grantId: string,
  claims: readonly UtsAccessTokenClaims[]
) => Promise<SignOutcome>;

/**
 * Signs every claim set in the grant's signer object, in parallel on one stub. `sign` is
 * idempotent, so each call keeps the shared Durable Object retry.
 */
export function signerAccess(env: Env, config: UtsConfig): SignerAccess {
  return async (grantId, claims) => {
    const signer = await signerForGrant(grantId);
    const answers = await Promise.allSettled(
      claims.map(claimSet =>
        withDORetry(
          () => getSignerStub(env, config, signer),
          async (stub): Promise<SignResult> => await stub.sign(claimSet),
          'uts.signer.sign'
        )
      )
    );
    const tokens: string[] = [];
    let outcome: SignOutcome['status'] = 'signed';
    for (const answer of answers) {
      if (answer.status === 'rejected') {
        console.error(
          JSON.stringify({ event: 'uts.mint.sign_failed', signer, error: String(answer.reason) })
        );
        if (outcome === 'signed') outcome = 'unavailable';
      } else if (answer.value.status === 'signed') {
        tokens.push(answer.value.token);
      } else {
        console.error(
          JSON.stringify({
            event: 'uts.mint.sign_refused',
            signer,
            reason: answer.value.reason,
          })
        );
        outcome = 'misconfigured';
      }
    }
    return outcome === 'signed' ? { status: 'signed', tokens } : { status: outcome };
  };
}

/**
 * The token response for the signed tokens (`TokenResponseSchema`). `refresh` is the new refresh
 * credential when the call created a grant or rotated a third-party token.
 */
export function tokenResponseBody(
  claims: readonly UtsAccessTokenClaims[],
  tokens: readonly string[],
  refresh: { token: string; expiresAt: Date } | null,
  nowMs: number
): TokenResponse {
  const issued: IssuedToken[] = claims.map((claimSet, index) => ({
    access_token: tokens[index],
    token_type: 'Bearer',
    expires_in: UTS_ACCESS_TOKEN_LIFETIME_SECONDS,
    audience: claimSet.aud,
    scope: claimSet.scope,
  }));
  const [first] = issued;
  return {
    access_token: first.access_token,
    token_type: 'Bearer',
    expires_in: UTS_ACCESS_TOKEN_LIFETIME_SECONDS,
    scope: first.scope,
    issued_tokens: issued,
    ...(refresh === null
      ? {}
      : {
          refresh_token: refresh.token,
          refresh_token_expires_in: Math.max(
            1,
            Math.floor((refresh.expiresAt.getTime() - nowMs) / 1000)
          ),
        }),
  };
}
