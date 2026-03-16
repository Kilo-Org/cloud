import { createMiddleware } from 'hono/factory';
import { resError } from '../util/res.util';
import type { GastownEnv } from '../gastown.worker';
import { getGastownUserStub } from '../dos/GastownUser.do';

/**
 * Middleware that verifies the authenticated Kilo user owns the `:townId`
 * route param. Must run after `kiloAuthMiddleware` (reads `kiloUserId`
 * from the Hono context).
 *
 * Returns 401 if no userId is set, 403 if the town doesn't belong to the
 * caller.
 */
export const townOwnershipMiddleware = createMiddleware<GastownEnv>(async (c, next) => {
  const userId = c.get('kiloUserId');
  if (!userId) {
    return c.json(resError('Unauthorized'), 401);
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
