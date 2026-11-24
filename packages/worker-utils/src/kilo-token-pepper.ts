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

const INTERNAL_ASSERTION_MAX_LIFETIME_SECONDS = 60 * 60;
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
  return (
    hasShortValidity(claims, nowSeconds) &&
    (isInternalServiceAssertion(claims) || isLegacyInternalAssertion(claims))
  );
}

function isInternalServiceAssertion(claims: KiloTokenPepperClaims): boolean {
  return claims.tokenPurpose === 'internal-service' && hasAudience(claims.aud);
}

/**
 * Temporary. The web mints this legacy shape (no `tokenPurpose`, no pepper, at most one hour)
 * from `generateBoundedInternalServiceToken` while `BOUNDED_INTERNAL_SERVICE_TOKENS_ENABLED` is
 * not `true`, and always from `generateInternalServiceToken`. Remove this branch when the flag is
 * on in production (or that fallback is removed), `generateInternalServiceToken` has no callers,
 * and one hour has passed since the last legacy mint.
 */
function isLegacyInternalAssertion(claims: KiloTokenPepperClaims): boolean {
  return claims.tokenPurpose === undefined;
}

function hasAudience(aud: unknown): boolean {
  if (typeof aud === 'string') return aud.length > 0;
  return Array.isArray(aud) && aud.length > 0;
}

// A future `iat` must not stretch the remaining validity past the lifetime bound.
function hasShortValidity({ iat, exp }: KiloTokenPepperClaims, nowSeconds: number): boolean {
  if (typeof iat !== 'number' || typeof exp !== 'number') return false;
  const lifetime = exp - iat;
  return (
    lifetime > 0 &&
    lifetime <= INTERNAL_ASSERTION_MAX_LIFETIME_SECONDS &&
    iat <= nowSeconds + ISSUED_AT_CLOCK_SKEW_SECONDS &&
    exp - nowSeconds <= INTERNAL_ASSERTION_MAX_LIFETIME_SECONDS
  );
}
