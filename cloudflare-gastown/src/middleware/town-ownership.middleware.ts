import { createMiddleware } from 'hono/factory';
import { resError } from '../util/res.util';
import type { GastownEnv } from '../gastown.worker';
import { getGastownUserStub } from '../dos/GastownUser.do';

/**
 * Middleware that verifies the authenticated Kilo user owns the `:townId`
 * route param. Must run after `kiloAuthMiddleware` (reads `kiloUserId`
 * and `kiloIsAdmin` from the Hono context).
 *
 * Admins bypass the ownership check so admin-panel routes (e.g. town
 * config inspection/updates) continue to work for any town.
 *
 * Returns 401 if no userId is set, 403 if the town doesn't belong to the
 * caller and they are not an admin.
 */
export const townOwnershipMiddleware = createMiddleware<GastownEnv>(async (c, next) => {
  const userId = c.get('kiloUserId');
  if (!userId) {
    return c.json(resError('Unauthorized'), 401);
  }

  // Admins can access any town (e.g. admin panel inspection routes)
  if (c.get('kiloIsAdmin')) {
    return next();
  }

  const townId = c.req.param('townId');
  if (!townId) {
    return c.json(resError('Missing townId'), 400);
  }

  const userStub = getGastownUserStub(c.env, userId);
  const town = await userStub.getTownAsync(townId);
  if (!town) {
    return c.json(resError('Not your town'), 403);
  }

  return next();
});
