import { createMiddleware } from 'hono/factory';
import { timingSafeEqual } from '@kilocode/encryption';
import { logger } from './util/logger';
import type { AuthContext } from './auth';

/**
 * Internal API auth — verifies the `x-internal-api-key` header against the
 * `INTERNAL_API_SECRET` env binding. Mirrors the pattern in
 * `services/kiloclaw/src/auth/middleware.ts`.
 *
 * Applied to routes under `/internal/*` that are called server-to-server
 * by trusted callers (e.g. the cloud Next.js web app's tRPC mutations).
 * The caller passes `userId` etc. in the request body — there is no JWT.
 */
export const internalApiMiddleware = createMiddleware<{
  Bindings: Env;
  Variables: AuthContext;
}>(async (c, next) => {
  // Reject missing-header probes immediately, before hitting Secrets Store.
  // Unauthenticated traffic shouldn't generate backend secret reads.
  const apiKey = c.req.header('x-internal-api-key');
  if (!apiKey) return c.json({ error: 'Forbidden' }, 403);

  let secret: string;
  try {
    secret = await c.env.INTERNAL_API_SECRET.get();
  } catch (err) {
    logger.error('Failed to read INTERNAL_API_SECRET', { err: String(err) });
    return c.json({ error: 'Server configuration error' }, 500);
  }
  if (!secret) {
    logger.error('INTERNAL_API_SECRET not configured');
    return c.json({ error: 'Server configuration error' }, 500);
  }

  if (!timingSafeEqual(apiKey, secret)) return c.json({ error: 'Forbidden' }, 403);

  logger.setTags({ source: 'internal-api' });
  return next();
});
