import 'server-only';
import { randomBytes } from 'node:crypto';
import { getEnvVariable } from '@kilocode/web-shared/lib/dotenvx';
import { db } from '@kilocode/web-shared/lib/drizzle';
import type { DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import { native_admission_challenges, native_attested_keys } from '@kilocode/db/schema';
import { eq, and, lt, isNull, gt } from 'drizzle-orm';
import type { NextRequest } from 'next/server';
import {
  appAttestClientDataHash,
  verifyAppleAttestation,
  verifyAppleAssertion,
} from './native-admission-apple';
import { verifyPlayIntegrity } from './native-admission-google';
import { checkFirewallRateLimit } from './firewall-rate-limit';
import { countAdmissionCondition, rollAdmissionWindowIfNeeded } from './native-admission-telemetry';

// ── Expected-condition telemetry ───────────────────────────────────────────

export {
  countAdmissionCondition,
  resetAdmissionCountersForTests,
  rollAdmissionWindowIfNeeded,
} from './native-admission-telemetry';

// ── Types ──────────────────────────────────────────────────────────────────

export type AdmissionPlatform = 'ios' | 'android';

export type AdmissionKind = 'attestation' | 'assertion';

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
 * Runs the shared `checkFirewallRateLimit` per client IP, matching the email
 * sign-in rate-limit pattern, so the whole app keeps one check-and-report path.
 * Only an answer that permits the caller issues a challenge: a limited caller
 * is refused, and so is a limiter that could not be consulted. The shared
 * helper reports both an unconfigured rule and a limiter that could not be
 * evaluated through one throttled reporter.
 */
export async function issueAdmissionChallenge(
  request: NextRequest,
  ipAddress: string
): Promise<{ challenge: string; expiresIn: number }> {
  const limit = await checkFirewallRateLimit(CHALLENGE_RATE_LIMIT_ID, {
    source: 'native_admission_challenge',
    request,
    rateLimitKey: `native-challenge:${ipAddress}`,
  });

  if (limit !== 'allowed') {
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
 * Longest `payload` string the admission wire contract accepts, in characters
 * of the base64 form the client sends.
 *
 * Chosen from the size of a real device proof plus headroom: an App Attest
 * attestation object with either documented certificate chain shape stays well
 * inside this limit, and a Play Integrity verdict is a JWE of similar size.
 */
export const MAX_ADMISSION_PAYLOAD_CHARS = 16 * 1024;

/** Whether an admission object carries a payload longer than the contract accepts. */
function payloadExceedsMaxLength(obj: Record<string, unknown>): boolean {
  const payload = obj['payload'];
  return typeof payload === 'string' && payload.length > MAX_ADMISSION_PAYLOAD_CHARS;
}

/**
 * Validate the shape of the admission payload received from the client.
 * Returns a sanitized AdmissionPayload on success, undefined on failure.
 */
export function validateAdmissionPayload(raw: unknown): AdmissionPayload | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const obj = raw as Record<string, unknown>;

  if (obj['platform'] !== 'ios' && obj['platform'] !== 'android') return undefined;
  if (obj['kind'] !== 'attestation' && obj['kind'] !== 'assertion') return undefined;
  if (typeof obj['challenge'] !== 'string' || !obj['challenge']) return undefined;
  if (typeof obj['payload'] !== 'string' || !obj['payload']) return undefined;
  if (payloadExceedsMaxLength(obj)) return undefined;

  const kind = obj['kind'] as AdmissionKind;
  const platform = obj['platform'] as AdmissionPlatform;
  const keyId = obj['keyId'];

  if (platform === 'ios') {
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

// ── Admission gate ─────────────────────────────────────────────────────────

/**
 * The proof a native request must carry. Token issuance is attested-device
 * only: a missing or malformed `admission` field is refused, never admitted.
 * There is no legacy, report, or disabled mode — the only exception is the
 * non-production sentinel below, which no production request can reach.
 */
export function requireAdmissionPayload(
  body: Record<string, unknown>
): AdmissionPayload | undefined {
  // Roll the telemetry window on any native auth request, so the final window
  // of a sparse traffic pattern still flushes.
  rollAdmissionWindowIfNeeded(Date.now());

  const raw = body['admission'];
  if (
    typeof raw === 'object' &&
    raw !== null &&
    payloadExceedsMaxLength(raw as Record<string, unknown>)
  ) {
    // A payload longer than the contract accepts is aggregated as
    // native_admission_oversized.
    countAdmissionCondition('native_admission_oversized');
  }

  return validateAdmissionPayload(raw);
}

/**
 * Proof a non-production device sends when it cannot attest at all (simulator,
 * emulator without Play Services). Accepted only when the process is not
 * production and `NATIVE_ADMISSION_DEV_SENTINEL` is `true`; the branch skips
 * the platform verifier and persists no key.
 */
export const DEV_SENTINEL_PAYLOAD = 'native-admission-dev-sentinel';

function isDevSentinel(admission: AdmissionPayload): boolean {
  return (
    process.env.NODE_ENV !== 'production' &&
    getEnvVariable('NATIVE_ADMISSION_DEV_SENTINEL') === 'true' &&
    admission.payload === DEV_SENTINEL_PAYLOAD
  );
}

// ── Async attestation / assertion verification ─────────────────────────────

/**
 * Perform full async admission verification BEFORE user settlement.
 *
 * Must be called before createOrUpdateUser in the token route so that:
 * - Failed admission never leaves a settled user.
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
  /**
   * The keyId for the attested/asserted key. Absent when the platform has no
   * persistent key to track, which means the caller persists nothing.
   */
  keyId?: string;
  /** DER-encoded SPKI public key (base64) — set on attestation only */
  publicKey?: string;
  /** Sign count from the assertion authenticator data — set on assertion only */
  signCount?: number;
  /**
   * The userId that owns this key (from DB row) — set when the key id is already
   * bound to an account (attestation or assertion)
   */
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

  if (isDevSentinel(admission)) {
    // Android shape on purpose: no key id means nothing is persisted and the
    // device session is created without an attested-key binding.
    return { ok: true, platform: 'android' };
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
      // The error is a fixed server-side enum, so the per-cause metric stays
      // bounded — one metric per reason, like the Play Integrity counters.
      countAdmissionCondition(`apple_attestation_failed:${result.error}`);
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
    countAdmissionCondition('apple_assertion_unknown_key');
    return { ok: false, errorCode: 'ADMISSION_REQUIRED' };
  }

  // Cross-user key collision: the caller must check ownership after settlement
  // (we return the existing user id for that check)

  const assertionResult = await verifyAppleAssertion(
    appAttestClientDataHash(challenge),
    payload,
    existingKey.public_key
  );

  if (!assertionResult.ok) {
    countAdmissionCondition(`apple_assertion_failed:${assertionResult.error}`);
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
    countAdmissionCondition('apple_assertion_stale_or_replayed');
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
  // catch and surface as 5xx. Every refusal verdict it returns is counted
  // there on its own reason metric, so the admission layer adds no second
  // count: each counted refusal is reported exactly once.
  const result = await verifyPlayIntegrity(payload, challenge);

  if (!result.ok) {
    return { ok: false, errorCode: 'ADMISSION_REQUIRED' };
  }

  // Android Play Integrity tokens are per-request — no persistent key
  // tracking. The result carries no key id, so the caller persists nothing.
  return { ok: true, platform: 'android' };
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
 *
 * `executor` defaults to `db`. Pass a transaction when key persistence must be
 * atomic with device session creation.
 */
export async function persistAttestedKey(
  userId: string,
  verification: VerifyAdmissionOk,
  executor: typeof db | DrizzleTransaction = db
): Promise<void> {
  // Android has no persistent key tracking — skip.
  if (verification.platform === 'android') return;

  // A result without a key id has nothing to persist. Every verifier that
  // reaches here carries one.
  const { keyId } = verification;
  if (keyId === undefined) return;

  if (verification.publicKey !== undefined) {
    // Attestation: insert new key
    await executor
      .insert(native_attested_keys)
      .values({
        key_id: keyId,
        kilo_user_id: userId,
        platform: verification.platform,
        public_key: verification.publicKey,
        sign_count: 0,
        attested_at: new Date().toISOString(),
      })
      .onConflictDoNothing();

    // Verify the inserted key belongs to this user (cross-user collision check)
    const inserted = await executor.query.native_attested_keys.findFirst({
      where: and(
        eq(native_attested_keys.key_id, keyId),
        eq(native_attested_keys.platform, verification.platform)
      ),
    });

    if (!inserted || inserted.kilo_user_id !== userId) {
      // The caller reports the refusal: every route that persists a key counts
      // native_attested_key_cross_user_collision when it catches this error, so
      // reporting here as well would emit both a count and a per-event message.
      throw new KeyCollisionError();
    }
  } else if (verification.signCount !== undefined) {
    // Assertion: refresh last_used_at only. The sign count was already bumped
    // atomically during verification; never rewrite it here so a stale
    // assertion cannot regress a newer count. The ownership predicate is
    // preserved.
    const now = new Date().toISOString();
    await executor
      .update(native_attested_keys)
      .set({
        last_used_at: now,
      })
      .where(
        and(
          eq(native_attested_keys.key_id, keyId),
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
