/**
 * Security notices: an email and a push to the account owner after a
 * security-relevant change to their account (design section 5.13).
 *
 * A notice never blocks or fails the action it reports. The caller schedules
 * it once the change has committed, on the call that won the action's own
 * single-use guard, and delivery runs after the response. Every failure is
 * caught here and reported to Sentry with the event type as the only tag.
 */
import 'server-only';

import { createHash } from 'node:crypto';
import { captureException } from '@sentry/nextjs';
import { and, eq } from 'drizzle-orm';
import { transactional_email_log } from '@kilocode/db/schema';
import type { AuthProviderId } from '@kilocode/db/schema-types';
import { AUTH_PROVIDER_DISPLAY_NAMES } from '@kilocode/web-shared/lib/auth/constants';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  sendApiKeyResetEmail,
  sendBrowserSessionsRevokedEmail,
  sendDeviceSignInApprovedEmail,
  sendNewSignInEmail,
  sendNewSignInMethodEmail,
  sendPasskeyAddedEmail,
  sendPasskeyRemovedEmail,
  sendSignInMethodRemovedEmail,
  type SendResult,
  type SignInMethodChangeRequestDetails,
} from '@kilocode/web-shared/lib/email';
import { dispatchAccountSecurityPush } from '@kilocode/web-shared/lib/notifications-worker-client';

import { runAfterResponse } from '@/lib/after-response';
import {
  currentSignInMethodChangeRequestDetails,
  signInMethodChangeRequestDetails,
} from '@/lib/auth/sign-in-method-change-request';

/** Where and when the action came from, as the notice reports it. */
export type SecurityNoticeRequest = {
  occurredAt: Date;
  ip: string | null;
  /** An approximate location from the request's geolocation headers. */
  location: string | null;
  /** The browser and operating system from the user agent. */
  device: string | null;
};

export type SecurityNoticeEvent =
  | { type: 'passkey_added'; passkeyId: string; passkeyName: string | null }
  | { type: 'passkey_removed'; passkeyId: string; passkeyName: string | null }
  | {
      type: 'sign_in_method_linked';
      provider: AuthProviderId;
      providerAccountId: string;
      linkedIdentity: { email: string; displayName?: string | null };
      /** When the link row was written; a later re-link after an unlink is a new event. */
      linkedAt: Date;
    }
  | { type: 'sign_in_method_unlinked'; provider: AuthProviderId }
  | {
      type: 'device_sign_in_approved';
      deviceAuthRequestId: string;
      /** The requesting client, from its stored request, never from the approving browser. */
      clientLabel: string | null;
      requestIp: string | null;
    }
  | { type: 'api_key_reset' }
  | { type: 'browser_sessions_revoked' }
  | {
      type: 'new_sign_in';
      /** The sign-in provider id; an id this build does not name renders generically. */
      method: string;
      deviceKeyHash: string;
      networkKeyHash: string;
    };

type SecurityNoticeType = SecurityNoticeEvent['type'];

/** The one `transactional_email_log` type every notice claims its key under. */
const SECURITY_NOTICE_EMAIL_TYPE = 'security_notice';

/** Repeats of a reset or a sign-out inside this window are one notice. */
const REVOCATION_BUCKET_MS = 10 * 60 * 1000;

/** An unlink is guarded by its single-use code; the bucket only absorbs a replayed schedule. */
const UNLINK_BUCKET_MS = 60 * 1000;

/** The longest device or location label the push carries; the dispatch schema enforces it. */
const PUSH_LABEL_MAX_LENGTH = 120;

export function securityNoticeRequestFromHeaders(
  headersList: Headers,
  occurredAt: Date = new Date()
): SecurityNoticeRequest {
  const details = signInMethodChangeRequestDetails(headersList, occurredAt);
  return {
    occurredAt: details.changedAt,
    ip: details.ip,
    location: details.location,
    device: details.device,
  };
}

/**
 * The current request's details. Outside a request scope there are no
 * headers, so the details hold only the time.
 */
export async function currentSecurityNoticeRequest(): Promise<SecurityNoticeRequest> {
  const details = await currentSignInMethodChangeRequestDetails();
  return {
    occurredAt: details.changedAt,
    ip: details.ip,
    location: details.location,
    device: details.device,
  };
}

/**
 * The event's identity: two schedules of one event share it, two events never
 * do. The parts are hashed so that no account, provider, or device identifier
 * reaches the outbox row or the push channel's logs.
 */
function securityNoticeIdempotencyKey(
  userId: string,
  event: SecurityNoticeEvent,
  request: SecurityNoticeRequest
): string {
  const parts = ((): string[] => {
    switch (event.type) {
      case 'passkey_added':
      case 'passkey_removed':
        return [event.passkeyId];
      case 'sign_in_method_linked':
        return [event.provider, event.providerAccountId, event.linkedAt.toISOString()];
      case 'sign_in_method_unlinked':
        return [
          event.provider,
          String(Math.floor(request.occurredAt.getTime() / UNLINK_BUCKET_MS)),
        ];
      case 'device_sign_in_approved':
        return [event.deviceAuthRequestId];
      case 'api_key_reset':
      case 'browser_sessions_revoked':
        return [String(Math.floor(request.occurredAt.getTime() / REVOCATION_BUCKET_MS))];
      case 'new_sign_in':
        return [event.deviceKeyHash, event.networkKeyHash];
    }
  })();
  const digest = createHash('sha256')
    .update([userId, ...parts].join('\n'))
    .digest('hex');
  return `${event.type}:${digest}`;
}

/**
 * The display-name record is total over `AuthProviderId`, so its own keys are
 * exactly the provider ids this build names.
 */
function isNamedAuthProvider(method: string): method is AuthProviderId {
  return Object.hasOwn(AUTH_PROVIDER_DISPLAY_NAMES, method);
}

function sendSecurityNoticeEmail(
  email: string,
  event: SecurityNoticeEvent,
  request: SecurityNoticeRequest
): Promise<SendResult> {
  const details: SignInMethodChangeRequestDetails = {
    changedAt: request.occurredAt,
    ip: request.ip,
    location: request.location,
    device: request.device,
  };
  switch (event.type) {
    case 'passkey_added':
      return sendPasskeyAddedEmail(email, event.passkeyName, details);
    case 'passkey_removed':
      return sendPasskeyRemovedEmail(email, event.passkeyName, details);
    case 'sign_in_method_linked':
      return sendNewSignInMethodEmail(
        email,
        AUTH_PROVIDER_DISPLAY_NAMES[event.provider],
        event.linkedIdentity,
        details
      );
    case 'sign_in_method_unlinked':
      return sendSignInMethodRemovedEmail(
        email,
        AUTH_PROVIDER_DISPLAY_NAMES[event.provider],
        details
      );
    case 'device_sign_in_approved':
      return sendDeviceSignInApprovedEmail(
        email,
        { clientLabel: event.clientLabel, requestIp: event.requestIp },
        details
      );
    case 'api_key_reset':
      return sendApiKeyResetEmail(email, details);
    case 'browser_sessions_revoked':
      return sendBrowserSessionsRevokedEmail(email, details);
    case 'new_sign_in':
      return sendNewSignInEmail(
        email,
        isNamedAuthProvider(event.method) ? AUTH_PROVIDER_DISPLAY_NAMES[event.method] : null,
        details
      );
  }
}

function pushLabel(value: string | null): string | null {
  const label = value?.trim().slice(0, PUSH_LABEL_MAX_LENGTH).trim();
  return label ? label : null;
}

function reportNoticeFailure(type: SecurityNoticeType, error: unknown): void {
  captureException(error, { tags: { security_notice: type } });
}

type NoticeClaim = 'claimed' | 'duplicate' | 'unrecorded';

/**
 * Claims the notice's key in the email outbox. The unique
 * `(email_type, idempotency_key)` index makes the insert the atomic claim, so
 * a second schedule of the same event finds it taken and sends nothing. A
 * claim that cannot be written is reported and the notice still goes out: the
 * action's own single-use guard already makes a repeat unlikely, and a lost
 * security notice is worse than a duplicate one.
 */
async function claimNotice(
  userId: string,
  type: SecurityNoticeType,
  idempotencyKey: string
): Promise<NoticeClaim> {
  try {
    const claim = await db
      .insert(transactional_email_log)
      .values({
        user_id: userId,
        email_type: SECURITY_NOTICE_EMAIL_TYPE,
        idempotency_key: idempotencyKey,
      })
      .onConflictDoNothing();
    return (claim.rowCount ?? 0) === 0 ? 'duplicate' : 'claimed';
  } catch (error) {
    reportNoticeFailure(type, error);
    return 'unrecorded';
  }
}

/** Frees a claim whose email failed in transit, so a later schedule of the event can send it. */
async function releaseNoticeClaim(type: SecurityNoticeType, idempotencyKey: string): Promise<void> {
  try {
    await db
      .delete(transactional_email_log)
      .where(
        and(
          eq(transactional_email_log.email_type, SECURITY_NOTICE_EMAIL_TYPE),
          eq(transactional_email_log.idempotency_key, idempotencyKey)
        )
      );
  } catch (error) {
    reportNoticeFailure(type, error);
  }
}

async function deliverSecurityNotice(
  user: { id: string; google_user_email: string },
  event: SecurityNoticeEvent,
  request: SecurityNoticeRequest
): Promise<void> {
  try {
    const idempotencyKey = securityNoticeIdempotencyKey(user.id, event, request);
    const claim = await claimNotice(user.id, event.type, idempotencyKey);
    if (claim === 'duplicate') {
      return;
    }

    // The push dispatcher never rejects and reports its own refusals; its key
    // is the same event identity, so the channel collapses a repeat too.
    const [, email] = await Promise.allSettled([
      dispatchAccountSecurityPush({
        recipientUserId: user.id,
        event: event.type,
        idempotencyKey,
        device: pushLabel(request.device),
        location: pushLabel(request.location),
      }),
      sendSecurityNoticeEmail(user.google_user_email, event, request),
    ]);

    if (email.status === 'rejected') {
      // A transport failure may succeed later, so the claim is freed for it.
      reportNoticeFailure(event.type, email.reason);
      if (claim === 'claimed') {
        await releaseNoticeClaim(event.type, idempotencyKey);
      }
      return;
    }
    if (!email.value.sent) {
      // A rejected address or a missing provider will not change on a retry.
      captureException(new Error('Security notice email was not sent'), {
        tags: { security_notice: event.type },
        extra: { reason: email.value.reason },
      });
    }
  } catch (error) {
    reportNoticeFailure(event.type, error);
  }
}

/**
 * Schedules the email and the push for one event after the response. Resolves
 * once scheduled and never rejects, so the caller's action cannot fail
 * because of a notice; it reads no request headers, so it is safe to call
 * from work that already runs after a response.
 */
export async function scheduleSecurityNotice(
  user: { id: string; google_user_email: string },
  event: SecurityNoticeEvent,
  request: SecurityNoticeRequest
): Promise<void> {
  try {
    await runAfterResponse(() => deliverSecurityNotice(user, event, request));
  } catch (error) {
    reportNoticeFailure(event.type, error);
  }
}
