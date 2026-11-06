import { createMiddleware } from 'hono/factory';
import {
  WASTELAND_ADMIN_AUDIENCE,
  createWorkerAdminAuthority,
  createWorkerAdminIntrospection,
  createWorkerAdminIntrospectionCache,
  evaluateLegacyAdminClaim,
  parseLegacyAdminClaimMode,
  parseWorkerAdminJwks,
  readWorkerAdminCapabilityHeader,
  type WorkerAdminDecision,
  type WorkerAdminIntrospectionCache,
  type WorkerAdminIntrospectionRequest,
} from '@kilocode/worker-utils/worker-admin-capability';
import type { WastelandEnv } from '../wasteland.worker';
import { resolveSecret } from '../util/secret.util';
import { writeEvent } from '../util/analytics.util';

const introspectionCache: WorkerAdminIntrospectionCache = createWorkerAdminIntrospectionCache();

async function introspect(env: Env, request: WorkerAdminIntrospectionRequest) {
  if (!env.KILO_INTERNAL_API_URL || !env.INTERNAL_API_SECRET) {
    throw new Error('Worker admin capability introspection is not configured');
  }
  const secret = await resolveSecret(env.INTERNAL_API_SECRET);
  if (!secret) throw new Error('Worker admin capability introspection secret unavailable');
  const url = `${env.KILO_INTERNAL_API_URL}/api/internal/worker-admin-capabilities/introspect`;
  return createWorkerAdminIntrospection({ url, secret })(request);
}

export const resolveWorkerAdminMiddleware = createMiddleware<WastelandEnv>(async (c, next) => {
  const claims = c.get('kiloTokenClaims');
  const legacy = evaluateLegacyAdminClaim({
    isAdmin: claims?.isAdmin,
    iat: claims?.iat,
    exp: claims?.exp,
  });
  const mode = parseLegacyAdminClaimMode(c.env.LEGACY_ADMIN_CLAIM_MODE);
  const effectiveLegacy = legacy.allowed && mode !== 'reject';
  const wasAdmin = c.get('kiloIsAdmin') ?? false;
  c.set('kiloIsAdmin', effectiveLegacy && wasAdmin);

  const authority = await createWorkerAdminAuthority({
    mode,
    audience: WASTELAND_ADMIN_AUDIENCE,
    identity: {
      kiloUserId: c.get('kiloUserId') ?? '',
      apiTokenPepper: c.get('kiloApiTokenPepper') ?? null,
      env: typeof claims?.env === 'string' ? claims.env : undefined,
    },
    legacyClaim: effectiveLegacy && wasAdmin,
    legacyClaimRejection: legacy.allowed ? null : legacy.reason,
    capabilityToken: readWorkerAdminCapabilityHeader(c.req.raw.headers),
    jwks: parseWorkerAdminJwks(c.env.WORKER_ADMIN_CAPABILITY_PUBLIC_KEYS),
    introspect: request => introspect(c.env, request),
    readCache: introspectionCache,
  });

  c.set('workerAdmin', authority);
  if (authority.capabilityError !== null) {
    return c.json({ error: 'Invalid worker admin capability' }, 401);
  }
  return next();
});

export function emitWorkerAdminDecision(
  env: Env,
  decision: WorkerAdminDecision,
  params: {
    action: string;
    userId: string | null;
    wastelandId?: string | null;
    jti?: string | null;
    lifetimeSeconds?: number | null;
    delivery?: 'http' | 'trpc';
  }
): void {
  if (decision.source === 'none') return;
  const event = decision.source === 'legacy' ? 'admin.legacy_claim' : 'admin.capability';
  writeEvent(env, {
    event,
    delivery: params.delivery ?? 'http',
    route: params.action,
    userId: params.userId ?? undefined,
    wastelandId: params.wastelandId ?? undefined,
    reason: decision.reason ?? undefined,
    label: params.jti ?? undefined,
    value: params.lifetimeSeconds ?? undefined,
  });
  console.log(
    JSON.stringify({
      tag: 'worker-admin',
      event,
      source: decision.source,
      outcome: decision.allowed
        ? decision.wouldDeny
          ? 'observe_would_deny'
          : 'granted'
        : 'denied',
      action: params.action,
    })
  );
}
