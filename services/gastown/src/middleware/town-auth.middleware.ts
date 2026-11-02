import { createMiddleware } from 'hono/factory';
import type { GastownEnv } from '../gastown.worker';
import { getTownDOStub } from '../dos/Town.do';
import { resError } from '../util/res.util';
import { getWorkerAdmin, restActionForRequest } from './worker-admin.middleware';

/**
 * For user-facing /api/towns/:townId/* routes, verifies the caller is
 * authorized: personal owner match OR org member of the owning org (checked
 * via JWT claims, no DB round-trip).
 *
 * Only when ownership fails does it consult the per-request worker admin
 * authority, so an admin viewing their own town never exercises (or audits) a
 * support bypass. Capabilities are scoped to the concrete action and town.
 *
 * Falls back gracefully for legacy towns without owner_type (treated as personal).
 * Must run AFTER kiloAuthMiddleware and resolveWorkerAdminMiddleware.
 */
export const townAuthMiddleware = createMiddleware<GastownEnv>(async (c, next) => {
  const townId = c.req.param('townId');
  if (!townId) return c.json(resError('Missing townId'), 400);
  const userId = c.get('kiloUserId');
  if (!userId) return c.json(resError('Authentication required'), 401);

  const townStub = getTownDOStub(c.env, townId);
  let config;
  try {
    config = await townStub.getTownConfig();
  } catch {
    return c.json(resError('Town not found'), 404);
  }

  if (!config.owner_type || config.owner_type === 'user') {
    const ownerId = config.owner_id ?? config.owner_user_id;
    if (!ownerId) return c.json(resError('Town not found'), 404);
    if (ownerId === userId) return next();
  } else {
    const orgId = config.organization_id ?? config.owner_id;
    if (!orgId) return c.json(resError('Town has no owner'), 500);
    const memberships = c.get('kiloOrgMemberships') ?? [];
    const membership = memberships.find(m => m.orgId === orgId);
    if (membership && membership.role !== 'billing_manager') return next();
  }

  const authority = getWorkerAdmin(c);
  if (!authority) return c.json(resError('Internal server error'), 500);
  const action = restActionForRequest(c) ?? `rest:${c.req.method} ${c.req.path}`;
  const target = { kind: 'town' as const, id: townId };
  const decision = await authority.decide(action, target);
  if (!decision.allowed) {
    if (decision.status === 503) {
      return c.json(resError('Admin capability validation unavailable'), 503);
    }
    return c.json(resError('Forbidden'), 403);
  }

  c.set('workerAdminDecision', { decision, action, target });
  return next();
});
