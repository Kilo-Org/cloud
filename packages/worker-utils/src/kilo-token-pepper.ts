import { decodeJwt } from 'jose';
import { isKiloResourceAudienceAllowed } from './kilo-token-policy';

/**
 * The current-pepper rule for Kilo tokens. A pepper rotation must revoke every user credential,
 * so a present `apiTokenPepper` claim (a string or `null`) must equal the account's current
 * pepper. Only a short-lived server-minted internal assertion may omit the claim.
 */

export type KiloTokenPepperClaims = {
  apiTokenPepper?: string | null;
  tokenPurpose?: unknown;
  aud?: unknown;
  iat?: unknown;
  exp?: unknown;
};

export type KiloClaimlessAssertionClaims = Omit<KiloTokenPepperClaims, 'apiTokenPepper'> & {
  apiTokenPepper?: unknown;
};

export type KiloInternalAssertionPolicy = {
  maxLifetimeSeconds: number;
  /** When set, an assertion with an audience must name this one. */
  audience?: string;
};

const SESSION_INGEST_ASSERTION_POLICY: KiloInternalAssertionPolicy = {
  maxLifetimeSeconds: 60 * 60,
};
const ISSUED_AT_CLOCK_SKEW_SECONDS = 60;

/**
 * For verifiers that accept only user credentials: the web gateway and every Worker that no
 * internal assertion is addressed to. An absent claim is refused.
 */
export function isKiloUserCredentialPepperCurrent(
  claims: Pick<KiloTokenPepperClaims, 'apiTokenPepper'>,
  accountPepper: string | null | undefined
): boolean {
  return claims.apiTokenPepper !== undefined && claims.apiTokenPepper === (accountPepper ?? null);
}

/**
 * Only for receivers that internal assertions minted by the web and other Workers are addressed
 * to, such as Session Ingest.
 */
export function isKiloTokenPepperCurrent(
  claims: KiloTokenPepperClaims,
  accountPepper: string | null | undefined,
  nowSeconds: number
): boolean {
  if (claims.apiTokenPepper !== undefined) {
    return isKiloUserCredentialPepperCurrent(claims, accountPepper);
  }
  return isKiloClaimlessInternalAssertion(claims, SESSION_INGEST_ASSERTION_POLICY, nowSeconds);
}

/**
 * A server-minted internal assertion without a pepper claim: it lives at most
 * `maxLifetimeSeconds`, its `iat` is at most 60 seconds ahead, and it is either
 * `tokenPurpose: 'internal-service'` with an audience or the temporary legacy shape.
 */
export function isKiloClaimlessInternalAssertion(
  claims: KiloClaimlessAssertionClaims,
  policy: KiloInternalAssertionPolicy,
  nowSeconds: number
): boolean {
  if (claims.apiTokenPepper !== undefined) return false;
  if (!hasShortValidity(claims, policy.maxLifetimeSeconds, nowSeconds)) return false;
  if (claims.aud !== undefined && !hasPolicyAudience(claims.aud, policy)) return false;
  if (claims.tokenPurpose === 'internal-service') return claims.aud !== undefined;
  return isLegacyInternalAssertion(claims);
}

/** The signed claims of a token whose signature the caller has already verified. */
export function signedKiloTokenClaims(verifiedToken: string): KiloClaimlessAssertionClaims {
  return decodeJwt(verifiedToken);
}

/**
 * Temporary. The web mints this legacy shape (no `tokenPurpose`, no pepper, with or without an
 * audience) from `generateBoundedInternalServiceToken` while `BOUNDED_INTERNAL_SERVICE_TOKENS_ENABLED`
 * is not `true`. Remove this branch one hour after the flag is on in production.
 */
function isLegacyInternalAssertion(claims: KiloClaimlessAssertionClaims): boolean {
  return claims.tokenPurpose === undefined;
}

function hasPolicyAudience(aud: unknown, policy: KiloInternalAssertionPolicy): boolean {
  if (policy.audience !== undefined) {
    return isKiloResourceAudienceAllowed(aud, { audience: policy.audience, mode: 'required' });
  }
  if (typeof aud === 'string') return aud.length > 0;
  return Array.isArray(aud) && aud.length > 0;
}

// A future `iat` must not stretch the remaining validity past the lifetime bound.
function hasShortValidity(
  { iat, exp }: KiloClaimlessAssertionClaims,
  maxLifetimeSeconds: number,
  nowSeconds: number
): boolean {
  if (typeof iat !== 'number' || typeof exp !== 'number') return false;
  const lifetime = exp - iat;
  return (
    lifetime > 0 &&
    lifetime <= maxLifetimeSeconds &&
    iat <= nowSeconds + ISSUED_AT_CLOCK_SKEW_SECONDS &&
    exp - nowSeconds <= maxLifetimeSeconds
  );
}
