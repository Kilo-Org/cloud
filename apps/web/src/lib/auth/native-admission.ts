import 'server-only';
import { randomBytes, createHash } from 'node:crypto';
import { getEnvVariable } from '@/lib/dotenvx';
import { captureMessage } from '@sentry/nextjs';
import { db } from '@/lib/drizzle';
import type { DrizzleTransaction } from '@/lib/drizzle';
import { native_admission_challenges, native_attested_keys } from '@kilocode/db/schema';
import { eq, and, lt, isNull, gt } from 'drizzle-orm';
import { checkRateLimit } from '@vercel/firewall';
import type { NextRequest } from 'next/server';
import { verifyAppleAttestation, verifyAppleAssertion } from './native-admission-apple';
import { verifyPlayIntegrity } from './native-admission-google';

// ── Types ──────────────────────────────────────────────────────────────────

export type NativeAdmissionMode = 'off' | 'report' | 'enforce';

export type AdmissionPlatform = 'ios' | 'android';

export type AdmissionKind = 'attestation' | 'assertion';

export type NativeAdmissionResult = { ok: true } | { ok: false; errorCode: 'ADMISSION_REQUIRED' };

// ── Wire contract ──────────────────────────────────────────────────────────

/**
 * Admission payload as received from the mobile client.
 *
 * Plan contract:
 *   admission: { platform: 'ios'|'android', kind: 'attestation'|'assertion',
 *                challenge: string, payload: string, keyId?: string }
 */
export type AdmissionPayload = {
  platform: AdmissionPlatform;
  kind: AdmissionKind;
  challenge: string;
  /** Base64-encoded platform-specific data (attestation, assertion, or integrity token) */
  payload: string;
  /** Required for iOS attestation and assertion */
  keyId?: string;
};

// ── Challenge lifecycle ────────────────────────────────────────────────────

export const CHALLENGE_EXPIRY_MS = 2 * 60 * 1000; // 2 minutes
const CHALLENGE_RATE_LIMIT_ID = 'native-admission-challenge';

/**
 * Issue a server-side challenge for native admission.
 *
 * Uses @vercel/firewall checkRateLimit per client IP, matching the email
 * sign-in rate-limit pattern.
 */
export async function issueAdmissionChallenge(
  request: NextRequest,
  ipAddress: string
): Promise<{ challenge: string; expiresIn: number }> {
  const { rateLimited } = await checkRateLimit(CHALLENGE_RATE_LIMIT_ID, {
    request,
    rateLimitKey: `native-challenge:${ipAddress}`,
  });

  if (rateLimited) {
    throw new ChallengeRateLimitError();
  }

  const challenge = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + CHALLENGE_EXPIRY_MS);

  await db.insert(native_admission_challenges).values({
    challenge,
    expires_at: expiresAt.toISOString(),
  });

  return { challenge, expiresIn: Math.floor(CHALLENGE_EXPIRY_MS / 1000) };
}

export class ChallengeRateLimitError extends Error {
  constructor() {
    super('Too many challenges');
    this.name = 'ChallengeRateLimitError';
  }
}

// ── Admission payload validation ───────────────────────────────────────────

/**
 * Validate the shape of the admission payload received from the client.
 * Returns a sanitized AdmissionPayload on success, undefined on failure.
 */
export function validateAdmissionPayload(raw: unknown): AdmissionPayload | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const obj = raw as Record<string, unknown>;

  // platform: 'ios' | 'android'
  if (obj['platform'] !== 'ios' && obj['platform'] !== 'android') return undefined;

  // kind: 'attestation' | 'assertion'
  if (obj['kind'] !== 'attestation' && obj['kind'] !== 'assertion') return undefined;

  // challenge: non-empty string
  if (typeof obj['challenge'] !== 'string' || !obj['challenge']) return undefined;

  // payload: non-empty string (base64)
  if (typeof obj['payload'] !== 'string' || !obj['payload']) return undefined;

  // keyId: optional string (required for iOS assertion)
  const kind = obj['kind'] as AdmissionKind;
  const platform = obj['platform'] as AdmissionPlatform;
  const keyId = obj['keyId'];

  if (platform === 'ios') {
    // iOS requires keyId for both attestation and assertion
    if (typeof keyId !== 'string' || !keyId) return undefined;
  }

  return {
    platform,
    kind,
    challenge: obj['challenge'],
    payload: obj['payload'],
    keyId: typeof keyId === 'string' ? keyId : undefined,
  };
}

// ── Admission gate (sync) ──────────────────────────────────────────────────

/**
 * Evaluate admission for a native auth request body.
 *
 * Mode behaviour:
 * - 'off':      admit everything.
 * - 'report':   evaluate and log, always admit.
 * - 'enforce':  validate admission. Absent field = legacy admit + count.
 *               Present invalid = refuse. Provider fault = 5xx via throw.
 *
 * Returns whether async verification is needed ('report' and 'enforce' modes
 * with a valid admission payload).
 */
export function checkNativeAdmission(body: Record<string, unknown>): {
  admission: NativeAdmissionResult;
  /** True when async crypto verification is needed (enforce or report). */
  verifyAsync: boolean;
} {
  const mode = getEnvVariable('NATIVE_ADMISSION_MODE') as NativeAdmissionMode;

  // off mode (or unset) always admits with no async verification
  if (!mode || mode === 'off') {
    return { admission: { ok: true }, verifyAsync: false };
  }

  const hasAdmission = 'admission' in body && body['admission'] !== undefined;

  if (!hasAdmission) {
    if (mode === 'enforce') {
      captureMessage('native_admission_legacy_count: 1');
    }
    return { admission: { ok: true }, verifyAsync: false };
  }

  // Validate the admission payload shape synchronously.
  const admission = validateAdmissionPayload(body['admission']);
  if (!admission) {
    if (mode === 'report') {
      captureMessage('native_admission_invalid_shape');
      return { admission: { ok: true }, verifyAsync: false };
    }
    return { admission: { ok: false, errorCode: 'ADMISSION_REQUIRED' }, verifyAsync: false };
  }

  // Valid payload — async verification needed for enforce and report modes.
  return { admission: { ok: true }, verifyAsync: mode === 'enforce' || mode === 'report' };
}

/**
 * Whether to refuse admission when the async verify fails.
 * Only true under enforce mode; report mode evaluates but always admits.
 */
export function shouldRefuseAsyncFailure(): boolean {
  const mode = getEnvVariable('NATIVE_ADMISSION_MODE') as NativeAdmissionMode;
  return mode === 'enforce';
}

// ── Async attestation / assertion verification ─────────────────────────────

/**
 * Perform full async admission verification BEFORE user settlement.
 *
 * Must be called before createOrUpdateUser in the token route so that:
 * - Failed admission under enforce never leaves a settled user.
 * - Keys are written after the user id exists (via the token route after
 *   successful settlement).
 *
 * Atomically consumes the challenge. On provider infrastructure errors,
 * throws so the caller can surface a 5xx.
 *
 * Returns the key data to persist after settlement, or an error.
 */
export type VerifyAdmissionOk = {
  ok: true;
  /** Platform that verified */
  platform: AdmissionPlatform;
  /** The keyId for the attested/asserted key */
  keyId: string;
  /** DER-encoded SPKI public key (base64) — set on attestation only */
  publicKey?: string;
  /** Sign count from the assertion authenticator data — set on assertion only */
  signCount?: number;
  /** The userId that owns this key (from DB row) — set on assertion only */
  existingKeyUserId?: string;
};

export async function verifyAdmissionAsync(
  admission: AdmissionPayload
): Promise<VerifyAdmissionOk | { ok: false; errorCode: string }> {
  // Atomically consume the challenge
  const now = new Date().toISOString();
  const [consumed] = await db
    .update(native_admission_challenges)
    .set({ consumed_at: now })
    .where(
      and(
        eq(native_admission_challenges.challenge, admission.challenge),
        gt(native_admission_challenges.expires_at, now),
        isNull(native_admission_challenges.consumed_at)
      )
    )
    .returning();

  if (!consumed) {
    return { ok: false, errorCode: 'ADMISSION_REQUIRED' };
  }

  // Route to platform-specific verifier
  if (admission.platform === 'ios') {
    return verifyAppleAdmission(admission);
  }

  if (admission.platform === 'android') {
    return verifyAndroidAdmission(admission);
  }

  return { ok: false, errorCode: 'ADMISSION_REQUIRED' };
}

// ── Apple (iOS) admission ──────────────────────────────────────────────────

async function verifyAppleAdmission(
  admission: AdmissionPayload
): Promise<VerifyAdmissionOk | { ok: false; errorCode: string }> {
  const { kind, challenge, payload, keyId } = admission;

  if (!keyId) {
    return { ok: false, errorCode: 'ADMISSION_REQUIRED' };
  }

  if (kind === 'attestation') {
    // First-time attestation: verify and extract public key
    const result = await verifyAppleAttestation(payload, challenge, keyId);

    if (!result.ok) {
      captureMessage(`apple_attestation_failed: ${result.error}`);
      return { ok: false, errorCode: 'ADMISSION_REQUIRED' };
    }

    // Check whether this keyId already exists — the caller uses this for
    // preflight ownership checks before committing a sign-in code.
    const existingKey = await db.query.native_attested_keys.findFirst({
      where: and(eq(native_attested_keys.key_id, keyId), eq(native_attested_keys.platform, 'ios')),
    });

    return {
      ok: true,
      platform: 'ios',
      keyId,
      publicKey: result.publicKeySpkiBase64,
      existingKeyUserId: existingKey?.kilo_user_id,
    };
  }

  // kind === 'assertion': verify against existing key
  // Must have an existing attested key
  const existingKey = await db.query.native_attested_keys.findFirst({
    where: and(eq(native_attested_keys.key_id, keyId), eq(native_attested_keys.platform, 'ios')),
  });

  if (!existingKey) {
    captureMessage('apple_assertion_unknown_key');
    return { ok: false, errorCode: 'ADMISSION_REQUIRED' };
  }

  // Cross-user key collision: the caller must check ownership after settlement
  // (we return the existing user id for that check)

  const assertionResult = await verifyAppleAssertion(
    keyId,
    createHash('sha256').update(Buffer.from(challenge, 'base64url')).digest(),
    payload,
    existingKey.public_key
  );

  if (!assertionResult.ok) {
    captureMessage(`apple_assertion_failed: ${assertionResult.error}`);
    return { ok: false, errorCode: 'ADMISSION_REQUIRED' };
  }

  // Atomic monotonic sign-count gate. The check and the update are a single
  // conditional UPDATE requiring sign_count < assertion count, so two
  // concurrent assertions cannot both accept the same count and a lower or
  // equal count can never overwrite a higher stored count. Zero updated rows
  // means the assertion is stale or replayed — refuse admission.
  const [updatedKey] = await db
    .update(native_attested_keys)
    .set({ sign_count: assertionResult.signCount })
    .where(
      and(
        eq(native_attested_keys.key_id, keyId),
        eq(native_attested_keys.platform, 'ios'),
        eq(native_attested_keys.kilo_user_id, existingKey.kilo_user_id),
        lt(native_attested_keys.sign_count, assertionResult.signCount)
      )
    )
    .returning({ key_id: native_attested_keys.key_id });

  if (!updatedKey) {
    // The update matched zero rows, so the assertion is stale or replayed.
    // Report only the asserted count: `existingKey.sign_count` is the pre-read
    // value and may have been advanced by a concurrent assertion, so it must
    // not be presented as the current database count.
    captureMessage(
      `apple_assertion_stale_or_replayed: asserted ${assertionResult.signCount} rejected`
    );
    return { ok: false, errorCode: 'ADMISSION_REQUIRED' };
  }

  return {
    ok: true,
    platform: 'ios',
    keyId,
    signCount: assertionResult.signCount,
    existingKeyUserId: existingKey.kilo_user_id,
  };
}

// ── Android (Play Integrity) admission ─────────────────────────────────────

async function verifyAndroidAdmission(
  admission: AdmissionPayload
): Promise<VerifyAdmissionOk | { ok: false; errorCode: string }> {
  const { kind, challenge, payload } = admission;

  // Android sends Play Integrity tokens with kind 'assertion' per the plan.
  if (kind !== 'assertion') {
    return { ok: false, errorCode: 'ADMISSION_REQUIRED' };
  }

  // verifyPlayIntegrity throws on infrastructure faults — caller must
  // catch and surface as 5xx.
  const result = await verifyPlayIntegrity(payload, challenge);

  if (!result.ok) {
    captureMessage(`play_integrity_failed: ${result.error}`);
    return { ok: false, errorCode: 'ADMISSION_REQUIRED' };
  }

  // Android Play Integrity tokens are per-request — no persistent key
  // tracking. We return an empty keyId so the caller skips persistence.
  return {
    ok: true,
    platform: 'android',
    keyId: '',
  };
}

// ── Key persistence (after settlement) ─────────────────────────────────────

/**
 * Persist an attested key after user settlement.
 *
 * For attestation: inserts a new key row.
 * For assertion: verification already advanced `sign_count` atomically in
 * `verifyAppleAdmission`; persistence only refreshes `last_used_at`.
 *
 * Cross-user collision: if the keyId already exists for a different user,
 * refuses the insert/update.
 */
export async function persistAttestedKey(
  userId: string,
  verification: VerifyAdmissionOk
): Promise<void> {
  // Android has no persistent key tracking — skip.
  if (verification.platform === 'android') return;

  if (verification.publicKey !== undefined) {
    // Attestation: insert new key
    await db
      .insert(native_attested_keys)
      .values({
        key_id: verification.keyId,
        kilo_user_id: userId,
        platform: verification.platform,
        public_key: verification.publicKey,
        sign_count: 0,
        attested_at: new Date().toISOString(),
      })
      .onConflictDoNothing();

    // Verify the inserted key belongs to this user (cross-user collision check)
    const inserted = await db.query.native_attested_keys.findFirst({
      where: and(
        eq(native_attested_keys.key_id, verification.keyId),
        eq(native_attested_keys.platform, verification.platform)
      ),
    });

    if (!inserted || inserted.kilo_user_id !== userId) {
      captureMessage('native_attested_key_cross_user_collision');
      throw new KeyCollisionError();
    }
  } else if (verification.signCount !== undefined) {
    // Assertion: refresh last_used_at only. The sign count was already bumped
    // atomically during verification; never rewrite it here so a stale
    // assertion cannot regress a newer count. The ownership predicate is
    // preserved.
    const now = new Date().toISOString();
    await db
      .update(native_attested_keys)
      .set({
        last_used_at: now,
      })
      .where(
        and(
          eq(native_attested_keys.key_id, verification.keyId),
          eq(native_attested_keys.platform, verification.platform),
          eq(native_attested_keys.kilo_user_id, userId)
        )
      );
  }
}

export class KeyCollisionError extends Error {
  constructor() {
    super('Attested key already belongs to a different user');
    this.name = 'KeyCollisionError';
  }
}

/**
 * Persist an attested key within an existing Drizzle transaction.
 *
 * Same semantics as `persistAttestedKey` but uses the supplied transaction
 * instead of the default `db` instance. Used when key persistence must be
 * atomic with device session creation.
 */
export async function persistAttestedKeyTx(
  tx: DrizzleTransaction,
  userId: string,
  verification: VerifyAdmissionOk
): Promise<void> {
  if (verification.platform === 'android') return;

  if (verification.publicKey !== undefined) {
    // Attestation: insert new key
    await tx
      .insert(native_attested_keys)
      .values({
        key_id: verification.keyId,
        kilo_user_id: userId,
        platform: verification.platform,
        public_key: verification.publicKey,
        sign_count: 0,
        attested_at: new Date().toISOString(),
      })
      .onConflictDoNothing();

    // Verify the inserted key belongs to this user (cross-user collision check)
    const inserted = await tx.query.native_attested_keys.findFirst({
      where: and(
        eq(native_attested_keys.key_id, verification.keyId),
        eq(native_attested_keys.platform, verification.platform)
      ),
    });

    if (!inserted || inserted.kilo_user_id !== userId) {
      captureMessage('native_attested_key_cross_user_collision');
      throw new KeyCollisionError();
    }
  } else if (verification.signCount !== undefined) {
    // Assertion: refresh last_used_at only. The sign count was already bumped
    // atomically during verification; never rewrite it here so a stale
    // assertion cannot regress a newer count. The ownership predicate is
    // preserved.
    const now = new Date().toISOString();
    await tx
      .update(native_attested_keys)
      .set({
        last_used_at: now,
      })
      .where(
        and(
          eq(native_attested_keys.key_id, verification.keyId),
          eq(native_attested_keys.platform, verification.platform),
          eq(native_attested_keys.kilo_user_id, userId)
        )
      );
  }
}

// ── Cleanup ────────────────────────────────────────────────────────────────

/**
 * Delete expired admission challenges. Called by the cron job.
 */
export async function cleanupExpiredAdmissionChallenges(): Promise<number> {
  const result = await db
    .delete(native_admission_challenges)
    .where(lt(native_admission_challenges.expires_at, new Date().toISOString()))
    .returning({ challenge: native_admission_challenges.challenge });

  return result.length;
}
