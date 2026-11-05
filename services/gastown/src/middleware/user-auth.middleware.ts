import { createMiddleware } from 'hono/factory';
import type { GastownEnv } from '../gastown.worker';
import { resError } from '../util/res.util';
import { restActionForRequest } from './worker-admin.middleware';

export const userAuthMiddleware = createMiddleware<GastownEnv>(async (c, next) => {
  const userId = c.get('kiloUserId');
  if (!userId) return c.json(resError('Authentication required'), 401);

  const targetUserId = c.req.param('userId');
  if (targetUserId === userId) return next();

  // Admin support only needs to read other users' towns and rigs. The action
  // must be allowlisted and the capability (or legacy claim) must name this
  // exact user.
  if (c.req.method === 'GET' && targetUserId) {
    const authority = c.get('workerAdmin');
    if (!authority) return c.json(resError('Internal server error'), 500);
    const action = restActionForRequest(c) ?? `rest:GET ${c.req.path}`;
    const decision = await authority.decide(action, { kind: 'user', id: targetUserId });
    if (decision.allowed) return next();
  }

  return c.json(resError('Forbidden'), 403);
});
