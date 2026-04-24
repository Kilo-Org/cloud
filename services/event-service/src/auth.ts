import { getCachedSecret, verifyKiloToken } from '@kilocode/worker-utils';

export type AuthResult = { userId: string };

export async function authenticateToken(
  token: string | null,
  env: Env
): Promise<AuthResult | null> {
  if (!token) return null;
  try {
    const secret = await getCachedSecret(env.NEXTAUTH_SECRET, 'NEXTAUTH_SECRET');
    const payload = await verifyKiloToken(token, secret);
    return { userId: payload.kiloUserId };
  } catch {
    return null;
  }
}
