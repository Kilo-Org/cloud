import { createMiddleware } from 'hono/factory';
import { verifyKiloBearerAgainstCurrentPepper } from '@kilocode/worker-utils/kilo-token-auth';
import { extractBearerToken } from '@kilocode/worker-utils';
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
    const auth = await verifyKiloBearerAgainstCurrentPepper({
      token,
      nextAuthSecret: c.env.NEXTAUTH_SECRET,
      workerEnv: c.env.WORKER_ENV,
      connectionString: c.env.HYPERDRIVE.connectionString,
    });
    if (!auth) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    c.set('callerId', auth.userId);
    c.set('callerKind', 'user');
    logger.setTags({ callerId: auth.userId, callerKind: 'user' });
    return next();
  } catch {
    return c.json({ error: 'Unauthorized' }, 401);
  }
});
