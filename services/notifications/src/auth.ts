import { createMiddleware } from 'hono/factory';
import { verifyKiloBearerAgainstCurrentPepper } from '@kilocode/worker-utils/kilo-token-auth';
import { extractBearerToken } from '@kilocode/worker-utils';
import { NOTIFICATIONS_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import { readNotificationsSecret, secretsSource } from './secrets';
import { logger } from './util/logger';

export type AuthContext = {
  callerId: string;
  callerKind: 'user';
};

/**
 * Public HTTP auth for the notifications worker — humans only. The bearer is
 * a Kilo JWT verified with NEXTAUTH_SECRET from the selected secrets source.
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
    // The Secrets Store source hands the verifier its binding, which keeps the verifier's
    // per-isolate cache and its refusal of an empty value. The STS source hands it the bundle
    // value, refused here when empty. A failed read on either source answers 401, and so does a
    // deployment that binds no signer (the closed staging environment), before the verifier or
    // any database read.
    const nextAuthSecret =
      secretsSource(c.env) === 'sts'
        ? await readNotificationsSecret(c.env, 'NEXTAUTH_SECRET', c.executionCtx)
        : c.env.NEXTAUTH_SECRET;
    if (nextAuthSecret === undefined || nextAuthSecret === '') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const auth = await verifyKiloBearerAgainstCurrentPepper({
      token,
      nextAuthSecret,
      workerEnv: c.env.WORKER_ENV,
      connectionString: c.env.HYPERDRIVE.connectionString,
      resourceAudience: { audience: NOTIFICATIONS_AUDIENCE, mode: 'allow-legacy' },
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
