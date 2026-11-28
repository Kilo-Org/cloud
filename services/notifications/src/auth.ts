import { createMiddleware } from 'hono/factory';
import {
  verifyKiloBearerAgainstCurrentPepper,
  type KiloBearerAuthResult,
} from '@kilocode/worker-utils/kilo-token-auth';
import { extractBearerToken } from '@kilocode/worker-utils';
import { NOTIFICATIONS_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import {
  logCredentialRefused,
  logSecretUnavailable,
  readNotificationsSecret,
  secretRefusal,
  secretsSource,
  secretsSourceLabel,
  type GuardRoute,
  type NotificationsSecretsSource,
} from './secrets';
import { secretsComparison } from './secrets-compare';
import { logger } from './util/logger';

export type AuthContext = {
  callerId: string;
  callerKind: 'user';
};

/** Fixed log labels for the `/v1/*` paths; the request path itself is never logged. */
const V1_ROUTES: Partial<Record<string, GuardRoute>> = {
  '/v1/badges': 'badges',
  '/v1/badges/mark-read': 'badges_mark_read',
};

/**
 * Public HTTP auth for the notifications worker — humans only. The bearer is
 * a Kilo JWT verified with NEXTAUTH_SECRET from the selected secrets source.
 * Every 401 logs one line of fixed labels: route, secret name, source and reason.
 *
 * The worker also exposes RPC methods to other workers (e.g. kilo-chat). RPC
 * callers don't go through this middleware; HTTP traffic is JWT-only.
 */
export const authMiddleware = createMiddleware<{
  Bindings: Env;
  Variables: AuthContext;
}>(async (c, next) => {
  const route = V1_ROUTES[c.req.path] ?? 'v1_other';
  const labels = {
    route,
    secret: 'NEXTAUTH_SECRET',
    source: secretsSourceLabel(c.env),
  } as const;
  const token = extractBearerToken(c.req.header('authorization'));
  if (!token) {
    logCredentialRefused({ ...labels, reason: 'missing' });
    return c.json({ error: 'Unauthorized' }, 401);
  }

  // The Secrets Store source hands the verifier its binding, which keeps the verifier's
  // per-isolate cache and its refusal of an empty value. The STS source hands it the bundle
  // value, refused here when empty. A failed read on either source answers 401, and so does a
  // deployment that binds no signer (the closed staging environment), before the verifier or
  // any database read.
  let source: NotificationsSecretsSource;
  let nextAuthSecret: string | SecretsStoreSecret | undefined;
  try {
    source = secretsSource(c.env);
    nextAuthSecret =
      source === 'sts'
        ? await readNotificationsSecret(c.env, 'NEXTAUTH_SECRET', c.executionCtx)
        : c.env.NEXTAUTH_SECRET;
  } catch (error) {
    logSecretUnavailable({ ...labels, reason: secretRefusal(c.env, 'NEXTAUTH_SECRET', error) });
    return c.json({ error: 'Unauthorized' }, 401);
  }
  if (nextAuthSecret === undefined || nextAuthSecret === '') {
    const reason = nextAuthSecret === undefined ? 'binding_missing' : 'empty';
    logSecretUnavailable({ ...labels, reason });
    return c.json({ error: 'Unauthorized' }, 401);
  }

  let auth: KiloBearerAuthResult | null;
  try {
    auth = await verifyKiloBearerAgainstCurrentPepper({
      token,
      nextAuthSecret,
      workerEnv: c.env.WORKER_ENV,
      connectionString: c.env.HYPERDRIVE.connectionString,
      resourceAudience: { audience: NOTIFICATIONS_AUDIENCE, mode: 'allow-legacy' },
    });
  } catch {
    logCredentialRefused({ ...labels, reason: 'verify_failed' });
    return c.json({ error: 'Unauthorized' }, 401);
  }
  if (!auth) {
    logCredentialRefused({ ...labels, reason: 'invalid' });
    // Only a value this check already read is compared (the `sts` source); the Secrets Store
    // binding is the verifier's to read. At most one background check per isolate and route when
    // enabled (src/secrets-compare.ts); it never changes this answer.
    if (typeof nextAuthSecret === 'string') {
      secretsComparison.refused(c.env, () => c.executionCtx, {
        route,
        source,
        secret: 'NEXTAUTH_SECRET',
        selected: nextAuthSecret,
      });
    }
    return c.json({ error: 'Unauthorized' }, 401);
  }

  c.set('callerId', auth.userId);
  c.set('callerKind', 'user');
  logger.setTags({ callerId: auth.userId, callerKind: 'user' });
  return next();
});
