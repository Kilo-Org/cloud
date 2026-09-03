import { createMiddleware } from 'hono/factory';
import type { GastownEnv } from '../gastown.worker';
import { getTownDOStub } from '../dos/Town.do';
import { resError } from '../util/res.util';
import { authorizeTown, TownAuthorizationUnavailableError } from '../util/town-authorization.util';

/**
 * For user-facing /api/towns/:townId/* routes, verifies the caller is
 * authorized: personal owner match OR org member of the owning org
 * (checked via JWT claims, no DB round-trip).
 *
 * Falls back gracefully for legacy towns without owner_type (treated as personal).
 * Must run AFTER kiloAuthMiddleware (which sets kiloOrgMemberships).
 */
export const townAuthMiddleware = createMiddleware<GastownEnv>(async (c, next) => {
  const townId = c.req.param('townId');
  if (!townId) return c.json(resError('Missing townId'), 400);
  const userId = c.get('kiloUserId');
  if (!userId) return c.json(resError('Authentication required'), 401);

  const townStub = getTownDOStub(c.env, townId);
  const identity = await townStub.getPrivateTownIdentity();
  if (identity) {
    try {
      const authorization = await authorizeTown(
        c.env,
        identity,
        userId,
        c.get('kiloApiTokenPepper')
      );
      if (identity.runtimeMode === 'modern') {
        if (!authorization) return c.json(resError('Forbidden'), 403);
        return next();
      }
    } catch (error) {
      if (error instanceof TownAuthorizationUnavailableError) {
        return c.json(resError('Authorization unavailable'), 503);
      }
      throw error;
    }
    if (c.get('kiloIsAdmin')) return next();
    if (identity.ownerType === 'user') {
      if (identity.ownerUserId !== userId) return c.json(resError('Forbidden'), 403);
      return next();
    }
    const memberships = c.get('kiloOrgMemberships') ?? [];
    const membership = memberships.find(value => value.orgId === identity.organizationId);
    if (!membership || membership.role === 'billing_manager')
      return c.json(resError('Forbidden'), 403);
    return next();
  }
  let config;
  try {
    config = await townStub.getTownConfig();
  } catch {
    return c.json(resError('Town not found'), 404);
  }

  if (!config.owner_type || config.owner_type === 'user') {
    // Personal town — verify userId matches owner
    const ownerId = config.owner_id ?? config.owner_user_id;
    if (!ownerId) return c.json(resError('Town not found'), 404);
    if (ownerId !== userId) return c.json(resError('Forbidden'), 403);
  } else {
    // Org-owned town — verify org membership via JWT claims
    const orgId = config.organization_id ?? config.owner_id;
    if (!orgId) return c.json(resError('Town has no owner'), 500);
    const memberships = c.get('kiloOrgMemberships') ?? [];
    const membership = memberships.find(m => m.orgId === orgId);
    if (!membership || membership.role === 'billing_manager') {
      return c.json(resError('Forbidden'), 403);
    }
  }

  await next();
});
