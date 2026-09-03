import { jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';
import { KILO_API_AUDIENCE } from './internal-service-token-audiences';
import { KILO_TOKEN_VERSION, kiloTokenPayload } from './kilo-token';
import type { KiloTokenPayload } from './kilo-token';

const audienceName = z
  .string()
  .min(1)
  .refine(value => value.trim() === value);
const audienceClaim = z.union([
  audienceName,
  z
    .array(audienceName)
    .min(1)
    .refine(values => new Set(values).size === values.length),
]);
const numericDate = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const KILO_TOKEN_PURPOSES = [
  'human-api',
  'device-access',
  'delegated-workload',
  'internal-service',
] as const;
const purposeClaim = z.enum(KILO_TOKEN_PURPOSES);

const policyClaims = kiloTokenPayload
  .extend({
    aud: audienceClaim.optional(),
    iat: numericDate,
    exp: numericDate,
    tokenPurpose: purposeClaim.optional(),
    credentialExchange: z.boolean().optional(),
  })
  .superRefine((claims, ctx) => {
    if (claims.exp <= claims.iat) {
      ctx.addIssue({ code: 'custom', message: 'Expiration must follow issuance', path: ['exp'] });
    }
    if (claims.tokenPurpose !== undefined || claims.credentialExchange !== undefined) {
      if (
        claims.aud === undefined ||
        claims.tokenPurpose === undefined ||
        claims.credentialExchange === undefined
      ) {
        ctx.addIssue({
          code: 'custom',
          message: 'Modern tokens require audience, purpose and exchange eligibility',
        });
      }
    }
    if (claims.runtimeAdmission !== undefined && claims.runtimeAuthorization !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'Runtime admission and runtime authorization cannot coexist',
      });
    }
    if (claims.runtimeAdmission !== undefined) {
      const permittedPurpose =
        (claims.runtimeAdmission.source === 'user' &&
          (claims.tokenPurpose === 'human-api' || claims.tokenPurpose === 'device-access')) ||
        (claims.runtimeAdmission.source === 'automation' &&
          claims.tokenPurpose === 'internal-service');
      if (
        !permittedPurpose ||
        claims.credentialExchange !== false ||
        claims.apiTokenPepper === undefined ||
        claims.tokenPurpose === 'delegated-workload'
      ) {
        ctx.addIssue({ code: 'custom', message: 'Invalid runtime admission' });
      }
    }
    if (
      claims.runtimeAuthorization !== undefined &&
      (claims.tokenPurpose !== 'delegated-workload' || claims.credentialExchange !== false)
    ) {
      ctx.addIssue({ code: 'custom', message: 'Invalid runtime authorization reference' });
    }
    if (claims.credentialExchange === true && claims.tokenPurpose !== 'human-api') {
      ctx.addIssue({
        code: 'custom',
        message: 'Only human API tokens may permit credential exchange',
        path: ['credentialExchange'],
      });
    }
  });

export type KiloTokenPolicyClaims = z.infer<typeof policyClaims>;

export type KiloResourceAudiencePolicy = {
  audience: string;
  mode: 'required' | 'allow-legacy';
};

export function isKiloResourceAudienceAllowed(
  audience: unknown,
  policy: KiloResourceAudiencePolicy
): boolean {
  if (!audienceName.safeParse(policy.audience).success) return false;
  if (audience === undefined) return policy.mode === 'allow-legacy';
  const parsed = audienceClaim.safeParse(audience);
  if (!parsed.success) return false;
  return typeof parsed.data === 'string'
    ? parsed.data === policy.audience
    : parsed.data.includes(policy.audience);
}

export async function verifyKiloTokenForResource(
  token: string,
  secret: string,
  audiencePolicy: KiloResourceAudiencePolicy
): Promise<KiloTokenPayload> {
  const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
    algorithms: ['HS256'],
  });
  if (!isKiloResourceAudienceAllowed(payload.aud, audiencePolicy)) {
    throw new Error('Unexpected token audience');
  }
  return kiloTokenPayload.parse(payload);
}

const verifiedAuth = Symbol('verified-kilo-policy-auth');

type DeepReadonly<T> = { readonly [K in keyof T]: DeepReadonly<T[K]> };

function freezeClaimValue(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  for (const child of Object.values(value)) freezeClaimValue(child);
  Object.freeze(value);
}

type VerifiedKiloBearerContext = {
  readonly [verifiedAuth]: true;
  readonly type: 'bearer';
  readonly userId: string;
  readonly claims: DeepReadonly<KiloTokenPolicyClaims>;
  readonly claimNames: readonly string[];
};

type VerifiedKiloSessionContext = {
  readonly [verifiedAuth]: true;
  readonly type: 'session';
  readonly userId: string;
};

export type VerifiedKiloAuthContext = VerifiedKiloBearerContext | VerifiedKiloSessionContext;

// The private symbol brands the type; WeakSet membership checks verifier-created
// object identity so copied, serialized, or fabricated contexts cannot qualify.
const verifiedContexts = new WeakSet<VerifiedKiloAuthContext>();

export async function verifyKiloTokenForPolicy(
  token: string,
  secret: string,
  audiencePolicy: KiloResourceAudiencePolicy
): Promise<VerifiedKiloBearerContext> {
  const currentDate = new Date();
  const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
    algorithms: ['HS256'],
    currentDate,
  });
  const claims = policyClaims.parse(payload);
  if (claims.iat > Math.floor(currentDate.getTime() / 1000)) {
    throw new Error('Token issued in the future');
  }
  if (!isKiloResourceAudienceAllowed(claims.aud, audiencePolicy)) {
    throw new Error('Unexpected token audience');
  }
  freezeClaimValue(claims);
  const auth = Object.freeze({
    [verifiedAuth]: true,
    type: 'bearer',
    userId: claims.kiloUserId,
    claims,
    claimNames: Object.freeze(Object.keys(payload)),
  } satisfies VerifiedKiloBearerContext);
  verifiedContexts.add(auth);
  return auth;
}

export async function verifyKiloSessionForPolicy(
  verifySession: () => Promise<{ userId: string } | null>
): Promise<VerifiedKiloSessionContext | null> {
  const session = await verifySession();
  if (session === null) return null;
  const userId = z.string().min(1).parse(session.userId);
  const auth = Object.freeze({
    [verifiedAuth]: true,
    type: 'session',
    userId,
  } satisfies VerifiedKiloSessionContext);
  verifiedContexts.add(auth);
  return auth;
}

export const LEGACY_API_TOKEN_LIFETIMES_SECONDS = [157_680_000, 157_788_000] as const;

export type KiloCredentialExchangeEligibilityPolicy = {
  legacy: 'deny' | 'five-year-api';
};

const exchangeSafeClaimNames: ReadonlySet<string> = new Set([
  'version',
  'kiloUserId',
  'apiTokenPepper',
  'env',
  'iat',
  'exp',
  'aud',
  'tokenPurpose',
  'credentialExchange',
  'deviceAuthRequestCode',
] satisfies (keyof KiloTokenPolicyClaims)[]);

function hasOnlyExchangeSafeClaims(claimNames: readonly string[]): boolean {
  return claimNames.every(name => exchangeSafeClaimNames.has(name));
}

export function isKiloCredentialExchangeEligible(
  auth: VerifiedKiloAuthContext,
  policy: KiloCredentialExchangeEligibilityPolicy
): boolean {
  if (!verifiedContexts.has(auth)) return false;
  if (auth.type === 'session') return true;
  const { claims } = auth;
  const now = Math.floor(Date.now() / 1000);
  if (claims.iat > now || claims.exp <= now || claims.exp <= claims.iat) return false;
  if (claims.apiTokenPepper === undefined) return false;
  if (!hasOnlyExchangeSafeClaims(auth.claimNames)) return false;
  if (claims.tokenPurpose !== undefined || claims.credentialExchange !== undefined) {
    const soleAudience =
      typeof claims.aud === 'string'
        ? claims.aud
        : claims.aud?.length === 1
          ? claims.aud[0]
          : undefined;
    return (
      claims.tokenPurpose === 'human-api' &&
      claims.credentialExchange === true &&
      soleAudience === KILO_API_AUDIENCE
    );
  }
  return (
    policy.legacy === 'five-year-api' &&
    claims.aud === undefined &&
    LEGACY_API_TOKEN_LIFETIMES_SECONDS.some(lifetime => claims.exp - claims.iat === lifetime)
  );
}

const modernTokenExtra = kiloTokenPayload
  .omit({
    version: true,
    kiloUserId: true,
    apiTokenPepper: true,
    env: true,
    iat: true,
    exp: true,
  })
  .strict();

const modernPurpose = z.discriminatedUnion('tokenPurpose', [
  z.object({ tokenPurpose: z.literal('human-api'), credentialExchange: z.boolean() }),
  z.object({
    tokenPurpose: purposeClaim.exclude(['human-api']),
    credentialExchange: z.literal(false),
  }),
]);

export type ModernKiloTokenPurpose = z.infer<typeof modernPurpose>;

const modernClaims = policyClaims
  .safeExtend({
    aud: audienceClaim,
    tokenPurpose: purposeClaim,
    credentialExchange: z.boolean(),
  })
  .and(modernPurpose)
  .superRefine((claims, ctx) => {
    if (!claims.credentialExchange) return;
    const serializedClaimNames = Object.entries(claims)
      .filter(([, value]) => value !== undefined)
      .map(([name]) => name);
    if (
      (typeof claims.aud === 'string'
        ? claims.aud !== KILO_API_AUDIENCE
        : claims.aud.length !== 1 || claims.aud[0] !== KILO_API_AUDIENCE) ||
      claims.apiTokenPepper === undefined ||
      !hasOnlyExchangeSafeClaims(serializedClaimNames)
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Exchangeable tokens require the Kilo API audience, a pepper claim and only exchange-safe claims',
      });
    }
  });

export type ModernKiloTokenClaims = z.infer<typeof modernClaims>;

const positiveSafeInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

type ModernKiloTokenSigningPurpose =
  | { tokenPurpose: 'human-api'; credentialExchange: boolean }
  | {
      tokenPurpose: Exclude<ModernKiloTokenPurpose['tokenPurpose'], 'human-api'>;
      credentialExchange: false;
    };

export type SignModernKiloTokenParams = {
  userId: string;
  secret: string;
  expiresInSeconds: number;
  pepper?: string | null;
  env?: string;
  audience: string | string[];
  extra?: z.infer<typeof modernTokenExtra>;
} & ModernKiloTokenSigningPurpose;

export function buildModernKiloTokenPayload(
  params: {
    userId: string;
    pepper?: string | null;
    env?: string;
    audience: string | string[];
    issuedAt: number;
    expiresAt: number;
    extra?: z.infer<typeof modernTokenExtra>;
  } & ModernKiloTokenPurpose
): ModernKiloTokenClaims {
  const extra = modernTokenExtra.parse(params.extra ?? {});
  const audience = audienceClaim.parse(params.audience);
  const claims = {
    ...extra,
    version: KILO_TOKEN_VERSION,
    kiloUserId: params.userId,
    apiTokenPepper: params.pepper,
    env: params.env,
    aud: audience,
    iat: params.issuedAt,
    exp: params.expiresAt,
    tokenPurpose: params.tokenPurpose,
    credentialExchange: params.credentialExchange,
  };
  return modernClaims.parse(claims);
}

export async function signModernKiloToken(
  params: SignModernKiloTokenParams
): Promise<{ token: string; expiresAt: string }> {
  const expiresInSeconds = positiveSafeInteger.parse(params.expiresInSeconds);
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + expiresInSeconds;
  if (!Number.isSafeInteger(expiresAt)) {
    throw new Error('Token expiration exceeds the safe integer range');
  }

  const payloadParams = {
    userId: params.userId,
    pepper: params.pepper,
    env: params.env,
    audience: params.audience,
    issuedAt,
    expiresAt,
    extra: params.extra,
  };
  const payload =
    params.tokenPurpose === 'human-api'
      ? buildModernKiloTokenPayload({
          ...payloadParams,
          tokenPurpose: 'human-api',
          credentialExchange: params.credentialExchange,
        })
      : buildModernKiloTokenPayload({
          ...payloadParams,
          tokenPurpose: params.tokenPurpose,
          credentialExchange: params.credentialExchange,
        });
  const expiresAtIso = new Date(expiresAt * 1000).toISOString();
  const token = await new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .sign(new TextEncoder().encode(params.secret));

  return { token, expiresAt: expiresAtIso };
}
