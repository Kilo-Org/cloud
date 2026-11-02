import { createMiddleware } from 'hono/factory';
import type { GastownEnv } from '../gastown.worker';
import { emitWorkerAdminDecision } from './worker-admin.middleware';

/**
 * Emits `admin.legacy_claim` / `admin.capability` telemetry when a town route
 * actually used the support bypass. `townAuthMiddleware` only sets the
 * decision after ownership failed, so an admin acting on their own town does
 * not produce an elevation event.
 *
 * Must run AFTER townAuthMiddleware.
 */
export const adminAuditMiddleware = createMiddleware<GastownEnv>(async (c, next) => {
  const reported = c.get('workerAdminDecision');
  if (!reported) return next();

  const claims = c.get('kiloTokenClaims');
  const lifetimeSeconds =
    typeof claims?.exp === 'number' && typeof claims?.iat === 'number'
      ? claims.exp - claims.iat
      : null;

  emitWorkerAdminDecision(c.env, reported.decision, {
    action: reported.action,
    userId: c.get('kiloUserId') ?? null,
    townId: reported.target.kind === 'town' ? reported.target.id : null,
    jti: reported.decision.allowed ? reported.decision.jti : null,
    lifetimeSeconds,
  });

  return next();
});
