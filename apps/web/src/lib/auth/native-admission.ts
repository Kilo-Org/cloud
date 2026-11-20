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
import type { AppleAttestError } from './native-admission-apple';
import { verifyPlayIntegrity } from './native-admission-google';
import type { PlayIntegrityDiagnostics, PlayIntegrityError } from './native-admission-google';
import { checkFirewallRateLimit } from './firewall-rate-limit';
import {
  countAdmissionCondition,
  reportAdmissionRefusalOnce,
  rollAdmissionWindowIfNeeded,
} from './native-admission-telemetry';

// ── Expected-condition telemetry ───────────────────────────────────────────

export {
  countAdmissionCondition,
  resetAdmissionCountersForTests,
  rollAdmissionWindowIfNeeded,
} from './native-admission-telemetry';

/**
 * Counts one cross-user attested-key collision and sends the throttled
 * per-event report. Every route that catches `KeyCollisionError` calls this:
 * the count keeps the per-window volume, while the throttled report survives
 * an aggregate window this instance never closes.
 */
export function reportAttestedKeyCollision(): void {
  countAdmissionCondition('native_attested_key_cross_user_collision');
  countAdmissionCondition('native_admission_refused');
  reportAdmissionRefusalOnce('native_attested_key_cross_user_collision');
}

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

/**
 * Why the admission gate refused a request body. Every value names a shape
 * rule that failed, never a field value, so a telemetry record built from it
 * carries no client-supplied string. `absent` means the body had no
 * `admission` field at all; every other value means the field was supplied and
 * failed that rule.
 */
export type AdmissionMissingReason =
  | 'absent'
  | 'not_an_object'
  | 'platform_invalid'
  | 'kind_invalid'
  | 'challenge_missing'
  | 'payload_missing'
  | 'payload_oversized'
  | 'key_id_missing';

export type AdmissionClassification =
  | { ok: true; payload: AdmissionPayload }
  | { ok: false; reason: AdmissionMissingReason };

/**
 * Classify the admission payload received from the client against the wire
 * contract. This is the single shape rule `validateAdmissionPayload` and
 * `requireAdmissionPayload` apply; it additionally names the rule that failed.
 */
export function classifyAdmissionPayload(raw: unknown): AdmissionClassification {
  if (raw === undefined) return { ok: false, reason: 'absent' };
  if (typeof raw !== 'object' || raw === null) return { ok: false, reason: 'not_an_object' };
  const obj = raw as Record<string, unknown>;

  // Length is checked before the other shape rules so the aggregate counter
  // built on this reason keeps firing for every oversized payload, whatever
  // else about it is wrong. This preserves the pre-existing counter semantics.
  const rawPayload = obj['payload'];
  if (typeof rawPayload === 'string' && rawPayload.length > MAX_ADMISSION_PAYLOAD_CHARS) {
    return { ok: false, reason: 'payload_oversized' };
  }

  const platform = obj['platform'];
  if (platform !== 'ios' && platform !== 'android') {
    return { ok: false, reason: 'platform_invalid' };
  }

  const kind = obj['kind'];
  if (kind !== 'attestation' && kind !== 'assertion') {
    return { ok: false, reason: 'kind_invalid' };
  }

  const challenge = obj['challenge'];
  if (typeof challenge !== 'string' || !challenge) {
    return { ok: false, reason: 'challenge_missing' };
  }

  const payload = obj['payload'];
  if (typeof payload !== 'string' || !payload) {
    return { ok: false, reason: 'payload_missing' };
  }

  const keyId = obj['keyId'];
  if (platform === 'ios' && (typeof keyId !== 'string' || !keyId)) {
    return { ok: false, reason: 'key_id_missing' };
  }

  return {
    ok: true,
    payload: {
      platform,
      kind,
      challenge,
      payload,
      keyId: typeof keyId === 'string' ? keyId : undefined,
    },
  };
}

/**
 * Validate the shape of the admission payload received from the client.
 * Returns a sanitized AdmissionPayload on success, undefined on failure.
 */
export function validateAdmissionPayload(raw: unknown): AdmissionPayload | undefined {
  const result = classifyAdmissionPayload(raw);
  return result.ok ? result.payload : undefined;
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

  const result = classifyAdmissionPayload(body['admission']);
  // A payload longer than the contract accepts is aggregated as
  // native_admission_oversized.
  if (!result.ok && result.reason === 'payload_oversized') {
    countAdmissionCondition('native_admission_oversized');
  }
  return result.ok ? result.payload : undefined;
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
 * The one recovery a refused admission names, when the client can repair the
 * refusal itself. Only an iOS assertion whose key id this database has never
 * seen qualifies: the device holds a stored key id that was never persisted
 * here, so dropping it and attesting a new key is the fix.
 *
 * Nothing else gets a hint. A malformed or invalid attestation, an invalid or
 * replayed assertion, a stale sign count, a negative Play Integrity verdict, a
 * missing proof, and a key already bound to another account are all refusals
 * the client must not paper over with a new key.
 */
export type AdmissionRecoveryHint = 'IOS_ASSERTION_UNKNOWN_KEY';

/**
 * Fixed, log-safe reason a verifier refused a proof. Each value names the rule
 * that failed, never the values compared: no key id, nonce, digest, sign count,
 * or Google verdict string can reach a log record through it.
 */
export type AdmissionRefusalReason =
  | 'challenge_unknown_or_expired'
  | 'key_id_missing'
  | 'attestation_invalid_format'
  | 'attestation_cert_chain_invalid'
  | 'attestation_rp_id_mismatch'
  | 'attestation_nonce_mismatch'
  | 'attestation_key_id_mismatch'
  | 'assertion_key_unknown'
  | 'assertion_invalid'
  | 'assertion_stale_or_replayed'
  | 'integrity_token_invalid'
  | 'integrity_nonce_mismatch'
  | 'integrity_package_mismatch'
  | 'integrity_app_not_recognized'
  | 'integrity_cert_digest_mismatch'
  | 'integrity_device_not_recognized'
  | 'integrity_kind_unsupported';

/**
 * Where a refusal was decided. `apple` and `play_integrity` ran a platform
 * verifier; `challenge` failed before any verifier ran.
 */
export type AdmissionRefusalSource = 'challenge' | 'apple' | 'play_integrity';

/**
 * The log-safe description of a refusal. It is deliberately separate from the
 * wire response: `errorCode` stays what shipped clients read, and this detail
 * is what telemetry consumes.
 */
export type AdmissionRefusalDetail = {
  reason: AdmissionRefusalReason;
  source: AdmissionRefusalSource;
  /** The platform the parsed payload declared. */
  proofPlatform: AdmissionPlatform;
  /** The proof shape from the payload, for an Apple or Android refusal. */
  proofKind?: AdmissionKind;
  /** Allowlisted Play Integrity classification, on an Android refusal only. */
  android?: PlayIntegrityDiagnostics;
};

/**
 * A refused admission proof. `recovery` is set only for the unknown-key case
 * above; every other refusal leaves it undefined so the wire response stays
 * exactly what it was. `detail` is for telemetry only and never serialized to
 * the client.
 */
export type AdmissionRefusal = {
  ok: false;
  errorCode: string;
  recovery?: AdmissionRecoveryHint;
  detail: AdmissionRefusalDetail;
};

/**
 * Perform full async admission verification BEFORE user settlement.
 *
 * Must be called before createOrUpdateUser in the token route so that:
 * - Failed admission never leaves a settled user.
 * - Keys are written after the user id exists (via the token route after
 *   successful settlement).
 *
 * Atomically consumes the challenge, so a caller that retries a refusal must
 * fetch a fresh challenge. On provider infrastructure errors, throws so the
 * caller can surface a 5xx.
 *
 * Returns the key data to persist after settlement, or a refusal carrying the
 * recovery hint when the client may produce a new proof.
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
): Promise<VerifyAdmissionOk | AdmissionRefusal> {
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
    return {
      ok: false,
      errorCode: 'ADMISSION_REQUIRED',
      detail: {
        reason: 'challenge_unknown_or_expired',
        source: 'challenge',
        proofPlatform: admission.platform,
      },
    };
  }

  if (isDevSentinel(admission)) {
    // Android shape on purpose: no key id means nothing is persisted and the
    // device session is created without an attested-key binding.
    return { ok: true, platform: 'android' };
  }

  // The payload validator admits exactly these two platforms, so the dispatch
  // is total.
  return admission.platform === 'ios'
    ? verifyAppleAdmission(admission)
    : verifyAndroidAdmission(admission);
}

// ── Apple (iOS) admission ──────────────────────────────────────────────────

type AttestedKeyExecutor = typeof db | DrizzleTransaction;

/**
 * The attested-key row for one key id on one platform, read through the
 * supplied executor so a caller inside a transaction sees its own writes.
 *
 * Ownership is not implied: the row may belong to another account, and each
 * caller applies its own ownership predicate.
 */
function findAttestedKey(
  executor: AttestedKeyExecutor,
  keyId: string,
  platform: AdmissionPlatform
) {
  return executor.query.native_attested_keys.findFirst({
    where: and(eq(native_attested_keys.key_id, keyId), eq(native_attested_keys.platform, platform)),
  });
}

/**
 * Fixed reasons for each attestation verifier error. A lookup table keeps the
 * two enums from drifting: a new verifier error fails type checking here rather
 * than silently reporting an unmapped value.
 */
const ATTESTATION_REFUSAL_REASONS: Record<AppleAttestError, AdmissionRefusalReason> = {
  INVALID_ATTEST_FORMAT: 'attestation_invalid_format',
  CERT_CHAIN_INVALID: 'attestation_cert_chain_invalid',
  RP_ID_MISMATCH: 'attestation_rp_id_mismatch',
  NONCE_MISMATCH: 'attestation_nonce_mismatch',
  KEY_ID_MISMATCH: 'attestation_key_id_mismatch',
};

async function verifyAppleAdmission(
  admission: AdmissionPayload
): Promise<VerifyAdmissionOk | AdmissionRefusal> {
  const { kind, challenge, payload, keyId } = admission;

  if (!keyId) {
    return {
      ok: false,
      errorCode: 'ADMISSION_REQUIRED',
      detail: {
        reason: 'key_id_missing',
        source: 'apple',
        proofPlatform: admission.platform,
        proofKind: kind,
      },
    };
  }

  if (kind === 'attestation') {
    // First-time attestation: verify and extract public key
    const result = await verifyAppleAttestation(payload, challenge, keyId);

    if (!result.ok) {
      // The error is a fixed server-side enum, so the per-cause metric stays
      // bounded — one metric per reason, like the Play Integrity counters.
      countAdmissionCondition(`apple_attestation_failed:${result.error}`);
      return {
        ok: false,
        errorCode: 'ADMISSION_REQUIRED',
        detail: {
          reason: ATTESTATION_REFUSAL_REASONS[result.error],
          source: 'apple',
          proofPlatform: admission.platform,
          proofKind: kind,
        },
      };
    }

    // Check whether this keyId already exists — the caller uses this for
    // preflight ownership checks before committing a sign-in code.
    const existingKey = await findAttestedKey(db, keyId, 'ios');

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
  const existingKey = await findAttestedKey(db, keyId, 'ios');

  if (!existingKey) {
    // The device holds a key id this database has never seen — the usual shape
    // of an attestation that never reached the server. Name the recovery so the
    // client can drop that id and attest a new key once. No other refusal gets
    // this hint, and the assertion itself was never verified, so nothing here
    // is weakened by telling the client to re-attest.
    countAdmissionCondition('apple_assertion_unknown_key');
    return {
      ok: false,
      errorCode: 'ADMISSION_REQUIRED',
      recovery: 'IOS_ASSERTION_UNKNOWN_KEY',
      detail: {
        reason: 'assertion_key_unknown',
        source: 'apple',
        proofPlatform: admission.platform,
        proofKind: kind,
      },
    };
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
    return {
      ok: false,
      errorCode: 'ADMISSION_REQUIRED',
      detail: {
        reason: 'assertion_invalid',
        source: 'apple',
        proofPlatform: admission.platform,
        proofKind: kind,
      },
    };
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
    return {
      ok: false,
      errorCode: 'ADMISSION_REQUIRED',
      detail: {
        reason: 'assertion_stale_or_replayed',
        source: 'apple',
        proofPlatform: admission.platform,
        proofKind: kind,
      },
    };
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

/**
 * Fixed reasons for each Play Integrity verdict error. Same contract as the
 * attestation table: a new verifier error fails type checking here.
 */
const INTEGRITY_REFUSAL_REASONS: Record<PlayIntegrityError, AdmissionRefusalReason> = {
  INVALID_TOKEN: 'integrity_token_invalid',
  NONCE_MISMATCH: 'integrity_nonce_mismatch',
  PACKAGE_MISMATCH: 'integrity_package_mismatch',
  APP_NOT_RECOGNIZED: 'integrity_app_not_recognized',
  CERT_DIGEST_MISMATCH: 'integrity_cert_digest_mismatch',
  DEVICE_NOT_RECOGNIZED: 'integrity_device_not_recognized',
};

async function verifyAndroidAdmission(
  admission: AdmissionPayload
): Promise<VerifyAdmissionOk | AdmissionRefusal> {
  const { kind, challenge, payload } = admission;

  // Android sends Play Integrity tokens with kind 'assertion' per the plan.
  if (kind !== 'assertion') {
    return {
      ok: false,
      errorCode: 'ADMISSION_REQUIRED',
      detail: {
        reason: 'integrity_kind_unsupported',
        source: 'play_integrity',
        proofPlatform: admission.platform,
        proofKind: kind,
      },
    };
  }

  // verifyPlayIntegrity throws on infrastructure faults — caller must
  // catch and surface as 5xx. Every refusal verdict it returns is counted
  // there on its own reason metric, so the admission layer adds no second
  // count: each counted refusal is reported exactly once.
  const result = await verifyPlayIntegrity(payload, challenge);

  if (!result.ok) {
    return {
      ok: false,
      errorCode: 'ADMISSION_REQUIRED',
      detail: {
        reason: INTEGRITY_REFUSAL_REASONS[result.error],
        source: 'play_integrity',
        proofPlatform: admission.platform,
        proofKind: kind,
        android: result.diagnostics,
      },
    };
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
    const inserted = await findAttestedKey(executor, keyId, verification.platform);

    if (!inserted || inserted.kilo_user_id !== userId) {
      // The caller is the single reporting point: the route that catches this
      // error counts the refusal and sends one throttled per-event report
      // through reportAttestedKeyCollision, so reporting here would duplicate it.
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
