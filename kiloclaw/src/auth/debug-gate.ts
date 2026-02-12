import type { Context, Next } from 'hono';
import type { AppEnv } from '../types';

/**
 * Gate for debug routes. In multi-tenant mode, debug routes expose sandbox
 * internals and must be restricted to platform operators.
 *
 * Requires DEBUG_ROUTES=true AND one of:
 * - x-internal-api-key header matching INTERNAL_API_SECRET
 * - x-debug-api-key header matching DEBUG_ROUTES_SECRET (legacy, dev convenience)
 */
export async function debugRoutesGate(c: Context<AppEnv>, next: Next) {
  if (c.env.DEBUG_ROUTES !== 'true') {
    return c.json({ error: 'Debug routes are disabled' }, 404);
  }

  // Prefer internal API key (platform operator access)
  const internalKey = c.req.header('x-internal-api-key');
  if (internalKey && c.env.INTERNAL_API_SECRET && internalKey === c.env.INTERNAL_API_SECRET) {
    return next();
  }

  // Fallback: legacy debug secret (dev convenience)
  const debugSecret = c.env.DEBUG_ROUTES_SECRET;
  if (!debugSecret) {
    console.error('[debug] DEBUG_ROUTES is enabled but DEBUG_ROUTES_SECRET is not set');
    return c.json({ error: 'Debug routes are not allowed without a configured secret' }, 403);
  }

  const debugKey = c.req.header('x-debug-api-key');
  if (debugKey !== debugSecret) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  return next();
}
