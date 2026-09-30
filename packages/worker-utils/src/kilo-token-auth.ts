import { getWorkerDb } from '@kilocode/db/client';
import { kilocode_users } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { ZodError } from 'zod';

import { getCachedSecret } from './cached-secret';
import { verifyKiloToken } from './kilo-token';
import { verifyKiloTokenForResource, type KiloResourceAudiencePolicy } from './kilo-token-policy';

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
      blocked_reason: kilocode_users.blocked_reason,
    })
    .from(kilocode_users)
    .where(eq(kilocode_users.id, userId))
    .limit(1);
  const row = rows[0];
  if (!row) return undefined;
  return { pepper: row.api_token_pepper ?? null, blockedReason: row.blocked_reason };
}

type KiloBearerVerificationParams = {
  token: string | null;
  nextAuthSecret: KiloSecretBinding | string;
  workerEnv?: string;
  connectionString: string;
  getUserPepper?: GetKiloUserPepper;
  allowBlocked?: boolean;
} & KiloBearerAudienceOptions;

export type KiloBearerRejectionReason =
  | 'no_token'
  | 'token_verification_failed'
  | 'worker_env_mismatch'
  | 'unknown_user'
  | 'blocked_user'
  | 'pepper_mismatch';

export type KiloBearerTokenVerificationFailure =
  | 'expired'
  | 'signature'
  | 'audience'
  | 'malformed'
  | 'payload_schema'
  | 'other';

export type KiloBearerVerificationOutcome =
  | { ok: true; auth: KiloBearerAuthResult }
  | {
      ok: false;
      reason: KiloBearerRejectionReason;
      verificationFailure?: KiloBearerTokenVerificationFailure;
    };

/**
 * Classify a token-verification failure at the owning boundary. jose exposes
 * structured `code`/`claim` properties and zod throws `ZodError`, so this reads
 * properties and a class only — never an error message.
 *
 * `audience` is produced only by jose rejecting an `aud` claim. The shared
 * verifiers' own `Error('Unexpected token audience')` carries no `code`, and a
 * non-`aud` claim-validation failure (for example `maxTokenAge` on `iat`), both
 * fall through to `other`.
 */
function classifyTokenVerificationFailure(error: unknown): KiloBearerTokenVerificationFailure {
  if (error instanceof ZodError) return 'payload_schema';
  switch ((error as { code?: unknown } | null)?.code) {
    case 'ERR_JWT_EXPIRED':
      return 'expired';
    case 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED':
      return 'signature';
    case 'ERR_JWT_CLAIM_VALIDATION_FAILED':
      return (error as { claim?: unknown }).claim === 'aud' ? 'audience' : 'other';
    case 'ERR_JWT_INVALID':
    case 'ERR_JWS_INVALID':
      return 'malformed';
    default:
      return 'other';
  }
}

/**
 * Verify a Kilo bearer against the account's current pepper and active state,
 * reporting which check rejected the credential.
 *
 * Same contract as `verifyKiloBearerAgainstCurrentPepper` (which delegates
 * here): dependency failures (secret store, database) throw so a caller can map
 * an outage to a retryable 503.
 */
export async function verifyKiloBearerAgainstCurrentPepperWithOutcome(
  params: KiloBearerVerificationParams
): Promise<KiloBearerVerificationOutcome> {
  if (params.audience !== undefined && params.resourceAudience !== undefined) {
    throw new Error('Bearer audience and resource audience policies are mutually exclusive');
  }
  if (!params.token) return { ok: false, reason: 'no_token' };

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
  } catch (error) {
    return {
      ok: false,
      reason: 'token_verification_failed',
      verificationFailure: classifyTokenVerificationFailure(error),
    };
  }

  // Env check is skipped only when the caller does not pass a workerEnv.
  // When workerEnv is set, a token without env (or with a mismatched env) fails.
  if (params.workerEnv && payload.env !== params.workerEnv) {
    return { ok: false, reason: 'worker_env_mismatch' };
  }

  const result = await getUserPepper(params.connectionString, payload.kiloUserId);
  if (!result) {
    return { ok: false, reason: 'unknown_user' };
  }

  if (result.blockedReason !== null && !params.allowBlocked) {
    return { ok: false, reason: 'blocked_user' };
  }

  // Pepper equality is skipped only when the claim is absent (internal
  // service tokens). A present claim — string or null — is always compared.
  if (payload.apiTokenPepper !== undefined && result.pepper !== payload.apiTokenPepper) {
    return { ok: false, reason: 'pepper_mismatch' };
  }

  const authResult: KiloBearerAuthResult = { userId: payload.kiloUserId };
  if (payload.botId) {
    authResult.botId = payload.botId;
  }
  return { ok: true, auth: authResult };
}

/**
 * Verify a Kilo bearer against the account's current pepper and active state.
 *
 * Returns null only for a credential the caller must not retry: malformed,
 * expired, wrong env, unknown user, blocked user, or a stale pepper.
 * A dependency failure (secret store, database) throws, so a caller can map an
 * outage to a retryable 503 instead of reporting it as an invalid token.
 */
export async function verifyKiloBearerAgainstCurrentPepper(
  params: KiloBearerVerificationParams
): Promise<KiloBearerAuthResult | null> {
  const outcome = await verifyKiloBearerAgainstCurrentPepperWithOutcome(params);
  return outcome.ok ? outcome.auth : null;
}
