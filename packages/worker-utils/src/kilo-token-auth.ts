import { getWorkerDb } from '@kilocode/db/client';
import { kilocode_users } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

import { getCachedSecret } from './cached-secret';
import { verifyKiloToken } from './kilo-token';

export type KiloBearerAuthResult = {
  userId: string;
};

export type KiloSecretBinding = {
  get(): Promise<string | null>;
};

export type GetKiloUserPepper = (
  connectionString: string,
  userId: string
) => Promise<string | null | undefined>;

export async function findKiloUserPepper(
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

export async function verifyKiloBearerAgainstCurrentPepper(params: {
  token: string | null;
  nextAuthSecret: KiloSecretBinding;
  workerEnv: string;
  connectionString: string;
  getUserPepper?: GetKiloUserPepper;
}): Promise<KiloBearerAuthResult | null> {
  if (!params.token) return null;

  const getUserPepper = params.getUserPepper ?? findKiloUserPepper;

  try {
    const secret = await getCachedSecret(params.nextAuthSecret, 'NEXTAUTH_SECRET');
    const payload = await verifyKiloToken(params.token, secret);
    if (payload.env !== params.workerEnv) {
      return null;
    }

    const currentPepper = await getUserPepper(params.connectionString, payload.kiloUserId);
    const tokenPepper = payload.apiTokenPepper ?? null;
    if (currentPepper === undefined || currentPepper !== tokenPepper) {
      return null;
    }
    return { userId: payload.kiloUserId };
  } catch {
    return null;
  }
}
