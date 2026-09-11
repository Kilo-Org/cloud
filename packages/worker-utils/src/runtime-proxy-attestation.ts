import { jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';

export const RUNTIME_PROXY_ATTESTATION_HEADER = 'X-Kilo-Runtime-Proxy-Attestation';
export const RUNTIME_PROXY_ATTESTATION_ISSUER = 'kilocode-runtime-proxy';
export const RUNTIME_PROXY_ATTESTATION_TYPE = 'cloud-agent-next-runtime-proxy';
export const RUNTIME_PROXY_ATTESTATION_VERSION = 1;
export const RUNTIME_PROXY_ATTESTATION_MAX_AGE_SECONDS = 30;

export const RuntimeProxyAttestationAudienceSchema = z.enum([
  'kilo-api',
  'kilo-gateway',
  'session-ingest',
]);
export type RuntimeProxyAttestationAudience = z.infer<typeof RuntimeProxyAttestationAudienceSchema>;

export const CloudAgentNextRuntimeAuthorizationClaimSchema = z
  .object({
    id: z.string().uuid(),
    resourceKind: z.literal('cloud-agent-next'),
    resourceId: z.string().min(1),
  })
  .strict();
export type CloudAgentNextRuntimeAuthorizationClaim = z.infer<
  typeof CloudAgentNextRuntimeAuthorizationClaimSchema
>;

const runtimeProxyAttestationClaims = z
  .object({
    iss: z.literal(RUNTIME_PROXY_ATTESTATION_ISSUER),
    type: z.literal(RUNTIME_PROXY_ATTESTATION_TYPE),
    version: z.literal(RUNTIME_PROXY_ATTESTATION_VERSION),
    aud: RuntimeProxyAttestationAudienceSchema,
    userId: z.string().min(1),
    authorizationId: z.string().uuid(),
    resourceId: z.string().min(1),
    bearerDigest: z.string().regex(/^[a-f0-9]{64}$/),
    iat: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
  })
  .strict()
  .superRefine((claims, ctx) => {
    if (
      claims.exp <= claims.iat ||
      claims.exp - claims.iat > RUNTIME_PROXY_ATTESTATION_MAX_AGE_SECONDS
    ) {
      ctx.addIssue({ code: 'custom', message: 'Invalid runtime proxy attestation lifetime' });
    }
  });

export type RuntimeProxyAttestationClaims = z.infer<typeof runtimeProxyAttestationClaims>;

async function bearerDigest(bearer: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(bearer));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function signingKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function issueRuntimeProxyAttestation(input: {
  secret: string;
  audience: RuntimeProxyAttestationAudience;
  userId: string;
  authorizationId: string;
  resourceId: string;
  bearer: string;
  now?: Date;
}): Promise<string> {
  const now = input.now ?? new Date();
  const issuedAt = Math.floor(now.getTime() / 1000);
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 0)
    throw new Error('Invalid attestation issuance time');
  const claims = runtimeProxyAttestationClaims.parse({
    iss: RUNTIME_PROXY_ATTESTATION_ISSUER,
    type: RUNTIME_PROXY_ATTESTATION_TYPE,
    version: RUNTIME_PROXY_ATTESTATION_VERSION,
    aud: RuntimeProxyAttestationAudienceSchema.parse(input.audience),
    userId: input.userId,
    authorizationId: input.authorizationId,
    resourceId: input.resourceId,
    bearerDigest: await bearerDigest(input.bearer),
    iat: issuedAt,
    exp: issuedAt + RUNTIME_PROXY_ATTESTATION_MAX_AGE_SECONDS,
  });
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt(claims.iat)
    .setExpirationTime(claims.exp)
    .setIssuer(claims.iss)
    .setAudience(claims.aud)
    .sign(signingKey(input.secret));
}

export async function verifyRuntimeProxyAttestation(input: {
  value: string | null | undefined;
  secret: string;
  audience: RuntimeProxyAttestationAudience;
  userId: string;
  authorizationId: string;
  resourceId: string;
  bearer: string;
  now?: Date;
}): Promise<boolean> {
  if (!input.value || input.value.length > 4096) return false;
  try {
    const { payload } = await jwtVerify(input.value, signingKey(input.secret), {
      algorithms: ['HS256'],
      issuer: RUNTIME_PROXY_ATTESTATION_ISSUER,
      audience: input.audience,
      currentDate: input.now,
    });
    const claims = runtimeProxyAttestationClaims.parse(payload);
    return (
      claims.aud === input.audience &&
      claims.userId === input.userId &&
      claims.authorizationId === input.authorizationId &&
      claims.resourceId === input.resourceId &&
      claims.bearerDigest === (await bearerDigest(input.bearer))
    );
  } catch {
    return false;
  }
}
