import { createMiddleware } from 'hono/factory';
import type { GastownEnv } from '../gastown.worker';
import { resError } from '../util/res.util';

export const userAuthMiddleware = createMiddleware<GastownEnv>(async (c, next) => {
  const userId = c.get('kiloUserId');
  if (!userId) return c.json(resError('Authentication required'), 401);

  // Admin support uses these routes to inspect other users' towns and rigs.
  if (c.req.param('userId') !== userId && !c.get('kiloIsAdmin')) {
    return c.json(resError('Forbidden'), 403);
  }

  return next();
});
