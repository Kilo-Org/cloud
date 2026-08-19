import { getWorkerDb } from '@kilocode/db/client';
import { kilocode_users } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

import { getCachedSecret } from './cached-secret';
import { verifyKiloToken } from './kilo-token';

export type KiloBearerAuthResult = {
  userId: string;
  botId?: string;
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

/**
 * Verify a Kilo bearer against the account's current pepper and active state.
 *
 * Returns null only for a credential the caller must not retry: malformed,
 * expired, wrong env, unknown user, blocked user, or a stale pepper.
 * A dependency failure (secret store, database) throws, so a caller can map an
 * outage to a retryable 503 instead of reporting it as an invalid token.
 */
export async function verifyKiloBearerAgainstCurrentPepper(params: {
  token: string | null;
  nextAuthSecret: KiloSecretBinding | string;
  workerEnv?: string;
  connectionString: string;
  getUserPepper?: GetKiloUserPepper;
  audience?: string;
  allowBlocked?: boolean;
}): Promise<KiloBearerAuthResult | null> {
  if (!params.token) return null;

  const getUserPepper = params.getUserPepper ?? findKiloUserPepper;

  const secret =
    typeof params.nextAuthSecret === 'string'
      ? params.nextAuthSecret
      : await getCachedSecret(params.nextAuthSecret, 'NEXTAUTH_SECRET');

  let payload: Awaited<ReturnType<typeof verifyKiloToken>>;
  try {
    payload = await verifyKiloToken(
      params.token,
      secret,
      params.audience ? { audience: params.audience } : undefined
    );
  } catch {
    return null;
  }

  // Env check is skipped only when the caller does not pass a workerEnv.
  // When workerEnv is set, a token without env (or with a mismatched env) fails.
  if (params.workerEnv && payload.env !== params.workerEnv) {
    return null;
  }

  const result = await getUserPepper(params.connectionString, payload.kiloUserId);
  if (!result) {
    return null;
  }

  if (result.blockedReason !== null && !params.allowBlocked) {
    return null;
  }

  // Pepper equality is skipped only when the claim is absent (internal
  // service tokens). A present claim — string or null — is always compared.
  if (payload.apiTokenPepper !== undefined && result.pepper !== payload.apiTokenPepper) {
    return null;
  }

  const authResult: KiloBearerAuthResult = { userId: payload.kiloUserId };
  if (payload.botId) {
    authResult.botId = payload.botId;
  }
  return authResult;
}
