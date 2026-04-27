import { createMiddleware } from 'hono/factory';
import { extractBearerToken, getCachedSecret, verifyKiloToken } from '@kilocode/worker-utils';
import { logger } from './util/logger';

export type AuthContext = {
  callerId: string;
  callerKind: 'user' | 'bot';
};

/**
 * Public HTTP auth for kilo-chat — humans only. The bearer is a Kilo JWT
 * verified with NEXTAUTH_SECRET.
 *
 * Bots (kiloclaw sandboxes) reach the bot surface via this Worker's RPC
 * methods (service binding from the kiloclaw worker). They never hit HTTP,
 * so this middleware is JWT-only and has no bot-identity path.
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
