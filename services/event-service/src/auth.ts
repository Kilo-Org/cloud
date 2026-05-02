import { getWorkerDb } from '@kilocode/db/client';
import { kilocode_users } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { getCachedSecret, verifyKiloChatToken } from '@kilocode/worker-utils';

export type AuthResult = { userId: string };
export type AuthEnv = Pick<Env, 'HYPERDRIVE' | 'NEXTAUTH_SECRET' | 'WORKER_ENV'>;

async function findUserPepper(
  connectionString: string,
  userId: string
): Promise<string | null | undefined> {
  const db = getWorkerDb(connectionString);
  const rows = await db
    .select({ api_token_pepper: kilocode_users.api_token_pepper })
    .from(kilocode_users)
    .where(eq(kilocode_users.id, userId))
    .limit(1);
  const row = rows[0];
  return row ? (row.api_token_pepper ?? null) : undefined;
}

export async function authenticateToken(
  token: string | null,
  env: AuthEnv
): Promise<AuthResult | null> {
  if (!token) return null;
  try {
    const secret = await getCachedSecret(env.NEXTAUTH_SECRET, 'NEXTAUTH_SECRET');
    const payload = await verifyKiloChatToken(token, secret, env.WORKER_ENV);
    const currentPepper = await findUserPepper(env.HYPERDRIVE.connectionString, payload.userId);
    if (currentPepper === undefined || currentPepper !== payload.pepper) {
      return null;
    }
    return { userId: payload.userId };
  } catch {
    return null;
  }
}
