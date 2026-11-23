import { SignJWT } from 'jose';
import { z } from 'zod';
import { verifyKiloTokenSignature } from './kilo-token-verification';
import { sha256Hex } from './sha256';

export const RUNTIME_PROXY_ATTESTATION_HEADER = 'X-Kilo-Runtime-Proxy-Attestation';
export const RUNTIME_PROXY_ATTESTATION_ISSUER = 'kilocode-runtime-proxy';
export const RUNTIME_PROXY_ATTESTATION_TYPE = 'cloud-agent-next-runtime-proxy';
export const RUNTIME_PROXY_ATTESTATION_VERSION = 1;
export const RUNTIME_PROXY_ATTESTATION_MAX_AGE_SECONDS = 30;
/** Verifiers accept longer signed lifetimes so they can deploy before issuers extend them. */
export const RUNTIME_PROXY_ATTESTATION_MAX_ACCEPTED_AGE_SECONDS = 120;
/** Sanity bound on the untrusted header value in characters, checked before any JWT parsing runs. */
export const RUNTIME_PROXY_ATTESTATION_MAX_VALUE_LENGTH = 4096;

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
      claims.exp - claims.iat > RUNTIME_PROXY_ATTESTATION_MAX_ACCEPTED_AGE_SECONDS
    ) {
      ctx.addIssue({ code: 'custom', message: 'Invalid runtime proxy attestation lifetime' });
    }
  });

export type RuntimeProxyAttestationClaims = z.infer<typeof runtimeProxyAttestationClaims>;

function signingKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export type RuntimeProxyAttestationSubject = {
  secret: string;
  audience: RuntimeProxyAttestationAudience;
  userId: string;
  authorizationId: string;
  resourceId: string;
  bearer: string;
  now?: Date;
};

export async function issueRuntimeProxyAttestation(
  input: RuntimeProxyAttestationSubject
): Promise<string> {
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
    bearerDigest: await sha256Hex(input.bearer),
    iat: issuedAt,
    exp: issuedAt + RUNTIME_PROXY_ATTESTATION_MAX_AGE_SECONDS,
  });
  // The schema allows up to 120 seconds for verifiers, so issuance enforces its own lifetime.
  if (claims.exp - claims.iat !== RUNTIME_PROXY_ATTESTATION_MAX_AGE_SECONDS) {
    throw new Error('Invalid issued runtime proxy attestation lifetime');
  }
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .sign(signingKey(input.secret));
}

export async function verifyRuntimeProxyAttestation(
  input: RuntimeProxyAttestationSubject & { value: string | null | undefined }
): Promise<boolean> {
  if (!input.value || input.value.length > RUNTIME_PROXY_ATTESTATION_MAX_VALUE_LENGTH) return false;
  try {
    const { payload } = await verifyKiloTokenSignature(input.value, input.secret, {
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
      claims.bearerDigest === (await sha256Hex(input.bearer))
    );
  } catch {
    return false;
  }
}
