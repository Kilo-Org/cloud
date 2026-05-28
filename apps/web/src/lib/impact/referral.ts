import 'server-only';

import { createHash } from 'crypto';
import { db, type DrizzleTransaction } from '@/lib/drizzle';
import {
  buildImpactAdvocateRegisterParticipantPayload,
  extractAdvocateReferralCodeFromUpsertResponse,
  getImpactAdvocateProgramId,
  isImpactAdvocateConfigured,
  sendImpactAdvocateRegisterParticipantPayload,
  type ImpactAdvocateRegisterParticipantPayload,
} from '@/lib/impact/advocate';
import { logImpactReferralDebug } from '@/lib/impact/debug';
import {
  redactLandingPathForLogs,
  type ParsedImpactAffiliateTouch,
  type ParsedImpactReferralTouch,
} from '@/lib/impact/referral-utils';
import {
  deleted_user_email_tombstones,
  impact_advocate_participants,
  impact_advocate_registration_attempts,
  impact_attribution_touches,
  type User,
} from '@kilocode/db/schema';
import {
  ImpactAdvocateAttemptDeliveryState,
  ImpactAdvocateProgramKey,
  ImpactAdvocateRegistrationState,
  ImpactAttributionTouchProvider,
  ImpactAttributionTouchType,
} from '@kilocode/db/schema-types';
import { and, asc, eq, lte, ne, or, sql } from 'drizzle-orm';

type DatabaseClient = typeof db | DrizzleTransaction;

type AttributionActor = {
  userId?: string | null;
  anonymousId?: string | null;
};

export type ImpactAdvocateRegistrationDispatchSummary = {
  claimed: number;
  delivered: number;
  retried: number;
  failed: number;
};

const IMPACT_ADVOCATE_REGISTRATION_CLAIM_STALE_MS = 15 * 60 * 1000;

function getDatabaseClient(database?: DatabaseClient): DatabaseClient {
  return database ?? db;
}

function buildHashedDedupeKey(parts: Array<string | null | undefined>): string {
  const normalized = parts.map(part => part?.trim() ?? '').join('|');
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

function touchMinuteBucket(touchedAt: Date): string {
  return touchedAt.toISOString().slice(0, 16);
}

function touchIdentity(actor: AttributionActor): string {
  if (actor.userId) return `user:${actor.userId}`;
  if (actor.anonymousId) return `anon:${actor.anonymousId}`;
  return 'anonymous:missing';
}

function isImpactAdvocateRegisterParticipantPayload(
  value: Record<string, unknown> | null
): value is ImpactAdvocateRegisterParticipantPayload {
  if (!value) {
    return false;
  }

  // Only assert the SaaSquatch-required fields. Extra keys (e.g. legacy
  // `programId` rows persisted before the endpoint fix) are tolerated here
  // and stripped at send time by sanitizeRegisterParticipantPayloadForWire.
  return (
    typeof value.id === 'string' &&
    typeof value.accountId === 'string' &&
    typeof value.email === 'string' &&
    typeof value.cookies === 'string' &&
    (value.locale === undefined || typeof value.locale === 'string') &&
    (value.countryCode === undefined || typeof value.countryCode === 'string')
  );
}

export function hashNormalizedEmailForDeletionTombstone(normalizedEmail: string): string {
  return createHash('sha256').update(normalizedEmail.trim().toLowerCase(), 'utf8').digest('hex');
}

export async function recordImpactAffiliateTouch(params: {
  database?: DatabaseClient;
  userId?: string | null;
  anonymousId?: string | null;
  touch: ParsedImpactAffiliateTouch;
}): Promise<void> {
  const database = getDatabaseClient(params.database);
  const dedupeKey = buildHashedDedupeKey([
    touchIdentity(params),
    ImpactAttributionTouchType.Affiliate,
    ImpactAttributionTouchProvider.ImpactPerformance,
    params.touch.trackingId,
    params.touch.landingPath,
    touchMinuteBucket(params.touch.touchedAt),
  ]);

  const [insertedTouch] = await database
    .insert(impact_attribution_touches)
    .values({
      dedupe_key: dedupeKey,
      anonymous_id: params.anonymousId ?? null,
      user_id: params.userId ?? null,
      touch_type: ImpactAttributionTouchType.Affiliate,
      provider: ImpactAttributionTouchProvider.ImpactPerformance,
      opaque_tracking_value: params.touch.trackingId,
      tracking_value_length: params.touch.trackingValueLength,
      is_tracking_value_accepted: params.touch.isTrackingValueAccepted,
      im_ref: params.touch.trackingId,
      landing_path: params.touch.landingPath,
      utm_source: params.touch.utmSource,
      utm_medium: params.touch.utmMedium,
      utm_campaign: params.touch.utmCampaign,
      utm_term: params.touch.utmTerm,
      utm_content: params.touch.utmContent,
      touched_at: params.touch.touchedAt.toISOString(),
      expires_at: params.touch.expiresAt.toISOString(),
    })
    .onConflictDoNothing({ target: [impact_attribution_touches.dedupe_key] })
    .returning({ id: impact_attribution_touches.id });

  logImpactReferralDebug(
    insertedTouch
      ? 'Recorded Impact affiliate attribution touch'
      : 'Impact affiliate touch already existed',
    {
      userId: params.userId ?? null,
      anonymousIdPresent: Boolean(params.anonymousId?.trim()),
      touchId: insertedTouch?.id ?? null,
      landingPath: redactLandingPathForLogs(params.touch.landingPath),
      trackingValueLength: params.touch.trackingValueLength,
      isTrackingValueAccepted: params.touch.isTrackingValueAccepted,
    }
  );
}

export async function recordImpactReferralTouch(params: {
  database?: DatabaseClient;
  userId?: string | null;
  anonymousId?: string | null;
  touch: ParsedImpactReferralTouch;
}): Promise<void> {
  const database = getDatabaseClient(params.database);
  const dedupeKey = buildHashedDedupeKey([
    touchIdentity(params),
    ImpactAttributionTouchType.Referral,
    ImpactAttributionTouchProvider.ImpactAdvocate,
    params.touch.opaqueTrackingValue,
    params.touch.rsCode,
    params.touch.landingPath,
    touchMinuteBucket(params.touch.touchedAt),
  ]);

  const [insertedTouch] = await database
    .insert(impact_attribution_touches)
    .values({
      dedupe_key: dedupeKey,
      anonymous_id: params.anonymousId ?? null,
      user_id: params.userId ?? null,
      touch_type: ImpactAttributionTouchType.Referral,
      provider: ImpactAttributionTouchProvider.ImpactAdvocate,
      opaque_tracking_value: params.touch.opaqueTrackingValue,
      tracking_value_length: params.touch.trackingValueLength,
      is_tracking_value_accepted: params.touch.isTrackingValueAccepted,
      rs_code: params.touch.rsCode,
      rs_share_medium: params.touch.rsShareMedium,
      rs_engagement_medium: params.touch.rsEngagementMedium,
      landing_path: params.touch.landingPath,
      utm_source: params.touch.utmSource,
      utm_medium: params.touch.utmMedium,
      utm_campaign: params.touch.utmCampaign,
      utm_term: params.touch.utmTerm,
      utm_content: params.touch.utmContent,
      touched_at: params.touch.touchedAt.toISOString(),
      expires_at: params.touch.expiresAt.toISOString(),
    })
    .onConflictDoNothing({ target: [impact_attribution_touches.dedupe_key] })
    .returning({ id: impact_attribution_touches.id });

  logImpactReferralDebug(
    insertedTouch
      ? 'Recorded Impact Advocate referral touch'
      : 'Impact Advocate referral touch already existed',
    {
      userId: params.userId ?? null,
      anonymousIdPresent: Boolean(params.anonymousId?.trim()),
      touchId: insertedTouch?.id ?? null,
      landingPath: redactLandingPathForLogs(params.touch.landingPath),
      rsCodePresent: Boolean(params.touch.rsCode?.trim()),
      trackingValueLength: params.touch.trackingValueLength,
      isTrackingValueAccepted: params.touch.isTrackingValueAccepted,
    }
  );
}

export async function ensureImpactAdvocateParticipantProfile(params: {
  database?: DatabaseClient;
  user: Pick<User, 'id' | 'google_user_email'>;
  locale?: string | null;
  countryCode?: string | null;
  opaqueReferralIdentifier?: string | null;
}): Promise<{ id: string }> {
  const database = getDatabaseClient(params.database);

  const isConfigured = isImpactAdvocateConfigured();

  const [insertedParticipant] = await database
    .insert(impact_advocate_participants)
    .values({
      user_id: params.user.id,
      advocate_id: params.user.google_user_email,
      advocate_account_id: params.user.google_user_email,
      opaque_referral_identifier: params.opaqueReferralIdentifier ?? null,
      contact_email: params.user.google_user_email,
      locale: params.locale ?? null,
      country_code: params.countryCode ?? null,
      registration_state: isConfigured
        ? ImpactAdvocateRegistrationState.Pending
        : ImpactAdvocateRegistrationState.Failed,
      last_error_code: isConfigured ? null : 'missing_configuration',
      last_error_message: isConfigured ? null : 'Impact Advocate configuration is incomplete',
    })
    .onConflictDoNothing({
      target: [impact_advocate_participants.program_key, impact_advocate_participants.user_id],
    })
    .returning({ id: impact_advocate_participants.id });

  const participant =
    insertedParticipant ??
    (await database.query.impact_advocate_participants.findFirst({
      where: and(
        eq(impact_advocate_participants.program_key, ImpactAdvocateProgramKey.KiloClaw),
        eq(impact_advocate_participants.user_id, params.user.id)
      ),
      columns: { id: true },
    }));

  if (!participant) {
    throw new Error(`Impact Advocate participant missing for user ${params.user.id}`);
  }

  await database
    .update(impact_advocate_participants)
    .set({
      advocate_id: params.user.google_user_email,
      advocate_account_id: params.user.google_user_email,
      contact_email: params.user.google_user_email,
      locale: params.locale ?? null,
      country_code: params.countryCode ?? null,
      ...(params.opaqueReferralIdentifier
        ? { opaque_referral_identifier: params.opaqueReferralIdentifier }
        : {}),
    })
    .where(eq(impact_advocate_participants.id, participant.id));

  return { id: participant.id };
}

export async function queueImpactAdvocateParticipantRegistration(params: {
  database?: DatabaseClient;
  user: Pick<User, 'id' | 'google_user_email'>;
  referralTouch: ParsedImpactReferralTouch;
  locale?: string | null;
  countryCode?: string | null;
}): Promise<void> {
  if (!params.referralTouch.opaqueTrackingValue) {
    logImpactReferralDebug(
      'Skipped Impact Advocate participant registration queue; missing referral cookie value',
      {
        userId: params.user.id,
        landingPath: redactLandingPathForLogs(params.referralTouch.landingPath),
      }
    );
    return;
  }

  const database = getDatabaseClient(params.database);
  const payload = buildImpactAdvocateRegisterParticipantPayload({
    user: params.user,
    referralCookieValue: params.referralTouch.opaqueTrackingValue,
    locale: params.locale,
    countryCode: params.countryCode,
  });
  const nowIso = new Date().toISOString();
  const isConfigured = isImpactAdvocateConfigured();
  const participant = await ensureImpactAdvocateParticipantProfile({
    database,
    user: params.user,
    locale: params.locale,
    countryCode: params.countryCode,
  });

  const attemptDedupeKey = buildHashedDedupeKey([
    'impact-advocate-registration',
    params.user.id,
    params.referralTouch.opaqueTrackingValue,
  ]);

  const [insertedAttempt] = await database
    .insert(impact_advocate_registration_attempts)
    .values({
      participant_id: participant.id,
      dedupe_key: attemptDedupeKey,
      opaque_cookie_value: params.referralTouch.opaqueTrackingValue,
      cookie_value_length: params.referralTouch.trackingValueLength,
      delivery_state: isConfigured
        ? ImpactAdvocateAttemptDeliveryState.Queued
        : ImpactAdvocateAttemptDeliveryState.Failed,
      request_payload: payload satisfies Record<string, unknown>,
      response_payload: isConfigured
        ? null
        : ({ error: 'missing_configuration' } satisfies Record<string, unknown>),
      response_status_code: isConfigured ? null : 503,
    })
    .onConflictDoNothing({ target: [impact_advocate_registration_attempts.dedupe_key] })
    .returning({ id: impact_advocate_registration_attempts.id });

  logImpactReferralDebug(
    insertedAttempt
      ? 'Queued Impact Advocate participant registration attempt'
      : 'Impact Advocate participant registration attempt already existed',
    {
      userId: params.user.id,
      participantId: participant.id,
      attemptId: insertedAttempt?.id ?? null,
      impactAdvocateConfigured: isConfigured,
      trackingValueLength: params.referralTouch.trackingValueLength,
      localePresent: Boolean(params.locale?.trim()),
      countryCode: params.countryCode ?? null,
    }
  );

  if (!insertedAttempt) {
    return;
  }

  await database
    .update(impact_advocate_participants)
    .set({
      registration_state: isConfigured
        ? ImpactAdvocateRegistrationState.Pending
        : ImpactAdvocateRegistrationState.Failed,
      last_error_code: isConfigured ? null : 'missing_configuration',
      last_error_message: isConfigured ? null : 'Impact Advocate configuration is incomplete',
      last_registration_attempt_at: nowIso,
    })
    .where(eq(impact_advocate_participants.id, participant.id));
}

/**
 * Queue an Upsert User attempt for an advocate-only Kilo user — someone who
 * has not arrived through a referral cookie themselves but is now actively
 * trying to share a referral link (e.g. the user has loaded /claw/refer).
 *
 * Without this, the only Kilo users with `impact_advocate_participants` rows
 * are referees; advocate-only users would have either no row or a row whose
 * `opaque_referral_identifier` was a Kilo-side UUID with no relationship to
 * the SaaSquatch-issued referral code. That UUID can never match an inbound
 * referee touch's `rs_code`, so the conversion lifecycle would resolve
 * `referrerUserId = null` and silently undercount attribution on the Kilo
 * side. See spec rules 11 and 51.
 *
 * Idempotent: deduped by user id, so repeated `/claw/refer` visits don't
 * stack attempts. The dispatcher (dispatchImpactAdvocateRegistrationAttemptById)
 * extracts the SaaSquatch code from the response and writes it to
 * `participants.opaque_referral_identifier` exactly the same way as for
 * referee registrations.
 */
export async function queueImpactAdvocateSelfRegistration(params: {
  database?: DatabaseClient;
  user: Pick<User, 'id' | 'google_user_email'>;
  locale?: string | null;
  countryCode?: string | null;
}): Promise<void> {
  const database = getDatabaseClient(params.database);
  const isConfigured = isImpactAdvocateConfigured();
  const nowIso = new Date().toISOString();

  // Empty cookie envelope — advocate-only users have no inbound attribution.
  // SaaSquatch's Verified Access widget creates such users on the fly when
  // the JWT identifies them; this server-side mirror produces the same
  // outcome and lets us read the referralCodes back from the response.
  const payload = buildImpactAdvocateRegisterParticipantPayload({
    user: params.user,
    referralCookieValue: '',
    locale: params.locale,
    countryCode: params.countryCode,
  });

  const participant = await ensureImpactAdvocateParticipantProfile({
    database,
    user: params.user,
    locale: params.locale,
    countryCode: params.countryCode,
  });

  const existing = await database.query.impact_advocate_participants.findFirst({
    where: eq(impact_advocate_participants.id, participant.id),
    columns: { registration_state: true, opaque_referral_identifier: true },
  });
  if (
    existing?.registration_state === ImpactAdvocateRegistrationState.Registered &&
    existing.opaque_referral_identifier?.trim()
  ) {
    logImpactReferralDebug(
      'Skipped Impact Advocate self-registration; participant already registered with code',
      {
        userId: params.user.id,
        participantId: participant.id,
      }
    );
    return;
  }

  const attemptDedupeKey = buildHashedDedupeKey([
    'impact-advocate-self-registration',
    params.user.id,
  ]);

  const [insertedAttempt] = await database
    .insert(impact_advocate_registration_attempts)
    .values({
      participant_id: participant.id,
      dedupe_key: attemptDedupeKey,
      opaque_cookie_value: null,
      cookie_value_length: 0,
      delivery_state: isConfigured
        ? ImpactAdvocateAttemptDeliveryState.Queued
        : ImpactAdvocateAttemptDeliveryState.Failed,
      request_payload: payload satisfies Record<string, unknown>,
      response_payload: isConfigured
        ? null
        : ({ error: 'missing_configuration' } satisfies Record<string, unknown>),
      response_status_code: isConfigured ? null : 503,
    })
    .onConflictDoNothing({ target: [impact_advocate_registration_attempts.dedupe_key] })
    .returning({ id: impact_advocate_registration_attempts.id });

  logImpactReferralDebug(
    insertedAttempt
      ? 'Queued Impact Advocate self-registration attempt'
      : 'Impact Advocate self-registration attempt already existed',
    {
      userId: params.user.id,
      participantId: participant.id,
      attemptId: insertedAttempt?.id ?? null,
      impactAdvocateConfigured: isConfigured,
      localePresent: Boolean(params.locale?.trim()),
      countryCode: params.countryCode ?? null,
    }
  );

  if (!insertedAttempt) {
    return;
  }

  await database
    .update(impact_advocate_participants)
    .set({
      registration_state: isConfigured
        ? ImpactAdvocateRegistrationState.Pending
        : ImpactAdvocateRegistrationState.Failed,
      last_error_code: isConfigured ? null : 'missing_configuration',
      last_error_message: isConfigured ? null : 'Impact Advocate configuration is incomplete',
      last_registration_attempt_at: nowIso,
    })
    .where(eq(impact_advocate_participants.id, participant.id));
}

export async function createDeletedUserEmailTombstone(params: {
  database?: DatabaseClient;
  normalizedEmail: string | null;
}): Promise<void> {
  if (!params.normalizedEmail) {
    return;
  }

  const database = getDatabaseClient(params.database);
  await database
    .insert(deleted_user_email_tombstones)
    .values({
      normalized_email_hash: hashNormalizedEmailForDeletionTombstone(params.normalizedEmail),
    })
    .onConflictDoNothing({ target: [deleted_user_email_tombstones.normalized_email_hash] });
}

export function localeFromHeaders(headers?: Headers): string | null {
  const acceptLanguage = headers?.get('accept-language')?.trim();
  if (!acceptLanguage) return null;
  return acceptLanguage.split(',')[0]?.trim() || null;
}

export function countryCodeFromHeaders(headers?: Headers): string | null {
  const countryCode = headers?.get('x-vercel-ip-country')?.trim();
  return countryCode ? countryCode : null;
}

function registrationBackoffDelayMs(attemptCount: number): number {
  const maxDelayMs = 60 * 60 * 1000;
  const initialDelayMs = 60 * 1000;
  return Math.min(initialDelayMs * 2 ** Math.max(attemptCount, 0), maxDelayMs);
}

function nextRegistrationRetryAt(attemptCount: number): string {
  return new Date(Date.now() + registrationBackoffDelayMs(attemptCount)).toISOString();
}

async function dispatchImpactAdvocateRegistrationAttemptById(
  attemptId: string
): Promise<'delivered' | 'retried' | 'failed'> {
  const attempt = await db.query.impact_advocate_registration_attempts.findFirst({
    where: eq(impact_advocate_registration_attempts.id, attemptId),
  });
  if (!attempt) {
    return 'failed';
  }

  const participant = await db.query.impact_advocate_participants.findFirst({
    where: eq(impact_advocate_participants.id, attempt.participant_id),
  });
  if (!participant) {
    return 'failed';
  }

  const payload = attempt.request_payload;
  if (!isImpactAdvocateRegisterParticipantPayload(payload)) {
    const failedAt = new Date().toISOString();
    await db.transaction(async tx => {
      await tx
        .update(impact_advocate_registration_attempts)
        .set({
          delivery_state: ImpactAdvocateAttemptDeliveryState.Failed,
          attempt_count: attempt.attempt_count + 1,
          next_retry_at: null,
          claimed_at: failedAt,
          response_payload: {
            error: 'missing_request_payload',
          } satisfies Record<string, unknown>,
        })
        .where(eq(impact_advocate_registration_attempts.id, attempt.id));

      await tx
        .update(impact_advocate_participants)
        .set({
          registration_state: ImpactAdvocateRegistrationState.Failed,
          last_error_code: 'missing_request_payload',
          last_error_message: 'Impact Advocate registration attempt is missing request_payload',
          last_registration_attempt_at: failedAt,
        })
        .where(eq(impact_advocate_participants.id, participant.id));
    });
    return 'failed';
  }

  const sendingAt = new Date().toISOString();
  await db
    .update(impact_advocate_registration_attempts)
    .set({
      delivery_state: ImpactAdvocateAttemptDeliveryState.Sending,
      claimed_at: sendingAt,
    })
    .where(eq(impact_advocate_registration_attempts.id, attempt.id));

  logImpactReferralDebug('Dispatching Impact Advocate participant registration attempt', {
    attemptId: attempt.id,
    participantId: participant.id,
    userId: participant.user_id,
    attemptCount: attempt.attempt_count,
  });

  const result = await sendImpactAdvocateRegisterParticipantPayload(payload);
  const attemptCount = attempt.attempt_count + 1;
  const completedAt = new Date().toISOString();

  logImpactReferralDebug('Impact Advocate participant registration dispatch result', {
    attemptId: attempt.id,
    participantId: participant.id,
    userId: participant.user_id,
    ok: result.ok,
    failureKind: result.ok ? null : result.failureKind,
    statusCode: result.statusCode ?? null,
  });

  if (result.ok) {
    // Pull the SaaSquatch-generated referral code out of the response so the
    // participant becomes discoverable as an Advocate. Without this, every
    // future referee touch carrying this user's rsCode would resolve
    // referrerUserId=null and the rewards lifecycle would silently undercount
    // attribution on the Kilo side. The unique constraint on
    // opaque_referral_identifier means we have to pre-check for a collision
    // (vanishingly unlikely — SaaSquatch issues unique codes per tenant — but
    // a violation here would otherwise roll back the whole success transaction
    // and put us in a retry loop).
    const programId = getImpactAdvocateProgramId();
    const advocateCode = extractAdvocateReferralCodeFromUpsertResponse(
      result.responseBody,
      programId
    );

    let advocateCodeToPersist: string | null = null;
    if (advocateCode) {
      const conflicting = await db.query.impact_advocate_participants.findFirst({
        where: and(
          eq(impact_advocate_participants.opaque_referral_identifier, advocateCode),
          ne(impact_advocate_participants.id, participant.id)
        ),
        columns: { id: true, user_id: true },
      });
      if (conflicting) {
        logImpactReferralDebug(
          'Skipped persisting Impact Advocate referral code due to existing holder',
          {
            participantId: participant.id,
            conflictingParticipantId: conflicting.id,
            conflictingUserId: conflicting.user_id,
            programId,
          }
        );
      } else {
        advocateCodeToPersist = advocateCode;
      }
    }

    logImpactReferralDebug('Parsed Impact Advocate referral code from upsert response', {
      attemptId: attempt.id,
      participantId: participant.id,
      userId: participant.user_id,
      programId,
      advocateCodePresent: Boolean(advocateCode),
      advocateCodePersisted: Boolean(advocateCodeToPersist),
    });

    await db.transaction(async tx => {
      await tx
        .update(impact_advocate_registration_attempts)
        .set({
          delivery_state: ImpactAdvocateAttemptDeliveryState.Succeeded,
          attempt_count: attemptCount,
          next_retry_at: null,
          claimed_at: completedAt,
          response_status_code: result.statusCode ?? null,
          response_payload: {
            responseBody: result.responseBody ?? null,
          } satisfies Record<string, unknown>,
        })
        .where(eq(impact_advocate_registration_attempts.id, attempt.id));

      await tx
        .update(impact_advocate_participants)
        .set({
          registration_state: ImpactAdvocateRegistrationState.Registered,
          registered_at: completedAt,
          last_registration_attempt_at: completedAt,
          last_error_code: null,
          last_error_message: null,
          ...(advocateCodeToPersist ? { opaque_referral_identifier: advocateCodeToPersist } : {}),
        })
        .where(eq(impact_advocate_participants.id, participant.id));
    });
    return 'delivered';
  }

  const isTerminalFailure = result.failureKind === 'http_4xx';
  if (isTerminalFailure) {
    console.error('[impact-referral] Impact Advocate participant registration failed permanently', {
      attemptId: attempt.id,
      participantId: participant.id,
      userId: participant.user_id,
      statusCode: result.statusCode ?? null,
      failureKind: result.failureKind,
    });
  }

  await db.transaction(async tx => {
    await tx
      .update(impact_advocate_registration_attempts)
      .set({
        delivery_state: ImpactAdvocateAttemptDeliveryState.Failed,
        attempt_count: attemptCount,
        next_retry_at: isTerminalFailure ? null : nextRegistrationRetryAt(attemptCount),
        claimed_at: completedAt,
        response_status_code: result.statusCode ?? null,
        response_payload: {
          failureKind: result.failureKind,
          responseBody: result.responseBody ?? null,
          error: result.error ?? null,
        } satisfies Record<string, unknown>,
      })
      .where(eq(impact_advocate_registration_attempts.id, attempt.id));

    await tx
      .update(impact_advocate_participants)
      .set({
        registration_state: isTerminalFailure
          ? ImpactAdvocateRegistrationState.Failed
          : ImpactAdvocateRegistrationState.Retrying,
        last_registration_attempt_at: completedAt,
        last_error_code: isTerminalFailure ? 'http_4xx' : result.failureKind,
        last_error_message:
          result.error ??
          (result.statusCode
            ? `Impact Advocate registration failed with status ${result.statusCode}`
            : 'Impact Advocate registration failed'),
      })
      .where(eq(impact_advocate_participants.id, participant.id));
  });

  return isTerminalFailure ? 'failed' : 'retried';
}

export async function dispatchQueuedImpactAdvocateRegistrationAttempts(params?: {
  limit?: number;
}): Promise<ImpactAdvocateRegistrationDispatchSummary> {
  const limit = params?.limit ?? 100;
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const staleClaimedAt = new Date(now - IMPACT_ADVOCATE_REGISTRATION_CLAIM_STALE_MS).toISOString();
  const rows = await db
    .select({ id: impact_advocate_registration_attempts.id })
    .from(impact_advocate_registration_attempts)
    .innerJoin(
      impact_advocate_participants,
      eq(impact_advocate_participants.id, impact_advocate_registration_attempts.participant_id)
    )
    .where(
      or(
        eq(
          impact_advocate_registration_attempts.delivery_state,
          ImpactAdvocateAttemptDeliveryState.Queued
        ),
        and(
          eq(
            impact_advocate_participants.registration_state,
            ImpactAdvocateRegistrationState.Retrying
          ),
          eq(
            impact_advocate_registration_attempts.delivery_state,
            ImpactAdvocateAttemptDeliveryState.Failed
          ),
          or(
            sql`${impact_advocate_registration_attempts.next_retry_at} IS NULL`,
            lte(impact_advocate_registration_attempts.next_retry_at, nowIso)
          )
        ),
        and(
          eq(
            impact_advocate_registration_attempts.delivery_state,
            ImpactAdvocateAttemptDeliveryState.Sending
          ),
          lte(impact_advocate_registration_attempts.claimed_at, staleClaimedAt)
        )
      )
    )
    .orderBy(
      asc(impact_advocate_registration_attempts.created_at),
      asc(impact_advocate_registration_attempts.id)
    )
    .limit(limit);

  const summary: ImpactAdvocateRegistrationDispatchSummary = {
    claimed: rows.length,
    delivered: 0,
    retried: 0,
    failed: 0,
  };

  logImpactReferralDebug('Claimed queued Impact Advocate participant registration attempts', {
    claimed: summary.claimed,
    limit,
  });

  for (const row of rows) {
    const outcome = await dispatchImpactAdvocateRegistrationAttemptById(row.id);
    if (outcome === 'delivered') {
      summary.delivered++;
    } else if (outcome === 'retried') {
      summary.retried++;
    } else {
      summary.failed++;
    }
  }

  return summary;
}
