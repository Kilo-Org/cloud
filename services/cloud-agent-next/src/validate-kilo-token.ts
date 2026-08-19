import { extractBearerToken } from '@kilocode/worker-utils';
import { verifyKiloBearerAgainstCurrentPepper } from '@kilocode/worker-utils/kilo-token-auth';

export async function validateKiloToken(
  authHeader: string | null,
  params: {
    secret: string | null | undefined;
    connectionString: string;
    workerEnv?: string;
  }
): Promise<
  | { success: true; userId: string; token: string; botId?: string }
  | { success: false; error: string }
> {
  const { secret, connectionString, workerEnv } = params;
  if (!secret) {
    return { success: false, error: 'NEXTAUTH_SECRET is not configured on the worker' };
  }

  const token = extractBearerToken(authHeader);
  if (!token) {
    return { success: false, error: 'Missing or malformed Authorization header' };
  }

  const auth = await verifyKiloBearerAgainstCurrentPepper({
    token,
    nextAuthSecret: secret,
    connectionString,
    ...(workerEnv ? { workerEnv } : {}),
  });

  if (!auth) {
    return { success: false, error: 'Invalid or expired token' };
  }

  return { success: true, userId: auth.userId, token, botId: auth.botId };
}
