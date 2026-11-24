import { SignJWT } from 'jose';
import { z } from 'zod';
import { ORGANIZATION_ROLES } from '@kilocode/app-shared/organizations';
import { CloudAgentAuthoritySchema } from './cloud-agent-authority';
import { KILO_TOKEN_VERSION } from './kilo-token-version';
import { CloudAgentNextRuntimeAuthorizationClaimSchema } from './runtime-proxy-attestation';
import { RuntimeAdmissionSchema } from './runtime-authorization-contract';
import {
  assertKiloTokenIssuedAt,
  checkKiloTokenAuthorityClaims,
  verifyKiloTokenSignature,
} from './kilo-token-verification';

export { KILO_TOKEN_VERSION };

/** The longest lifetime any Kilo token may be minted with: 30 days. */
export const KILO_TOKEN_MAX_LIFETIME_SECONDS = 30 * 24 * 60 * 60;

/**
 * Refuses to mint a token that would outlive the cap. Verification is not
 * affected: tokens issued with a longer lifetime before the cap stay valid.
 */
export function assertKiloTokenLifetimeWithinCap(expiresInSeconds: number): void {
  if (!(expiresInSeconds <= KILO_TOKEN_MAX_LIFETIME_SECONDS)) {
    throw new Error('Kilo token lifetime exceeds the 30-day limit');
  }
}
const organizationRole = z.enum(ORGANIZATION_ROLES);

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
  botId: z.string().optional(),
  organizationId: z.string().optional(),
  organizationRole: organizationRole.optional(),
  internalApiUse: z.boolean().optional(),
  createdOnPlatform: z.string().optional(),
  tokenSource: z.string().optional(),
  deviceAuthRequestCode: z.string().optional(),
  deviceSessionId: z.string().optional(),
  // Org memberships (baked into tokens to avoid DB lookups)
  orgMemberships: z.array(z.object({ orgId: z.string(), role: organizationRole })).optional(),
  runtimeAdmission: RuntimeAdmissionSchema.optional(),
  runtimeAuthorization: CloudAgentNextRuntimeAuthorizationClaimSchema.optional(),
  cloudAgentAuthority: CloudAgentAuthoritySchema.optional(),
  // Standard JWT claims
  iat: z.number().optional(),
  exp: z.number().optional(),
});

export type KiloTokenPayload = z.infer<typeof kiloTokenPayload>;
// `cloudAgentAuthority` is intentionally excluded: authority tokens are minted only by
// the policy path (signModernKiloToken / buildModernKiloTokenPayload in
// kilo-token-policy.ts), which enforces the delegated-workload binding. The strict
// parse makes that boundary a runtime refusal, not just a TypeScript one.
const signKiloTokenPayload = kiloTokenPayload
  .omit({ iat: true, exp: true, cloudAgentAuthority: true })
  .strict();

/**
 * Optional claims beyond the core fields (userId, pepper, version, env).
 * Derived from KiloTokenPayload so sign and verify stay in sync, minus
 * `cloudAgentAuthority`: that claim is minted only by the token policy path
 * (`signModernKiloToken`), and the strict sign schema rejects it here.
 */
export type SignKiloTokenExtra = Pick<
  KiloTokenPayload,
  | 'isAdmin'
  | 'botId'
  | 'organizationId'
  | 'organizationRole'
  | 'internalApiUse'
  | 'createdOnPlatform'
  | 'tokenSource'
  | 'deviceAuthRequestCode'
  | 'deviceSessionId'
  | 'orgMemberships'
  | 'runtimeAdmission'
  | 'runtimeAuthorization'
>;

export async function signKiloToken(params: {
  userId: string;
  /**
   * Omit (or pass `undefined`) to mint an internal assertion with no
   * `apiTokenPepper` claim. Workers accept such a token only while it lives at
   * most one hour (`isKiloTokenPepperCurrent`); an explicit `null` is compared
   * against the account's current pepper.
   */
  pepper?: string | null;
  secret: string;
  expiresInSeconds: number;
  audience?: string;
  env?: string;
  extra?: SignKiloTokenExtra;
}): Promise<{ token: string; expiresAt: string }> {
  assertKiloTokenLifetimeWithinCap(params.expiresInSeconds);
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

  let signer = new SignJWT(validatedPayload)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt(now)
    .setExpirationTime(exp);
  if (params.audience) signer = signer.setAudience(params.audience);
  const token = await signer.sign(new TextEncoder().encode(params.secret));

  return { token, expiresAt: new Date(exp * 1000).toISOString() };
}

/**
 * Verify a Kilo user JWT (HS256, version 3).
 *
 * Checks: signature, expiration (built into jose), version === 3, and that
 * kiloUserId is a non-empty string. When the token carries
 * `cloudAgentAuthority`, it also checks that `iat` is present and not in the
 * future.
 *
 * When `options.audience` is set, the token must have that exact audience.
 * When omitted, tokens that include an audience are rejected so a
 * purpose-bound service token cannot be replayed as a general user token.
 *
 * @throws if the token is invalid, expired, or fails schema validation.
 */
export async function verifyKiloToken(
  token: string,
  secret: string,
  options?: { audience?: string }
): Promise<KiloTokenPayload> {
  const { payload } = await verifyKiloTokenSignature(token, secret, {
    audience: options?.audience,
  });
  if (options?.audience === undefined && payload.aud !== undefined) {
    throw new Error('Unexpected token audience');
  }

  if (checkKiloTokenAuthorityClaims(payload)) {
    assertKiloTokenIssuedAt(payload.iat, Math.floor(Date.now() / 1000));
  }

  return kiloTokenPayload.parse(payload);
}
