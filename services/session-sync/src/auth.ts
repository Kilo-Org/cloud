import { getWorkerDb, type WorkerDb } from '@kilocode/db/client';
import { device_sessions, kilocode_users } from '@kilocode/db/schema';
import { readBoundedStream } from '@kilocode/worker-utils/bounded-stream-reader';
import { extractBearerToken } from '@kilocode/worker-utils/extract-bearer-token';
import { KILO_API_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import {
  isKiloCredentialExchangeEligible,
  verifyKiloTokenForPolicy,
} from '@kilocode/worker-utils/kilo-token-policy';
import { hasOrganizationAccess } from '@kilocode/worker-utils/organization-membership';
import { and, eq, isNull } from 'drizzle-orm';
import { jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';

import { exchangeRequestSchema, principalSchema, type Principal } from './protocol';

export type { Principal };

/** A Secrets Store binding in deployment, or a plain string from local vars. */
export type SecretBinding = string | { get(): Promise<string | null> };

export type AuthEnv = {
  NEXTAUTH_SECRET: SecretBinding;
  SESSION_SYNC_SECRET: SecretBinding;
  HYPERDRIVE: Hyperdrive;
  ENVIRONMENT?: string;
};

const GRANT_ISSUER = 'session-sync';
const GRANT_AUDIENCE = 'session-sync';
const GRANT_TTL_SECONDS = 60;
const MIN_GRANT_SECRET_BYTES = 32;
const MAX_EXCHANGE_BODY_BYTES = 1024;

// A device-bound legacy credential carries the one-hour access lifetime or the
// fixed five-year lifetime; both require a live device session.
const LEGACY_DEVICE_LIFETIMES_SECONDS: readonly number[] = [60 * 60, 157_680_000];

const LEGACY_CLAIMS: Record<string, true> = {
  version: true,
  kiloUserId: true,
  apiTokenPepper: true,
  env: true,
  iat: true,
  exp: true,
  deviceAuthRequestCode: true,
  deviceSessionId: true,
};

const MODERN_CLAIMS: Record<string, true> = {
  version: true,
  kiloUserId: true,
  apiTokenPepper: true,
  env: true,
  aud: true,
  iat: true,
  exp: true,
  tokenPurpose: true,
  credentialExchange: true,
  deviceSessionId: true,
};

const numericDate = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

// The principal is validated separately so grants and exchange share one schema.
const grantClaims = z
  .strictObject({
    version: z.literal(1),
    iss: z.literal(GRANT_ISSUER),
    aud: z.literal(GRANT_AUDIENCE),
    sub: z.string(),
    iat: numericDate,
    exp: numericDate,
    tenant: z.unknown(),
  })
  .refine(claims => claims.exp > claims.iat && claims.exp - claims.iat <= GRANT_TTL_SECONDS);

type ExchangeBody = z.infer<typeof exchangeRequestSchema>;

type Credential = {
  userID: string;
  pepper: string | null;
  expiresAt: number;
  deviceSessionID: string | undefined;
};

// Holds resolved values only. A pending get() belongs to the request that
// started it and is never shared with another request.
const resolvedSecrets = new WeakMap<object, string>();

async function resolveSecret(binding: SecretBinding, minBytes: number): Promise<string> {
  const value =
    typeof binding === 'string' ? binding : (resolvedSecrets.get(binding) ?? (await binding.get()));
  if (!value || new TextEncoder().encode(value).byteLength < minBytes) {
    throw new Error('Secret is not configured');
  }
  if (typeof binding !== 'string') resolvedSecrets.set(binding, value);
  return value;
}

function failure(status: number, code: string, message: string): Response {
  return Response.json(
    { error: { code, message } },
    { status, headers: { 'Cache-Control': 'no-store' } }
  );
}

function invalidCredential(message = 'The Kilo credential is invalid or expired'): Response {
  return failure(401, 'invalid_credential', message);
}

function unsupportedCredential(message: string): Response {
  return failure(403, 'unsupported_credential', message);
}

function unavailable(operation: 'exchange' | 'authorize', error: unknown): Response {
  console.error('Session sync auth dependency failure', {
    operation,
    errorClass: error instanceof Error ? error.name : typeof error,
  });
  return failure(503, 'auth_unavailable', 'Authentication is temporarily unavailable');
}

async function readExchangeBody(request: Request): Promise<ExchangeBody | Response> {
  let text: string;
  try {
    if (!request.body) return failure(400, 'invalid_request', 'A JSON body is required');
    const read = await readBoundedStream(
      request.body as ReadableStream<Uint8Array>,
      MAX_EXCHANGE_BODY_BYTES
    );
    if (!read.ok) return failure(413, 'payload_too_large', 'The request body is too large');
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(read.bytes);
  } catch {
    return failure(400, 'invalid_request', 'The request body could not be read');
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return failure(400, 'invalid_request', 'The request body is not valid JSON');
  }
  const parsed = exchangeRequestSchema.safeParse(json);
  if (!parsed.success) return failure(400, 'invalid_request', 'The request body is invalid');
  return parsed.data;
}

/**
 * Accepts a human or device Kilo API credential, mirroring the web resource
 * delegation rules. Delegated workload, internal service, runtime, and other
 * restricted credentials cannot obtain a sync grant.
 */
async function verifyCredential(
  token: string,
  secret: string,
  environment: string | undefined
): Promise<Credential | Response> {
  const auth = await verifyKiloTokenForPolicy(token, secret, {
    audience: KILO_API_AUDIENCE,
    mode: 'allow-legacy',
  }).catch(() => undefined);
  if (!auth) return invalidCredential();
  const { claims, claimNames } = auth;
  if (environment && claims.env !== environment) return invalidCredential();
  if (claims.apiTokenPepper === undefined) {
    return unsupportedCredential('Service credentials cannot obtain sync grants');
  }

  if (claims.tokenPurpose !== undefined) {
    if (claims.tokenPurpose !== 'human-api' && claims.tokenPurpose !== 'device-access') {
      return unsupportedCredential('Delegated credentials cannot obtain sync grants');
    }
    const soleApiAudience =
      typeof claims.aud === 'string'
        ? claims.aud === KILO_API_AUDIENCE
        : claims.aud?.length === 1 && claims.aud[0] === KILO_API_AUDIENCE;
    if (!soleApiAudience || !claimNames.every(name => MODERN_CLAIMS[name] === true)) {
      return unsupportedCredential('Restricted credentials cannot obtain sync grants');
    }
    if (claims.tokenPurpose === 'device-access' && claims.deviceSessionId === undefined) {
      return invalidCredential();
    }
  } else {
    if (!claimNames.every(name => LEGACY_CLAIMS[name] === true)) {
      return unsupportedCredential('Unsupported legacy credential context');
    }
    const eligible =
      claims.deviceSessionId === undefined
        ? isKiloCredentialExchangeEligible(auth, { legacy: 'five-year-api' })
        : LEGACY_DEVICE_LIFETIMES_SECONDS.includes(claims.exp - claims.iat);
    if (!eligible) return unsupportedCredential('Unsupported legacy credential context');
  }

  return {
    userID: auth.userId,
    pepper: claims.apiTokenPepper,
    expiresAt: claims.exp,
    deviceSessionID: claims.deviceSessionId,
  };
}

async function checkAccount(
  db: WorkerDb,
  credential: Credential,
  organizationID: string | undefined
): Promise<Response | undefined> {
  const [user] = await db
    .select({
      pepper: kilocode_users.api_token_pepper,
      blockedReason: kilocode_users.blocked_reason,
      blockedAt: kilocode_users.blocked_at,
    })
    .from(kilocode_users)
    .where(eq(kilocode_users.id, credential.userID))
    .limit(1);
  if (!user || user.pepper !== credential.pepper) return invalidCredential();
  if (user.blockedReason !== null || user.blockedAt !== null) {
    return failure(403, 'account_blocked', 'The account is blocked');
  }

  if (credential.deviceSessionID !== undefined) {
    const id = z.uuid().safeParse(credential.deviceSessionID);
    if (!id.success) return invalidCredential();
    const [session] = await db
      .select({ id: device_sessions.id })
      .from(device_sessions)
      .where(
        and(
          eq(device_sessions.id, id.data),
          eq(device_sessions.kilo_user_id, credential.userID),
          isNull(device_sessions.revoked_at)
        )
      )
      .limit(1);
    if (!session) return invalidCredential('The device session is no longer active');
  }

  if (
    organizationID !== undefined &&
    !(await hasOrganizationAccess(db, {
      kiloUserId: credential.userID,
      organizationId: organizationID,
    }))
  ) {
    return failure(403, 'organization_access_denied', 'Organization access is required');
  }
  return undefined;
}

/** Handles `POST /v1/auth/exchange`. */
export async function exchange(request: Request, env: AuthEnv): Promise<Response> {
  if (request.method !== 'POST') {
    return failure(405, 'method_not_allowed', 'Use POST for credential exchange');
  }
  const token = extractBearerToken(request.headers.get('Authorization'));
  if (!token) return failure(401, 'unauthenticated', 'A Kilo bearer credential is required');
  const body = await readExchangeBody(request);
  if (body instanceof Response) return body;

  try {
    const nextAuthSecret = await resolveSecret(env.NEXTAUTH_SECRET, 1);
    const grantSecret = await resolveSecret(env.SESSION_SYNC_SECRET, MIN_GRANT_SECRET_BYTES);
    const credential = await verifyCredential(token, nextAuthSecret, env.ENVIRONMENT);
    if (credential instanceof Response) return credential;

    const issued = principalSchema.safeParse({
      userID: credential.userID,
      tenant:
        body.organizationID === undefined
          ? { type: 'user', id: credential.userID }
          : { type: 'organization', id: body.organizationID },
    });
    if (!issued.success) return unsupportedCredential('Unsupported account identifier');

    const denied = await checkAccount(
      getWorkerDb(env.HYPERDRIVE.connectionString),
      credential,
      body.organizationID
    );
    if (denied) return denied;

    const now = Math.floor(Date.now() / 1000);
    const exp = Math.min(now + GRANT_TTL_SECONDS, credential.expiresAt);
    if (exp <= now) return invalidCredential();
    const grant = await new SignJWT({ version: 1, tenant: issued.data.tenant })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(GRANT_ISSUER)
      .setAudience(GRANT_AUDIENCE)
      .setSubject(issued.data.userID)
      .setIssuedAt(now)
      .setExpirationTime(exp)
      .sign(new TextEncoder().encode(grantSecret));

    return Response.json(
      {
        version: 1,
        token: grant,
        expiresAt: new Date(exp * 1000).toISOString(),
        tenant: issued.data.tenant,
        userID: issued.data.userID,
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    return unavailable('exchange', error);
  }
}

/** Verifies a sync grant. Raw Kilo credentials are never accepted here. */
export async function authorize(request: Request, env: AuthEnv): Promise<Principal | Response> {
  const token = extractBearerToken(request.headers.get('Authorization'));
  if (!token) return failure(401, 'unauthenticated', 'A sync grant is required');

  let secret: string;
  try {
    secret = await resolveSecret(env.SESSION_SYNC_SECRET, MIN_GRANT_SECRET_BYTES);
  } catch (error) {
    return unavailable('authorize', error);
  }

  const rejected = failure(401, 'invalid_grant', 'The sync grant is invalid or expired');
  let payload: unknown;
  try {
    ({ payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
      algorithms: ['HS256'],
      issuer: GRANT_ISSUER,
      audience: GRANT_AUDIENCE,
      requiredClaims: ['sub', 'iat', 'exp'],
    }));
  } catch {
    return rejected;
  }
  const claims = grantClaims.safeParse(payload);
  if (!claims.success || claims.data.iat > Math.floor(Date.now() / 1000)) return rejected;
  const bound = principalSchema.safeParse({ userID: claims.data.sub, tenant: claims.data.tenant });
  return bound.success ? bound.data : rejected;
}
