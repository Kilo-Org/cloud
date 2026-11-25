import { getWorkerDb } from '@kilocode/db/client';
import { kilocode_users } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { decodeJwt } from 'jose';

import { getCachedSecret } from './cached-secret';
import { verifyKiloToken } from './kilo-token';
import {
  isKiloTokenPepperCurrent,
  isKiloUserCredentialPepperCurrent,
  type KiloTokenPepperClaims,
} from './kilo-token-pepper';
import { verifyKiloTokenForResource, type KiloResourceAudiencePolicy } from './kilo-token-policy';

export type KiloBearerAuthResult = {
  userId: string;
  botId?: string;
};

export type KiloSecretBinding = {
  get(): Promise<string | null>;
};

/** Account availability: a block recorded in either column makes the account blocked. */
export type KiloUserPepperResult = { pepper: string | null; blocked: boolean };

export type GetKiloUserPepper = (
  connectionString: string,
  userId: string
) => Promise<KiloUserPepperResult | null | undefined>;

type KiloBearerAudienceOptions =
  | {
      audience?: string;
      resourceAudience?: never;
    }
  | {
      audience?: never;
      resourceAudience?: KiloResourceAudiencePolicy;
    };

export async function findKiloUserPepper(
  connectionString: string,
  userId: string
): Promise<KiloUserPepperResult | null | undefined> {
  const db = getWorkerDb(connectionString);
  const rows = await db
    .select({
      api_token_pepper: kilocode_users.api_token_pepper,
      blocked_at: kilocode_users.blocked_at,
      blocked_reason: kilocode_users.blocked_reason,
    })
    .from(kilocode_users)
    .where(eq(kilocode_users.id, userId))
    .limit(1);
  const row = rows[0];
  if (!row) return undefined;
  return {
    pepper: row.api_token_pepper ?? null,
    blocked: Boolean(row.blocked_at || row.blocked_reason),
  };
}

type KiloBearerVerificationParams = {
  token: string | null;
  nextAuthSecret: KiloSecretBinding | string;
  workerEnv?: string;
  connectionString: string;
  getUserPepper?: GetKiloUserPepper;
  allowBlocked?: boolean;
} & KiloBearerAudienceOptions;

type PepperRule = (
  claims: KiloTokenPepperClaims,
  accountPepper: string | null,
  nowSeconds: number
) => boolean;

/**
 * Verify a Kilo user credential against the account's current pepper and active state. The token
 * must carry a current `apiTokenPepper` claim (`isKiloUserCredentialPepperCurrent`).
 *
 * Returns null only for a credential the caller must not retry: malformed,
 * expired, wrong env, unknown user, blocked user, or a missing or stale pepper.
 * A dependency failure (secret store, database) throws, so a caller can map an
 * outage to a retryable 503 instead of reporting it as an invalid token.
 */
export function verifyKiloBearerAgainstCurrentPepper(
  params: KiloBearerVerificationParams
): Promise<KiloBearerAuthResult | null> {
  return verifyKiloBearer(params, isKiloUserCredentialPepperCurrent);
}

/**
 * Like `verifyKiloBearerAgainstCurrentPepper`, but also accepts a short-lived internal assertion
 * without a pepper claim (`isKiloTokenPepperCurrent`). Use it only on a receiver that the web or
 * another Worker addresses such assertions to.
 */
export function verifyKiloBearerOrInternalAssertionAgainstCurrentPepper(
  params: KiloBearerVerificationParams
): Promise<KiloBearerAuthResult | null> {
  return verifyKiloBearer(params, isKiloTokenPepperCurrent);
}

async function verifyKiloBearer(
  params: KiloBearerVerificationParams,
  isPepperCurrent: PepperRule
): Promise<KiloBearerAuthResult | null> {
  if (params.audience !== undefined && params.resourceAudience !== undefined) {
    throw new Error('Bearer audience and resource audience policies are mutually exclusive');
  }
  if (!params.token) return null;

  const getUserPepper = params.getUserPepper ?? findKiloUserPepper;

  const secret =
    typeof params.nextAuthSecret === 'string'
      ? params.nextAuthSecret
      : await getCachedSecret(params.nextAuthSecret, 'NEXTAUTH_SECRET');

  let payload: Awaited<ReturnType<typeof verifyKiloToken>>;
  try {
    payload =
      params.resourceAudience === undefined
        ? await verifyKiloToken(
            params.token,
            secret,
            params.audience ? { audience: params.audience } : undefined
          )
        : await verifyKiloTokenForResource(params.token, secret, params.resourceAudience);
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

  if (result.blocked && !params.allowBlocked) {
    return null;
  }

  // The projected payload drops `tokenPurpose` and `aud`; the signature is already verified.
  const claims = { ...decodeJwt(params.token), ...payload };
  if (!isPepperCurrent(claims, result.pepper, Math.floor(Date.now() / 1000))) {
    return null;
  }

  const authResult: KiloBearerAuthResult = { userId: payload.kiloUserId };
  if (payload.botId) {
    authResult.botId = payload.botId;
  }
  return authResult;
}
