import { createMiddleware } from 'hono/factory';
import type { GastownEnv } from '../gastown.worker';
import { resError } from '../util/res.util';

export const userAuthMiddleware = createMiddleware<GastownEnv>(async (c, next) => {
  const userId = c.get('kiloUserId');
  if (!userId) return c.json(resError('Authentication required'), 401);

  // Admin support only needs to read other users' towns and rigs.
  const adminRead = c.get('kiloIsAdmin') && c.req.method === 'GET';
  if (c.req.param('userId') !== userId && !adminRead) {
    return c.json(resError('Forbidden'), 403);
  }

  return next();
});
