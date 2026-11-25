import { GITHUB_USER_AUTHORIZATION_DISCONNECT_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import {
  isKiloClaimlessInternalAssertion,
  signedKiloTokenClaims,
} from '@kilocode/worker-utils/kilo-token-pepper';

/**
 * The disconnect route receives only the web's five-minute internal assertion, which carries no
 * pepper claim. A token with a pepper claim is a user credential and is refused, so a revoked user
 * token cannot disconnect an authorization. Call this only after the signature is verified.
 */
export function isGitHubDisconnectAssertion(verifiedToken: string, nowSeconds: number): boolean {
  return isKiloClaimlessInternalAssertion(
    signedKiloTokenClaims(verifiedToken),
    { maxLifetimeSeconds: 5 * 60, audience: GITHUB_USER_AUTHORIZATION_DISCONNECT_AUDIENCE },
    nowSeconds
  );
}
