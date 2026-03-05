import { createMiddleware } from 'hono/factory';
import { verifyKiloToken, extractBearerToken } from '@kilocode/worker-utils';
import { resError } from '../util/res.util';
import type { GastownEnv } from '../gastown.worker';
import { resolveSecret } from '../util/secret.util';

/**
 * Auth middleware that validates Kilo user JWTs (signed with NEXTAUTH_SECRET).
 * Used for dashboard/user-facing routes where the Next.js app sends a
 * Bearer token on behalf of the logged-in user.
 *
 * Sets `kiloUserId` on the Hono context.
 */
export const kiloAuthMiddleware = createMiddleware<GastownEnv>(async (c, next) => {
  const token = extractBearerToken(c.req.header('Authorization'));
  if (!token) {
    return c.json(resError('Authentication required'), 401);
  }

  const secret = await resolveSecret(c.env.NEXTAUTH_SECRET);
  if (!secret) {
    console.error('[kilo-auth] NEXTAUTH_SECRET not configured');
    return c.json(resError('Internal server error'), 500);
  }

  try {
    const payload = await verifyKiloToken(token, secret);
    c.set('kiloUserId', payload.kiloUserId);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid token';
    return c.json(resError(message), 401);
  }

  return next();
});
