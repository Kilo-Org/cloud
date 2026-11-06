import { createMiddleware } from 'hono/factory';
import type { Context } from 'hono';
import {
  GASTOWN_ADMIN_AUDIENCE,
  createWorkerAdminAuthority,
  createWorkerAdminIntrospection,
  createWorkerAdminIntrospectionCache,
  evaluateLegacyAdminClaim,
  matchWorkerAdminRestAction,
  parseLegacyAdminClaimMode,
  parseWorkerAdminJwks,
  readWorkerAdminCapabilityHeader,
  type WorkerAdminAuthority,
  type WorkerAdminDecision,
  type WorkerAdminIntrospectionCache,
  type WorkerAdminIntrospectionRequest,
} from '@kilocode/worker-utils/worker-admin-capability';
import type { GastownEnv } from '../gastown.worker';
import { resolveSecret } from '../util/secret.util';
import { writeEvent } from '../util/analytics.util';

// Isolate-local cache for read introspection verdicts. Writes are never cached.
const introspectionCache: WorkerAdminIntrospectionCache = createWorkerAdminIntrospectionCache();

function capabilityPublicKeys(env: Env) {
  return parseWorkerAdminJwks(env.WORKER_ADMIN_CAPABILITY_PUBLIC_KEYS);
}

async function introspect(env: Env, request: WorkerAdminIntrospectionRequest) {
  if (!env.KILO_INTERNAL_API_URL || !env.INTERNAL_API_SECRET) {
    throw new Error('Worker admin capability introspection is not configured');
  }
  const secret = await resolveSecret(env.INTERNAL_API_SECRET);
  if (!secret) throw new Error('Worker admin capability introspection secret unavailable');
  const url = `${env.KILO_INTERNAL_API_URL}/api/internal/worker-admin-capabilities/introspect`;
  return createWorkerAdminIntrospection({ url, secret })(request);
}

/**
 * Builds the per-request Worker admin authority from the verified identity
 * token plus an optional capability header.
 *
 * Legacy `isAdmin` claims are hardened here in every mode: a legacy elevation
 * without `exp`, or with a lifetime over an hour, no longer grants admin.
 */
export const resolveWorkerAdminMiddleware = createMiddleware<GastownEnv>(async (c, next) => {
  const claims = c.get('kiloTokenClaims');
  const legacy = evaluateLegacyAdminClaim({
    isAdmin: claims?.isAdmin,
    iat: claims?.iat,
    exp: claims?.exp,
  });
  const mode = parseLegacyAdminClaimMode(c.env.LEGACY_ADMIN_CLAIM_MODE);
  const effectiveLegacy = legacy.allowed && mode !== 'reject';

  c.set('kiloIsAdmin', effectiveLegacy && (c.get('kiloIsAdmin') ?? false));

  const authority = await createWorkerAdminAuthority({
    mode,
    audience: GASTOWN_ADMIN_AUDIENCE,
    identity: {
      kiloUserId: c.get('kiloUserId') ?? '',
      apiTokenPepper: c.get('kiloApiTokenPepper') ?? null,
      env: typeof claims?.env === 'string' ? claims.env : undefined,
    },
    legacyClaim: effectiveLegacy && (c.get('kiloIsAdmin') ?? false),
    legacyClaimRejection: legacy.allowed ? null : legacy.reason,
    capabilityToken: readWorkerAdminCapabilityHeader(c.req.raw.headers),
    jwks: capabilityPublicKeys(c.env),
    introspect: request => introspect(c.env, request),
    readCache: introspectionCache,
  });

  c.set('workerAdmin', authority);
  if (authority.capabilityError !== null) {
    return c.json({ success: false, error: 'Invalid worker admin capability' }, 401);
  }
  return next();
});

export function getWorkerAdmin(c: Context<GastownEnv>): WorkerAdminAuthority | null {
  return c.get('workerAdmin') ?? null;
}

export function restActionForRequest(c: Context<GastownEnv>): string | null {
  return matchWorkerAdminRestAction(GASTOWN_ADMIN_AUDIENCE, c.req.method, c.req.path);
}

export function emitWorkerAdminDecision(
  env: Env,
  decision: WorkerAdminDecision,
  params: {
    action: string;
    userId: string | null;
    townId?: string | null;
    jti?: string | null;
    lifetimeSeconds?: number | null;
    delivery?: 'http' | 'trpc';
  }
): void {
  if (decision.source === 'none') return;
  const event = decision.source === 'legacy' ? 'admin.legacy_claim' : 'admin.capability';
  const reason = decision.allowed
    ? (decision.reason ?? (decision.wouldDeny ? 'observe_would_deny' : 'honored'))
    : decision.reason;
  writeEvent(env, {
    event,
    delivery: params.delivery ?? 'http',
    route: params.action,
    userId: params.userId ?? undefined,
    townId: params.townId ?? undefined,
    reason,
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
