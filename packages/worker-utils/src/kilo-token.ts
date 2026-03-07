import { jwtVerify } from 'jose';
import { z } from 'zod';

/**
 * All known fields that can appear in a Kilo user JWT, sourced from
 * generateApiToken() / generateOrganizationApiToken() in src/lib/tokens.ts.
 * All optional fields beyond version+kiloUserId default to undefined when absent.
 */
export const kiloTokenPayload = z.object({
  // Core — always present
  version: z.literal(3),
  kiloUserId: z.string().min(1),
  // Present in generateApiToken / generateOrganizationApiToken, absent in generateInternalServiceToken
  apiTokenPepper: z.string().nullable().optional(),
  env: z.string().optional(),
  // Optional extras from JWTTokenExtraPayload
  isAdmin: z.boolean().optional(),
  gastownAccess: z.boolean().optional(),
  botId: z.string().optional(),
  organizationId: z.string().optional(),
  organizationRole: z.enum(['owner', 'member', 'billing_manager']).optional(),
  internalApiUse: z.boolean().optional(),
  createdOnPlatform: z.string().optional(),
  tokenSource: z.string().optional(),
  deviceAuthRequestCode: z.string().optional(),
  // Standard JWT claims
  iat: z.number().optional(),
  exp: z.number().optional(),
});

export type KiloTokenPayload = z.infer<typeof kiloTokenPayload>;

/**
 * Verify a Kilo user JWT (HS256, version 3).
 *
 * Checks: signature, expiration (built into jose), version === 3, and that
 * kiloUserId is a non-empty string.
 *
 * @throws if the token is invalid, expired, or fails schema validation.
 */
export async function verifyKiloToken(token: string, secret: string): Promise<KiloTokenPayload> {
  const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
    algorithms: ['HS256'],
  });

  return kiloTokenPayload.parse(payload);
}
