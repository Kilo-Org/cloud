import {
  type GetKiloUserPepper,
  verifyKiloBearerAgainstCurrentPepper,
} from '@kilocode/worker-utils/kilo-token-auth';

export type AuthResult = { userId: string };
export type AuthEnv = Pick<Env, 'NEXTAUTH_SECRET' | 'WORKER_ENV'> & {
  HYPERDRIVE: Pick<Env['HYPERDRIVE'], 'connectionString'>;
};
export type AuthenticateTokenOptions = {
  getUserPepper?: GetKiloUserPepper;
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
    ...(options.getUserPepper ? { getUserPepper: options.getUserPepper } : {}),
  });
}
