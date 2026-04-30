import { createMiddleware } from 'hono/factory';
import { extractBearerToken, getCachedSecret, verifyKiloToken } from '@kilocode/worker-utils';
import { logger } from './util/logger';

export type AuthContext = {
  callerId: string;
  callerKind: 'user';
};

/**
 * Public HTTP auth for the notifications worker — humans only. The bearer is
 * a Kilo JWT verified with NEXTAUTH_SECRET.
 *
 * The worker also exposes RPC methods to other workers (e.g. kilo-chat). RPC
 * callers don't go through this middleware; HTTP traffic is JWT-only.
 */
export const authMiddleware = createMiddleware<{
  Bindings: Env;
  Variables: AuthContext;
}>(async (c, next) => {
  const token = extractBearerToken(c.req.header('authorization'));
  if (!token) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  try {
    const jwtSecret = await getCachedSecret(c.env.NEXTAUTH_SECRET, 'NEXTAUTH_SECRET');
    const payload = await verifyKiloToken(token, jwtSecret);
    c.set('callerId', payload.kiloUserId);
    c.set('callerKind', 'user');
    logger.setTags({ callerId: payload.kiloUserId, callerKind: 'user' });
    return next();
  } catch {
    return c.json({ error: 'Unauthorized' }, 401);
  }
});
