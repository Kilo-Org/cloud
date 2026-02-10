import type { Context, Next } from 'hono';
import type { AppEnv } from '../types';

/** Require DEBUG_ROUTES=true AND a matching x-debug-api-key header. */
export async function debugRoutesGate(c: Context<AppEnv>, next: Next) {
  if (c.env.DEBUG_ROUTES !== 'true') {
    return c.json({ error: 'Debug routes are disabled' }, 404);
  }

  const secret = c.env.DEBUG_ROUTES_SECRET;
  if (!secret) {
    console.error('[debug] DEBUG_ROUTES is enabled but DEBUG_ROUTES_SECRET is not set');
    return c.json({ error: 'Debug routes are not allowed without a configured secret' }, 403);
  }

  const key = c.req.header('x-debug-api-key');
  if (key !== secret) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  return next();
}
