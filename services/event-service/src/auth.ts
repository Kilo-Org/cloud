import { verifyKiloToken } from '@kilocode/worker-utils';

export type AuthResult = { userId: string };

export async function authenticateToken(
  token: string | null,
  env: Env
): Promise<AuthResult | null> {
  if (!token) return null;
  try {
    const secret = await env.NEXTAUTH_SECRET.get();
    if (!secret) return null;
    const payload = await verifyKiloToken(token, secret);
    return { userId: payload.kiloUserId };
  } catch {
    return null;
  }
}
