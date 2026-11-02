import { createMiddleware } from 'hono/factory';
import type { GastownEnv } from '../gastown.worker';
import { getTownDOStub } from '../dos/Town.do';
import { resError } from '../util/res.util';
import {
  emitWorkerAdminDecision,
  getWorkerAdmin,
  restActionForRequest,
} from './worker-admin.middleware';

/**
 * For user-facing /api/towns/:townId/* routes, verifies the caller is
 * authorized: personal owner match OR org member of the owning org (checked
 * via JWT claims, no DB round-trip).
 *
 * Ownership is checked first, so an admin acting on their own town never
 * exercises or audits a support bypass. When ownership fails, the per-request
 * worker admin authority decides; both grants and denials are audited once.
 *
 * Falls back gracefully for legacy towns without owner_type (treated as personal).
 * Must run AFTER kiloAuthMiddleware and resolveWorkerAdminMiddleware.
 */
export const townAuthMiddleware = createMiddleware<GastownEnv>(async (c, next) => {
  const townId = c.req.param('townId');
  if (!townId) return c.json(resError('Missing townId'), 400);
  const userId = c.get('kiloUserId');
  if (!userId) return c.json(resError('Authentication required'), 401);

  const authority = getWorkerAdmin(c);
  if (!authority) return c.json(resError('Internal server error'), 500);
  const action = restActionForRequest(c) ?? `rest:${c.req.method} ${c.req.path}`;
  const target = { kind: 'town' as const, id: townId };

  const decide = async () => {
    const decision = await authority.decide(action, target);
    const claims = c.get('kiloTokenClaims');
    emitWorkerAdminDecision(c.env, decision, {
      action,
      userId,
      townId,
      jti: decision.allowed ? decision.jti : null,
      lifetimeSeconds:
        typeof claims?.exp === 'number' && typeof claims?.iat === 'number'
          ? claims.exp - claims.iat
          : null,
    });
    return decision;
  };

  const townStub = getTownDOStub(c.env, townId);
  let config;
  try {
    config = await townStub.getTownConfig();
  } catch {
    const decision = await decide();
    if (decision.allowed) return next();
    return c.json(resError('Town not found'), 404);
  }

  let denyStatus: 403 | 404 | 500 = 403;

  if (!config.owner_type || config.owner_type === 'user') {
    const ownerId = config.owner_id ?? config.owner_user_id;
    if (!ownerId) {
      denyStatus = 404;
    } else if (ownerId === userId) {
      return next();
    }
  } else {
    const orgId = config.organization_id ?? config.owner_id;
    if (!orgId) {
      denyStatus = 500;
    } else {
      const memberships = c.get('kiloOrgMemberships') ?? [];
      const membership = memberships.find(m => m.orgId === orgId);
      if (membership && membership.role !== 'billing_manager') return next();
    }
  }

  const decision = await decide();
  if (decision.allowed) return next();
  if (decision.status === 503) {
    return c.json(resError('Admin capability validation unavailable'), 503);
  }
  return c.json(resError(denyStatus === 404 ? 'Town not found' : 'Forbidden'), denyStatus);
});
