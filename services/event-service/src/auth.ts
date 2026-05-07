import { verifyKiloBearerAgainstCurrentPepper } from '@kilocode/worker-utils/kilo-token-auth';

export type AuthResult = { userId: string };
export type AuthEnv = Pick<Env, 'HYPERDRIVE' | 'NEXTAUTH_SECRET' | 'WORKER_ENV'>;

export async function authenticateToken(
  token: string | null,
  env: AuthEnv
): Promise<AuthResult | null> {
  return verifyKiloBearerAgainstCurrentPepper({
    token,
    nextAuthSecret: env.NEXTAUTH_SECRET,
    workerEnv: env.WORKER_ENV,
    connectionString: env.HYPERDRIVE.connectionString,
  });
}
