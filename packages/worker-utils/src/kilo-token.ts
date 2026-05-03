import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';

export const KILO_TOKEN_VERSION = 3;

/**
 * All known fields that can appear in a Kilo user JWT, sourced from
 * generateApiToken() / generateOrganizationApiToken() in src/lib/tokens.ts.
 * All optional fields beyond version+kiloUserId default to undefined when absent.
 */
export const kiloTokenPayload = z.object({
  // Core — always present
  version: z.literal(KILO_TOKEN_VERSION),
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
  // Org memberships (baked into gastown tokens to avoid DB lookups)
  orgMemberships: z
    .array(z.object({ orgId: z.string(), role: z.enum(['owner', 'member', 'billing_manager']) }))
    .optional(),
  // Standard JWT claims
  iat: z.number().optional(),
  exp: z.number().optional(),
});

export type KiloTokenPayload = z.infer<typeof kiloTokenPayload>;
const signKiloTokenPayload = kiloTokenPayload.omit({ iat: true, exp: true }).strict();

/**
 * Optional claims beyond the core fields (userId, pepper, version, env).
 * Derived from KiloTokenPayload so sign and verify stay in sync.
 */
export type SignKiloTokenExtra = Pick<
  KiloTokenPayload,
  | 'isAdmin'
  | 'gastownAccess'
  | 'botId'
  | 'organizationId'
  | 'organizationRole'
  | 'internalApiUse'
  | 'createdOnPlatform'
  | 'tokenSource'
  | 'deviceAuthRequestCode'
  | 'orgMemberships'
>;

export async function signKiloToken(params: {
  userId: string;
  pepper: string | null;
  secret: string;
  expiresInSeconds: number;
  env?: string;
  extra?: SignKiloTokenExtra;
}): Promise<{ token: string; expiresAt: string }> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + params.expiresInSeconds;

  const payload: Record<string, unknown> = {
    kiloUserId: params.userId,
    apiTokenPepper: params.pepper,
    version: KILO_TOKEN_VERSION,
    ...params.extra,
  };

  if (params.env) {
    payload.env = params.env;
  }

  const validatedPayload = signKiloTokenPayload.parse(payload);

  const token = await new SignJWT(validatedPayload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(new TextEncoder().encode(params.secret));

  return { token, expiresAt: new Date(exp * 1000).toISOString() };
}

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
