import { createMiddleware } from 'hono/factory';
import { extractBearerToken } from '@kilocode/worker-utils/extract-bearer-token';
import { GASTOWN_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import { verifyKiloTokenForResource } from '@kilocode/worker-utils/kilo-token-policy';
import { resError } from '../util/res.util';
import type { GastownEnv } from '../gastown.worker';
import { resolveSecret } from '../util/secret.util';
import { logger } from '../util/log.util';

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

  if (!c.env.NEXTAUTH_SECRET) {
    console.error('[kilo-auth] NEXTAUTH_SECRET not configured');
    return c.json(resError('Internal server error'), 500);
  }
  const secret = await resolveSecret(c.env.NEXTAUTH_SECRET);
  if (!secret) {
    console.error('[kilo-auth] failed to resolve NEXTAUTH_SECRET from Secrets Store');
    return c.json(resError('Internal server error'), 500);
  }

  try {
    const payload = await verifyKiloTokenForResource(token, secret, {
      audience: GASTOWN_AUDIENCE,
      mode: 'allow-legacy',
    });
    c.set('kiloUserId', payload.kiloUserId);
    c.set('kiloIsAdmin', payload.isAdmin === true);
    c.set('kiloApiTokenPepper', payload.apiTokenPepper ?? null);
    c.set('kiloGastownAccess', payload.gastownAccess === true);
    c.set('kiloOrgMemberships', payload.orgMemberships ?? []);
    logger.setTags({ userId: payload.kiloUserId });
  } catch (err) {
    console.warn(
      '[kilo-auth] token verification failed:',
      err instanceof Error ? err.message : 'unknown error'
    );
    return c.json(resError('Invalid token'), 401);
  }

  return next();
});
