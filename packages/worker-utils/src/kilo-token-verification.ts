import { jwtVerify } from 'jose';
import type { JWTPayload } from 'jose';
import { validateCloudAgentAuthorityClaims } from './cloud-agent-authority';

/**
 * Verifies a Kilo JWT signature with the algorithm set every Kilo verifier uses.
 *
 * `currentDate` pins the clock jose validates against; omit it to use the system
 * clock. `audience` and `issuer` delegate those claim checks to jose; omit each
 * to skip it. Each verifier passes only what its own contract requires.
 */
export async function verifyKiloTokenSignature(
  token: string,
  secret: string,
  options?: { currentDate?: Date; audience?: string; issuer?: string }
): Promise<{ payload: JWTPayload }> {
  const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
    algorithms: ['HS256'],
    ...(options?.currentDate === undefined ? {} : { currentDate: options.currentDate }),
    ...(options?.audience === undefined ? {} : { audience: options.audience }),
    ...(options?.issuer === undefined ? {} : { issuer: options.issuer }),
  });
  return { payload };
}

/**
 * Validates the `cloudAgentAuthority` claim when the token carries it, and
 * reports whether it was present. A token without the claim passes through
 * untouched.
 */
export function checkKiloTokenAuthorityClaims(payload: JWTPayload): boolean {
  if (!Object.hasOwn(payload, 'cloudAgentAuthority')) return false;
  validateCloudAgentAuthorityClaims(payload);
  return true;
}

export function assertKiloTokenIssuedAt(iat: unknown, nowSeconds: number): void {
  if (typeof iat !== 'number' || iat > nowSeconds) throw new Error('Token issued in the future');
}
