import { EVENT_SERVICE_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import {
  type GetKiloUserPepper,
  verifyKiloBearerAgainstCurrentPepper,
} from '@kilocode/worker-utils/kilo-token-auth';
import type { SecretsExecutionContext } from '@kilocode/secrets-client';
import {
  logSecretUnavailable,
  readEventServiceSecret,
  secretRefusal,
  secretsSourceLabel,
  type GuardRoute,
  type SecretRefusal,
} from './secrets';
import { secretsComparison, type SecretsCompareEnv } from './secrets-compare';

export type AuthResult = { userId: string };
export type AuthEnv = Pick<Env, 'WORKER_ENV'> &
  SecretsCompareEnv & {
    HYPERDRIVE: Pick<Env['HYPERDRIVE'], 'connectionString'>;
  };
export type AuthenticateTokenOptions = {
  getUserPepper?: GetKiloUserPepper;
  /** The invocation's context, so a bundle revalidation runs under its `waitUntil`. */
  ctx?: SecretsExecutionContext;
};

/** The fixed route label: `POST /connect-ticket` is this check's one caller. */
const ROUTE: GuardRoute = 'connect_ticket';

function logSignerUnavailable(env: AuthEnv, reason: SecretRefusal): void {
  logSecretUnavailable({
    route: ROUTE,
    secret: 'NEXTAUTH_SECRET',
    source: secretsSourceLabel(env),
    reason,
  });
}

/**
 * A failed or empty signer read logs one line of fixed labels (route, secret name, source,
 * reason); it changes neither the answer nor the error. A refused bearer logs nothing here: the
 * route's duration line already counts every 401, and a per-401 line would repeat it millions of
 * times a day.
 */
export async function authenticateToken(
  token: string | null,
  env: AuthEnv,
  options: AuthenticateTokenOptions = {}
): Promise<AuthResult | null> {
  // The exact value this call's own read handed the verifier. It stays `undefined` when the
  // verifier answers from its isolate cache, and is never cached or served from here.
  let selected: string | undefined;
  const auth = await verifyKiloBearerAgainstCurrentPepper({
    token,
    // A lazy binding, not an eager read: the verifier caches the resolved value by name for the
    // isolate, so one read serves every later request whichever source `SECRETS_SOURCE` selects.
    nextAuthSecret: {
      get: async () => {
        let value: string;
        try {
          value = await readEventServiceSecret(env, 'NEXTAUTH_SECRET', options.ctx);
        } catch (error) {
          logSignerUnavailable(env, secretRefusal(env, 'NEXTAUTH_SECRET', error));
          throw error;
        }
        if (value === '') logSignerUnavailable(env, 'empty');
        else selected = value;
        return value;
      },
    },
    workerEnv: env.WORKER_ENV,
    connectionString: env.HYPERDRIVE.connectionString,
    resourceAudience: { audience: EVENT_SERVICE_AUDIENCE, mode: 'allow-legacy' },
    ...(options.getUserPepper ? { getUserPepper: options.getUserPepper } : {}),
  });
  if (!auth) return null;
  // At most one background check per isolate when enabled (src/secrets-compare.ts), and only on an
  // acceptance whose own read supplied the verified value; a cache-only acceptance leaves it armed.
  // It never changes this answer.
  if (selected !== undefined) {
    secretsComparison.admitted(env, options.ctx, { route: ROUTE, selected });
  }
  return auth;
}
