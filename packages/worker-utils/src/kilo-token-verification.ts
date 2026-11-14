import { jwtVerify } from 'jose';
import type { JWTPayload } from 'jose';
import { validateCloudAgentAuthorityClaims } from './cloud-agent-authority';

/**
 * Verifies a Kilo JWT signature with the algorithm set every Kilo verifier uses.
 *
 * `currentDate` pins the clock jose validates against; omit it to use the system
 * clock. `audience` delegates audience matching to jose; omit it to skip that
 * check. Each verifier passes only what its own contract requires.
 */
export async function verifyKiloTokenSignature(
  token: string,
  secret: string,
  options?: { currentDate?: Date; audience?: string }
): Promise<{ payload: JWTPayload }> {
  const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
    algorithms: ['HS256'],
    ...(options?.currentDate === undefined ? {} : { currentDate: options.currentDate }),
    ...(options?.audience === undefined ? {} : { audience: options.audience }),
  });
  return { payload };
}

/**
 * Validates the `cloudAgentAuthority` claim when the token carries it. A token
 * without the claim passes through untouched.
 */
export function assertKiloTokenAuthorityClaims(payload: JWTPayload): void {
  if (Object.hasOwn(payload, 'cloudAgentAuthority')) {
    validateCloudAgentAuthorityClaims(payload);
  }
}

/** Refuses a token whose `iat` is missing or later than `nowSeconds`. */
export function assertKiloTokenIssuedAt(iat: unknown, nowSeconds: number): void {
  if (typeof iat !== 'number' || iat > nowSeconds) throw new Error('Token issued in the future');
}
