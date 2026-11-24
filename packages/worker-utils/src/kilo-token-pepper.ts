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

/**
 * For verifiers that accept only user credentials, such as the web gateway. No internal assertion
 * is addressed to them, so an absent claim is refused.
 */
export function isKiloUserCredentialPepperCurrent(
  claims: Pick<KiloTokenPepperClaims, 'apiTokenPepper'>,
  accountPepper: string | null | undefined
): boolean {
  return claims.apiTokenPepper !== undefined && claims.apiTokenPepper === (accountPepper ?? null);
}

/**
 * For Worker verifiers that also receive internal assertions minted by the web and other Workers.
 */
export function isKiloTokenPepperCurrent(
  claims: KiloTokenPepperClaims,
  accountPepper: string | null | undefined
): boolean {
  if (claims.apiTokenPepper !== undefined) {
    return isKiloUserCredentialPepperCurrent(claims, accountPepper);
  }
  return isShortLivedInternalAssertion(claims) || isLegacyShortLivedInternalAssertion(claims);
}

function isShortLivedInternalAssertion(claims: KiloTokenPepperClaims): boolean {
  return (
    claims.tokenPurpose === 'internal-service' &&
    hasAudience(claims.aud) &&
    hasShortLifetime(claims)
  );
}

/**
 * Temporary. The web mints this legacy shape (no `tokenPurpose`, no pepper, at most one hour)
 * from `generateBoundedInternalServiceToken` while `BOUNDED_INTERNAL_SERVICE_TOKENS_ENABLED` is
 * not `true`, and always from `generateInternalServiceToken`. Remove this branch when the flag is
 * on in production (or that fallback is removed), `generateInternalServiceToken` has no callers,
 * and one hour has passed since the last legacy mint.
 */
function isLegacyShortLivedInternalAssertion(claims: KiloTokenPepperClaims): boolean {
  return claims.tokenPurpose === undefined && hasShortLifetime(claims);
}

function hasAudience(aud: unknown): boolean {
  if (typeof aud === 'string') return aud.length > 0;
  return Array.isArray(aud) && aud.length > 0;
}

function hasShortLifetime({ iat, exp }: KiloTokenPepperClaims): boolean {
  if (typeof iat !== 'number' || typeof exp !== 'number') return false;
  const lifetime = exp - iat;
  return lifetime > 0 && lifetime <= INTERNAL_ASSERTION_MAX_LIFETIME_SECONDS;
}
