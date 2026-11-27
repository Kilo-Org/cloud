import { EVENT_SERVICE_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import {
  type GetKiloUserPepper,
  verifyKiloBearerAgainstCurrentPepper,
} from '@kilocode/worker-utils/kilo-token-auth';
import type { SecretsExecutionContext } from '@kilocode/secrets-client';
import { readEventServiceSecret, type EventServiceSecretsEnv } from './secrets';

export type AuthResult = { userId: string };
export type AuthEnv = Pick<Env, 'WORKER_ENV'> &
  EventServiceSecretsEnv & {
    HYPERDRIVE: Pick<Env['HYPERDRIVE'], 'connectionString'>;
  };
export type AuthenticateTokenOptions = {
  getUserPepper?: GetKiloUserPepper;
  /** The invocation's context, so a bundle revalidation runs under its `waitUntil`. */
  ctx?: SecretsExecutionContext;
};

export async function authenticateToken(
  token: string | null,
  env: AuthEnv,
  options: AuthenticateTokenOptions = {}
): Promise<AuthResult | null> {
  return verifyKiloBearerAgainstCurrentPepper({
    token,
    // A lazy binding, not an eager read: the verifier caches the resolved value by name for the
    // isolate, so one read serves every later request whichever source `SECRETS_SOURCE` selects.
    nextAuthSecret: { get: () => readEventServiceSecret(env, 'NEXTAUTH_SECRET', options.ctx) },
    workerEnv: env.WORKER_ENV,
    connectionString: env.HYPERDRIVE.connectionString,
    resourceAudience: { audience: EVENT_SERVICE_AUDIENCE, mode: 'allow-legacy' },
    ...(options.getUserPepper ? { getUserPepper: options.getUserPepper } : {}),
  });
}
