import type { MiddlewareHandler } from 'hono';
import { readO11ySecret } from './secrets';

export const requireAdmin: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const secret = await readO11ySecret(c.env, 'O11Y_KILO_GATEWAY_CLIENT_SECRET', c.executionCtx);
  const token = c.req.header('X-O11Y-ADMIN-TOKEN');
  if (token !== secret) {
    return c.json({ success: false, error: 'Unauthorized' }, 401);
  }

  return next();
};
