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

export type KiloUserPepperResult = { pepper: string | null; blockedReason: string | null };

export type GetKiloUserPepper = (
  connectionString: string,
  userId: string
) => Promise<KiloUserPepperResult | null | undefined>;

export async function findKiloUserPepper(
  connectionString: string,
  userId: string
): Promise<KiloUserPepperResult | null | undefined> {
  const db = getWorkerDb(connectionString);
  const rows = await db
    .select({
      api_token_pepper: kilocode_users.api_token_pepper,
      blocked_reason: kilocode_users.blocked_reason,
    })
    .from(kilocode_users)
    .where(eq(kilocode_users.id, userId))
    .limit(1);
  const row = rows[0];
  if (!row) return undefined;
  return { pepper: row.api_token_pepper ?? null, blockedReason: row.blocked_reason };
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

    const result = await getUserPepper(params.connectionString, payload.kiloUserId);
    if (!result) {
      return null;
    }

    const tokenPepper = payload.apiTokenPepper ?? null;
    if (result.pepper !== tokenPepper) {
      return null;
    }

    if (result.blockedReason !== null) {
      return null;
    }

    return { userId: payload.kiloUserId };
  } catch {
    return null;
  }
}
