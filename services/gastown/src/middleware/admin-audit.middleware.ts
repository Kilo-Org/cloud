import { createMiddleware } from 'hono/factory';
import type { GastownEnv } from '../gastown.worker';
import { emitWorkerAdminDecision, restActionForRequest } from './worker-admin.middleware';

/**
 * Emits `admin.legacy_claim` / `admin.capability` telemetry for Worker admin
 * access to town routes. Replaces the older `admin.town_access` event so the
 * legacy and capability paths are counted once, with the same dimensions.
 *
 * Must run AFTER kiloAuthMiddleware and resolveWorkerAdminMiddleware.
 */
export const adminAuditMiddleware = createMiddleware<GastownEnv>(async (c, next) => {
  const authority = c.get('workerAdmin');
  if (!authority) return next();
  const claimedAdmin = c.get('kiloTokenClaims')?.isAdmin === true;
  if (
    !authority.legacyClaim &&
    !authority.hasCapability &&
    authority.capabilityError === null &&
    !claimedAdmin
  ) {
    return next();
  }

  const townId = c.req.param('townId');
  const action = restActionForRequest(c) ?? `rest:${c.req.method} ${c.req.path}`;
  const decision = await authority.decide(
    action,
    townId ? { kind: 'town', id: townId } : { kind: 'service', id: 'gastown' }
  );
  const claims = c.get('kiloTokenClaims');
  const lifetimeSeconds =
    typeof claims?.exp === 'number' && typeof claims?.iat === 'number'
      ? claims.exp - claims.iat
      : null;

  emitWorkerAdminDecision(c.env, decision, {
    action,
    userId: c.get('kiloUserId') ?? null,
    townId: townId ?? null,
    jti: decision.allowed ? decision.jti : null,
    lifetimeSeconds,
  });

  return next();
});
