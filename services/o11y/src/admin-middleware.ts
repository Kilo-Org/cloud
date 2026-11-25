import { timingSafeEqual } from '@kilocode/encryption';
import type { MiddlewareHandler } from 'hono';
import { SecretNotConfiguredError, readO11ySecret } from './secrets';

export const requireAdmin: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  let secret: string;
  try {
    secret = await readO11ySecret(c.env, 'O11Y_KILO_GATEWAY_CLIENT_SECRET', c.executionCtx);
  } catch (error) {
    if (error instanceof SecretNotConfiguredError) {
      return c.json({ success: false, error: 'Unauthorized' }, 401);
    }
    throw error;
  }
  const token = c.req.header('X-O11Y-ADMIN-TOKEN');
  if (!secret || !token || !timingSafeEqual(token, secret)) {
    return c.json({ success: false, error: 'Unauthorized' }, 401);
  }

  return next();
};
