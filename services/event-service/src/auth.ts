import { EVENT_SERVICE_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import {
  type GetActiveDeviceSession,
  type GetKiloUserPepper,
  type KiloBearerAuthResult,
  verifyKiloBearerAgainstCurrentPepper,
} from '@kilocode/worker-utils/kilo-token-auth';

export type AuthResult = KiloBearerAuthResult;
export type AuthEnv = Pick<Env, 'NEXTAUTH_SECRET' | 'WORKER_ENV'> & {
  HYPERDRIVE: Pick<Env['HYPERDRIVE'], 'connectionString'>;
};
export type AuthenticateTokenOptions = {
  getUserPepper?: GetKiloUserPepper;
  getActiveDeviceSession?: GetActiveDeviceSession;
};

export async function authenticateToken(
  token: string | null,
  env: AuthEnv,
  options: AuthenticateTokenOptions = {}
): Promise<AuthResult | null> {
  return verifyKiloBearerAgainstCurrentPepper({
    token,
    nextAuthSecret: env.NEXTAUTH_SECRET,
    workerEnv: env.WORKER_ENV,
    connectionString: env.HYPERDRIVE.connectionString,
    resourceAudience: { audience: EVENT_SERVICE_AUDIENCE, mode: 'allow-legacy' },
    ...(options.getUserPepper ? { getUserPepper: options.getUserPepper } : {}),
    ...(options.getActiveDeviceSession
      ? { getActiveDeviceSession: options.getActiveDeviceSession }
      : {}),
  });
}
