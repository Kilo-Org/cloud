import jwt from 'jsonwebtoken';
import { Buffer } from 'node:buffer';
import { z } from 'zod';
import { resolveSecret } from './auth.js';
import {
  resolveRuntimeCredentialProxyRoute,
  type RuntimeCredentialProxyRoute,
} from './kilo/runtime-credential-proxy-routes.js';
import type { Env } from './types.js';

const AUDIENCE = 'cloud-agent-next:runtime-credential-proxy';
const sessionClaimsSchema = z
  .object({
    aud: z.literal(AUDIENCE),
    grantId: z.string().uuid(),
    authorizationId: z.string().uuid(),
    sessionId: z.string().min(1),
    kiloSessionId: z.string().min(1),
    userId: z.string().min(1),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .extend({
    iat: z.number().int().positive(),
    exp: z.number().int().positive(),
  })
  .strict()
  .refine(claims => claims.exp > claims.iat);

const worktreeClaimsSchema = z
  .object({
    aud: z.literal(AUDIENCE),
    kind: z.literal('worktree'),
    grantId: z.string().uuid(),
    sandboxId: z.string().min(1),
    scopeId: z.string().min(1),
    directory: z.string().min(1),
    userId: z.string().min(1),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    iat: z.number().int().positive(),
    exp: z.number().int().positive(),
  })
  .strict()
  .refine(claims => claims.exp > claims.iat);
export type RuntimeProxyHandleClaims =
  | z.infer<typeof sessionClaimsSchema>
  | z.infer<typeof worktreeClaimsSchema>;

export const RUNTIME_PROXY_GRANT_KEY = 'runtime_proxy_grant';
const runtimeProxyGrantBaseSchema = z
  .object({
    grantId: z.string().uuid(),
    authorizationId: z.string().uuid(),
    sessionId: z.string().min(1),
    kiloSessionId: z.string().min(1),
    userId: z.string().min(1),
    orgId: z.string().min(1).optional(),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    mode: z.enum(['direct', 'contained']),
    allocationId: z.string().min(1),
    issuedAt: z.number().int().positive().optional(),
    leaseExpiresAt: z.number().int().positive(),
    state: z.literal('active'),
  })
  .strict();

const legacyRuntimeProxyGrantV2Schema = runtimeProxyGrantBaseSchema.extend({
  version: z.literal(2),
  plane: z.literal('legacy'),
  generation: z.number().int().nonnegative(),
  wrapperRunId: z.string().min(1),
  wrapperConnectionId: z.string().min(1),
});
const controlRuntimeProxyGrantV2Schema = runtimeProxyGrantBaseSchema.extend({
  version: z.literal(2),
  plane: z.literal('control'),
  providerInstanceId: z.string().min(1),
  connectionId: z.string().min(1),
  wrapperInstanceId: z.string().min(1),
});
const legacyRuntimeProxyGrantV1Schema = runtimeProxyGrantBaseSchema
  .extend({
    version: z.literal(1),
    generation: z.number().int().nonnegative(),
    wrapperRunId: z.string().min(1),
    wrapperConnectionId: z.string().min(1),
  })
  .transform(grant => ({ ...grant, plane: 'legacy' as const }));

/** v1 persisted grants are accepted temporarily as legacy only; never control. */
export const runtimeProxyGrantSchema = z.union([
  legacyRuntimeProxyGrantV2Schema,
  controlRuntimeProxyGrantV2Schema,
  legacyRuntimeProxyGrantV1Schema,
]);
export type RuntimeProxyGrant = z.infer<typeof runtimeProxyGrantSchema>;
export type RuntimeProxyFence =
  | {
      plane: 'legacy';
      generation: number;
      allocationId: string;
      wrapperRunId: string;
      wrapperConnectionId: string;
    }
  | {
      plane: 'control';
      allocationId: string;
      providerInstanceId: string;
      connectionId: string;
      wrapperInstanceId: string;
    };
type RuntimeProxyGrantInput =
  | Omit<z.infer<typeof legacyRuntimeProxyGrantV2Schema>, 'version' | 'grantId' | 'nonce'>
  | Omit<z.infer<typeof controlRuntimeProxyGrantV2Schema>, 'version' | 'grantId' | 'nonce'>;

export function createRuntimeProxyGrant(input: RuntimeProxyGrantInput): RuntimeProxyGrant {
  return runtimeProxyGrantSchema.parse({
    version: 2,
    grantId: crypto.randomUUID(),
    nonce: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'),
    ...input,
  });
}

export const worktreeRuntimeProxyGrantSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal('worktree'),
    grantId: z.string().uuid(),
    sandboxId: z.string().min(1),
    scopeId: z.string().min(1),
    directory: z.string().min(1),
    userId: z.string().min(1),
    orgId: z.string().min(1).optional(),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    leaseExpiresAt: z.number().int().positive(),
    state: z.literal('active'),
    allocationId: z.string().min(1),
    providerInstanceId: z.string().min(1),
    connectionId: z.string().min(1),
    wrapperInstanceId: z.string().min(1),
  })
  .strict();
export type WorktreeRuntimeProxyGrant = z.infer<typeof worktreeRuntimeProxyGrantSchema>;

export function createWorktreeRuntimeProxyGrant(
  input: Omit<WorktreeRuntimeProxyGrant, 'version' | 'kind' | 'grantId' | 'nonce'>
): WorktreeRuntimeProxyGrant {
  return worktreeRuntimeProxyGrantSchema.parse({
    version: 1,
    kind: 'worktree',
    grantId: crypto.randomUUID(),
    nonce: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'),
    ...input,
  });
}

export async function issueRuntimeCredentialProxyHandle(
  env: Pick<Env, 'NEXTAUTH_SECRET'>,
  input: RuntimeProxyGrant,
  issuedAt = Date.now()
): Promise<string> {
  const grant = runtimeProxyGrantSchema.parse(input);
  const secret = await resolveSecret(env.NEXTAUTH_SECRET);
  if (!secret) throw new Error('Authentication unavailable');
  const iat = Math.floor(issuedAt / 1000);
  const exp = Math.floor(grant.leaseExpiresAt / 1000);
  if (exp <= iat) throw new Error('Runtime proxy grant has expired');
  return jwt.sign(
    {
      aud: AUDIENCE,
      grantId: grant.grantId,
      authorizationId: grant.authorizationId,
      sessionId: grant.sessionId,
      kiloSessionId: grant.kiloSessionId,
      userId: grant.userId,
      nonce: grant.nonce,
      iat,
      exp,
    },
    secret,
    { algorithm: 'HS256' }
  );
}

export async function issueWorktreeRuntimeCredentialProxyHandle(
  env: Pick<Env, 'NEXTAUTH_SECRET'>,
  input: WorktreeRuntimeProxyGrant,
  issuedAt = Date.now()
): Promise<string> {
  const grant = worktreeRuntimeProxyGrantSchema.parse(input);
  const secret = await resolveSecret(env.NEXTAUTH_SECRET);
  if (!secret) throw new Error('Authentication unavailable');
  const iat = Math.floor(issuedAt / 1000);
  const exp = Math.floor(grant.leaseExpiresAt / 1000);
  if (exp <= iat) throw new Error('Runtime proxy grant has expired');
  return jwt.sign(
    {
      aud: AUDIENCE,
      kind: 'worktree',
      grantId: grant.grantId,
      sandboxId: grant.sandboxId,
      scopeId: grant.scopeId,
      directory: grant.directory,
      userId: grant.userId,
      nonce: grant.nonce,
      iat,
      exp,
    },
    secret,
    { algorithm: 'HS256' }
  );
}

export async function verifyRuntimeCredentialProxyHandle(
  env: Pick<Env, 'NEXTAUTH_SECRET'>,
  value: string
): Promise<RuntimeProxyHandleClaims | null> {
  const secret = await resolveSecret(env.NEXTAUTH_SECRET);
  if (!secret || value.length > 4096) return null;
  try {
    const verified = jwt.verify(value, secret, { algorithms: ['HS256'] });
    const claims = z.union([sessionClaimsSchema, worktreeClaimsSchema]).safeParse(verified);
    return claims.success ? claims.data : null;
  } catch {
    return null;
  }
}

export function matchesRuntimeProxyGrant(
  value: unknown,
  handle: RuntimeProxyHandleClaims,
  context: {
    authorizationId: string;
    sessionId: string;
    kiloSessionId: string;
    userId: string;
    orgId?: string;
    fence: RuntimeProxyFence;
    now: number;
  }
): value is RuntimeProxyGrant {
  if (!('sessionId' in handle)) return false;
  const grant = runtimeProxyGrantSchema.safeParse(value);
  if (!grant.success) return false;
  const current = grant.data;
  return (
    current.state === 'active' &&
    current.leaseExpiresAt > context.now &&
    Math.floor(current.leaseExpiresAt / 1000) === handle.exp &&
    current.grantId === handle.grantId &&
    current.authorizationId === handle.authorizationId &&
    current.sessionId === handle.sessionId &&
    current.kiloSessionId === handle.kiloSessionId &&
    current.userId === handle.userId &&
    current.nonce === handle.nonce &&
    current.authorizationId === context.authorizationId &&
    current.sessionId === context.sessionId &&
    current.kiloSessionId === context.kiloSessionId &&
    current.userId === context.userId &&
    current.orgId === context.orgId &&
    current.plane === context.fence.plane &&
    current.allocationId === context.fence.allocationId &&
    (current.plane === 'legacy' && context.fence.plane === 'legacy'
      ? current.generation === context.fence.generation &&
        current.wrapperRunId === context.fence.wrapperRunId &&
        current.wrapperConnectionId === context.fence.wrapperConnectionId
      : current.plane === 'control' &&
        context.fence.plane === 'control' &&
        current.providerInstanceId === context.fence.providerInstanceId &&
        current.connectionId === context.fence.connectionId &&
        current.wrapperInstanceId === context.fence.wrapperInstanceId)
  );
}

export async function resolveRuntimeProxyCredential(input: {
  handle: string;
  env: Pick<Env, 'NEXTAUTH_SECRET'>;
  grant: unknown;
  authorization: { id: string; state: string } | null;
  context: {
    sessionId: string;
    kiloSessionId: string;
    userId: string;
    orgId?: string;
    fence: RuntimeProxyFence;
  };
  now?: number;
  token: string;
  renew: () => Promise<string>;
}): Promise<{ token: string; transportProofRequired: boolean } | null> {
  const claims = await verifyRuntimeCredentialProxyHandle(input.env, input.handle);
  const now = input.now ?? Date.now();
  if (
    !claims ||
    !('sessionId' in claims) ||
    !input.authorization ||
    input.authorization.state !== 'active' ||
    !matchesRuntimeProxyGrant(input.grant, claims, {
      ...input.context,
      authorizationId: input.authorization.id,
      now,
    })
  ) {
    return null;
  }
  const decoded = jwt.decode(input.token);
  const exp =
    typeof decoded === 'object' && decoded !== null && typeof decoded.exp === 'number'
      ? decoded.exp * 1000
      : 0;
  const token = exp > now + 5 * 60_000 ? input.token : await input.renew();
  return {
    token,
    transportProofRequired: runtimeProxyGrantSchema.parse(input.grant).mode === 'contained',
  };
}

export function runtimeCredentialProxyBaseUrl(workerUrl: string): string | null {
  try {
    const url = new URL(workerUrl);
    if (url.username || url.password || url.search || url.hash) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}/api/runtime-credential-proxy`;
  } catch {
    return null;
  }
}

export function runtimeCredentialProxyUpstream(
  targets: { backendBaseUrl: string; providerBaseUrl: string; sessionIngestBaseUrl: string },
  route: RuntimeCredentialProxyRoute,
  method: string,
  pathname: string,
  search: string,
  kiloSessionId: string,
  organizationId?: string,
  contentType?: string | null,
  bodyText?: string
): URL | null {
  return resolveRuntimeCredentialProxyRoute({
    targets,
    route,
    method,
    pathname: `/${pathname.replace(/^\/+/, '')}`,
    search,
    kiloSessionId,
    organizationId,
    contentType,
    bodyText,
  });
}
