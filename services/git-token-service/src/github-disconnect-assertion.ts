import { base64urlToBytes } from '@kilocode/worker-utils/base64url';
import { GITHUB_USER_AUTHORIZATION_DISCONNECT_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import { isKiloResourceAudienceAllowed } from '@kilocode/worker-utils/kilo-token-policy';

const MAX_LIFETIME_SECONDS = 5 * 60;
const ISSUED_AT_CLOCK_SKEW_SECONDS = 60;

/**
 * The disconnect route receives only the web's five-minute internal assertion, which carries no
 * pepper claim. A token with a pepper claim is a user credential and is refused, so a revoked user
 * token cannot disconnect an authorization. Call this only after the signature is verified.
 */
export function isGitHubDisconnectAssertion(verifiedToken: string, nowSeconds: number): boolean {
  const claims = signedClaims(verifiedToken);
  if (claims === null || 'apiTokenPepper' in claims) return false;
  const { iat, exp } = claims;
  if (typeof iat !== 'number' || typeof exp !== 'number') return false;
  const lifetime = exp - iat;
  if (
    lifetime <= 0 ||
    lifetime > MAX_LIFETIME_SECONDS ||
    iat > nowSeconds + ISSUED_AT_CLOCK_SKEW_SECONDS
  ) {
    return false;
  }
  if (claims.aud !== undefined) {
    return isKiloResourceAudienceAllowed(claims.aud, {
      audience: GITHUB_USER_AUTHORIZATION_DISCONNECT_AUDIENCE,
      mode: 'required',
    });
  }
  // Temporary: the legacy shape while BOUNDED_INTERNAL_SERVICE_TOKENS_ENABLED is off. Remove with
  // the legacy branch of `isKiloTokenPepperCurrent`.
  return claims.tokenPurpose === undefined;
}

function signedClaims(token: string): Record<string, unknown> | null {
  try {
    const decoded: unknown = JSON.parse(
      new TextDecoder().decode(base64urlToBytes(token.split('.')[1] ?? ''))
    );
    return decoded !== null && typeof decoded === 'object' && !Array.isArray(decoded)
      ? Object.fromEntries(Object.entries(decoded))
      : null;
  } catch {
    return null;
  }
}
