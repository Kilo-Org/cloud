import { createMiddleware } from 'hono/factory';
import type { GastownEnv } from '../gastown.worker';
import { verifyOrgMembership } from '../util/org-membership.util';
import { resError } from '../util/res.util';

/**
 * Verifies the authenticated Kilo user is a member of the org identified
 * by the `:orgId` route param, and that they have a role with sufficient
 * permissions (any role except `billing_manager`).
 *
 * Sets `orgId` and `orgRole` on the Hono context for downstream handlers.
 * Must run after `kiloAuthMiddleware` (which sets `kiloUserId`).
 */
export const orgAuthMiddleware = createMiddleware<GastownEnv>(async (c, next) => {
  const orgId = c.req.param('orgId');
  if (!orgId) return c.json(resError('Missing orgId'), 400);
  const userId = c.get('kiloUserId');
  if (!userId) return c.json(resError('Authentication required'), 401);

  const membership = await verifyOrgMembership(c.env, orgId, userId);
  if (!membership) return c.json(resError('Not an org member'), 403);
  if (membership.role === 'billing_manager')
    return c.json(resError('Insufficient permissions'), 403);

  c.set('orgId', orgId);
  c.set('orgRole', membership.role);
  await next();
});
