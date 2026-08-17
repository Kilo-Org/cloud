import { createMiddleware } from 'hono/factory';
import { extractBearerToken } from '@kilocode/worker-utils';
import { verifyKiloBearerAgainstCurrentPepper } from '@kilocode/worker-utils/kilo-token-auth';

import type { Env } from '../env';

export const kiloJwtAuthMiddleware = createMiddleware<{
  Bindings: Env;
  Variables: {
    user_id: string;
  };
}>(async (c, next) => {
  let token = extractBearerToken(c.req.header('Authorization'));
  if (!token && c.req.header('Upgrade') === 'websocket' && c.req.path !== '/api/user/web') {
    token = c.req.query('token') ?? null;
  }

  if (!token) {
    return c.json({ success: false, error: 'Missing or malformed Authorization header' }, 401);
  }

  const auth = await verifyKiloBearerAgainstCurrentPepper({
    token,
    nextAuthSecret: c.env.NEXTAUTH_SECRET_PROD,
    connectionString: c.env.HYPERDRIVE.connectionString,
  });

  if (!auth) {
    return c.json({ success: false, error: 'Invalid or expired token' }, 401);
  }

  c.set('user_id', auth.userId);
  return next();
});
