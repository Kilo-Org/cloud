import { z } from 'zod';
import { StsEnvironmentSchema, WorkloadNameSchema, type StsEnvironment } from './bundle';

/**
 * Access-token contracts shared by the STS minter, the service-token client and the verification
 * library (`@kilocode/verify`). Design sections 5.3 (claims profile, scope model), 5.7 (signing
 * keys), 6.1-6.2 (service tokens) and 7 (verification).
 */

/** Signing algorithm of every access token; Ed25519 under JWS `EdDSA`. */
export const ACCESS_TOKEN_ALGORITHM = 'EdDSA';
/** JWS `typ` of every access token (RFC 9068 section 2.1). */
export const ACCESS_TOKEN_TYPE = 'at+jwt';

/** STS service tokens live 5 minutes, capped by STS at the source attestation's own `exp`. */
export const SERVICE_TOKEN_LIFETIME_SECONDS = 300;
/** A service-token client renews at 80 % of the token lifetime. */
export const SERVICE_TOKEN_RENEW_FRACTION = 0.8;
/** Skew a verifier allows on `exp`, `iat` and `nbf`. */
export const TOKEN_CLOCK_SKEW_SECONDS = 60;
/** One mint call issues at most this many tokens, one per audience. */
export const MAX_AUDIENCES_PER_MINT = 8;

/** Path of the public key set under an issuer URL. */
export const JWKS_PATH = '/.well-known/jwks.json';

/** The `iss` of STS-issued tokens, per environment; equals `STS_ISSUER` in `services/sts/wrangler.jsonc`. */
export const STS_ISSUERS: Readonly<Record<StsEnvironment, string>> = {
  development: 'http://localhost:8825',
  staging: 'https://sts-staging.kiloapps.io',
  production: 'https://sts.kiloapps.io',
};

/** A service that accepts tokens: one audience per token, never a list. */
export const AudienceSchema = z.string().regex(/^[a-z0-9-]+$/);
export type Audience = z.infer<typeof AudienceSchema>;

/** One permission on one service: `<audience>:<permission>`, such as `gateway:models.read`. */
export const ScopeSchema = z.string().regex(/^[a-z0-9-]+:[a-z0-9_.-]+$/);
export type Scope = z.infer<typeof ScopeSchema>;

/** The audience a scope belongs to: the part before the first `:`. */
export function scopeAudience(scope: string): string {
  const colon = scope.indexOf(':');
  return colon === -1 ? scope : scope.slice(0, colon);
}

/** Header of a signed access token. Other header parameters are tolerated. */
export const AccessTokenHeaderSchema = z.looseObject({
  alg: z.literal(ACCESS_TOKEN_ALGORITHM),
  typ: z.literal(ACCESS_TOKEN_TYPE),
  kid: z.string().min(1),
});
export type AccessTokenHeader = z.infer<typeof AccessTokenHeaderSchema>;

/** JWT NumericDate in whole seconds. */
const NumericDateSchema = z.number().int().nonnegative();

/** RFC 8693 actor: one entry per delegation hop, the outermost entry is the current actor. */
export type Actor = { sub: string; client_id?: string; act?: Actor };
export const ActorSchema: z.ZodType<Actor> = z.looseObject({
  sub: z.string().min(1),
  client_id: z.string().min(1).optional(),
  get act() {
    return ActorSchema.optional();
  },
});

/**
 * RFC 9068 claims plus Kilo's (design 5.3). Unknown claims are kept, never refused; known claims
 * are strict on type. `aud` is one string: an array is refused even when it names the verifier.
 */
export const AccessTokenClaimsSchema = z.looseObject({
  iss: z.string().min(1),
  exp: NumericDateSchema,
  aud: AudienceSchema,
  sub: z.string().min(1),
  client_id: z.string().min(1),
  iat: NumericDateSchema,
  jti: z.string().min(1),
  scope: ScopeSchema,
  nbf: NumericDateSchema.optional(),
  org: z.string().min(1).optional(),
  act: ActorSchema.optional(),
  req: z.string().min(1).optional(),
  sid: z.string().min(1).optional(),
  auth_time: NumericDateSchema.optional(),
  amr: z.array(z.string().min(1)).optional(),
  env: StsEnvironmentSchema,
});
export type AccessTokenClaims = z.infer<typeof AccessTokenClaimsSchema>;

/** `sub` of an STS service token: `service:<workload>`. */
export function serviceSubject(workload: string): string {
  return `service:${workload}`;
}

/**
 * The STS service-token profile (design 6.1): a service subject named after the calling workload,
 * no user, org or session claims, and a lifetime of at most `SERVICE_TOKEN_LIFETIME_SECONDS`.
 * STS also caps `exp` at the source attestation's `exp`; a verifier cannot see that attestation.
 */
export const ServiceTokenClaimsSchema = AccessTokenClaimsSchema.extend({
  client_id: WorkloadNameSchema,
  req: WorkloadNameSchema,
  org: z.never().optional(),
  act: z.never().optional(),
  sid: z.never().optional(),
  auth_time: z.never().optional(),
  amr: z.never().optional(),
}).superRefine((claims, ctx) => {
  if (claims.sub !== serviceSubject(claims.client_id)) {
    ctx.addIssue({ code: 'custom', path: ['sub'], message: 'sub must be service:<client_id>' });
  }
  if (claims.req !== claims.client_id) {
    ctx.addIssue({ code: 'custom', path: ['req'], message: 'req must equal client_id' });
  }
  if (claims.exp <= claims.iat || claims.exp - claims.iat > SERVICE_TOKEN_LIFETIME_SECONDS) {
    ctx.addIssue({
      code: 'custom',
      path: ['exp'],
      message: `lifetime must be 1..${SERVICE_TOKEN_LIFETIME_SECONDS} seconds`,
    });
  }
});
export type ServiceTokenClaims = z.infer<typeof ServiceTokenClaimsSchema>;

/**
 * A token-signing public key: Ed25519 only. A key set may hold other keys (a verifier skips any
 * entry this schema refuses); a token verifies only against an entry this schema accepts.
 */
export const Ed25519PublicJwkSchema = z.looseObject({
  kty: z.literal('OKP'),
  crv: z.literal('Ed25519'),
  x: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  kid: z.string().min(1),
  alg: z.literal(ACCESS_TOKEN_ALGORITHM).optional(),
  use: z.literal('sig').optional(),
});
export type Ed25519PublicJwk = z.infer<typeof Ed25519PublicJwkSchema>;

const MintEntrySchema = z
  .strictObject({ audience: AudienceSchema, scope: ScopeSchema })
  .refine(entry => scopeAudience(entry.scope) === entry.audience, {
    message: 'scope must belong to its audience',
    path: ['scope'],
  });

function refuseDuplicateAudiences(
  entries: readonly { audience: string }[],
  ctx: z.RefinementCtx
): void {
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    if (seen.has(entry.audience)) {
      ctx.addIssue({
        code: 'custom',
        path: ['tokens', index, 'audience'],
        message: 'one token per audience',
      });
    }
    seen.add(entry.audience);
  });
}

/** A mint call: 1..8 tokens, one per audience, each with exactly one scope of that audience. */
export const MintRequestSchema = z
  .strictObject({
    tokens: z.array(MintEntrySchema).min(1).max(MAX_AUDIENCES_PER_MINT),
  })
  .superRefine((request, ctx) => refuseDuplicateAudiences(request.tokens, ctx));
export type MintRequest = z.infer<typeof MintRequestSchema>;

/** Why STS refused one requested token; the other entries of the call are unaffected. */
export const MINT_DENIED_REASONS = [
  'unknown_workload',
  'audience_not_allowed',
  'scope_not_allowed',
  'unknown_scope',
  'attestation_expiring',
] as const;
export type MintDeniedReason = (typeof MINT_DENIED_REASONS)[number];

const IssuedTokenSchema = z.strictObject({
  status: z.literal('issued'),
  audience: AudienceSchema,
  scope: ScopeSchema,
  token: z.string().min(1),
  jti: z.string().min(1),
  /** The token's `exp`, in seconds. */
  expiresAt: NumericDateSchema,
});

const DeniedTokenSchema = z.strictObject({
  status: z.literal('denied'),
  audience: AudienceSchema,
  scope: ScopeSchema,
  reason: z.enum(MINT_DENIED_REASONS),
});

export const MintEntryResultSchema = z.discriminatedUnion('status', [
  IssuedTokenSchema,
  DeniedTokenSchema,
]);
export type MintEntryResult = z.infer<typeof MintEntryResultSchema>;
export type IssuedToken = z.infer<typeof IssuedTokenSchema>;

/** One result per requested token, in request order. */
const OkMintSchema = z
  .strictObject({
    status: z.literal('ok'),
    tokens: z.array(MintEntryResultSchema).min(1).max(MAX_AUDIENCES_PER_MINT),
  })
  .superRefine((result, ctx) => refuseDuplicateAudiences(result.tokens, ctx));

/** Retryable: STS could not answer; retry after `retryAfterSeconds`. */
const UnavailableMintSchema = z.strictObject({
  status: z.literal('unavailable'),
  retryAfterSeconds: z.number().int().positive().max(3600),
});

/** The caller's workload identity did not verify. */
const IdentityRejectedMintSchema = z.strictObject({ status: z.literal('identity_rejected') });

/** The request body did not pass `MintRequestSchema`. */
const InvalidRequestMintSchema = z.strictObject({ status: z.literal('invalid_request') });

export const MintResultSchema = z.discriminatedUnion('status', [
  OkMintSchema,
  UnavailableMintSchema,
  IdentityRejectedMintSchema,
  InvalidRequestMintSchema,
]);
export type MintResult = z.infer<typeof MintResultSchema>;

/** HTTP status of a mint answer for callers outside the Cloudflare account. */
export function mintResultHttpStatus(result: MintResult): 200 | 400 | 401 | 503 {
  switch (result.status) {
    case 'ok':
      return 200;
    case 'invalid_request':
      return 400;
    case 'identity_rejected':
      return 401;
    case 'unavailable':
      return 503;
  }
}
