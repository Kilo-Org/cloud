/**
 * Security notices: an email and a push to the account owner after a
 * security-relevant change to their account (design section 5.13).
 *
 * A notice never blocks or fails the action it reports. The caller schedules
 * it once the change has committed, on the call that won the action's own
 * single-use guard, and delivery runs after the response. Every failure is
 * caught here and reported to Sentry as a fixed, content-free error with the
 * event type as the only tag.
 */
import 'server-only';

import { createHash } from 'node:crypto';
import { headers } from 'next/headers';
import { captureException } from '@sentry/nextjs';
import { and, eq } from 'drizzle-orm';
import { transactional_email_log } from '@kilocode/db/schema';
import type { AuthProviderId } from '@kilocode/db/schema-types';
import type { AccountSecurityOrigin } from '@kilocode/notifications/schemas';
import { clientIpFromHeaders } from '@kilocode/web-shared/lib/admin/admin-access-log';
import { AUTH_PROVIDER_DISPLAY_NAMES } from '@kilocode/web-shared/lib/auth/constants';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  selfNamedClientName,
  sendApiKeyResetEmail,
  sendBrowserSessionsRevokedEmail,
  sendDeviceSessionRevokedEmail,
  sendDeviceSignInApprovedEmail,
  sendNewSignInEmail,
  sendNewSignInMethodEmail,
  sendPasskeyAddedEmail,
  sendPasskeyRemovedEmail,
  sendSignInMethodRemovedEmail,
  sendSignInResetBySupportEmail,
  type DeviceSignInRequester,
  type SecurityNoticeRequest,
  type SendResult,
} from '@kilocode/web-shared/lib/email';
import { dispatchAccountSecurityPush } from '@kilocode/web-shared/lib/notifications-worker-client';

import { runAfterResponse } from '@/lib/after-response';
import { classifyDeviceSessionClient } from '@/lib/auth/device-session-client';
import { approximateLocation, describeUserAgent } from '@/lib/auth/sign-in-method-change-request';

export type SecurityNoticeEvent =
  | { type: 'passkey_added'; passkeyId: string; passkeyName: string | null }
  | { type: 'passkey_removed'; passkeyId: string; passkeyName: string | null }
  | {
      type: 'sign_in_method_linked';
      provider: AuthProviderId;
      linkedIdentity: { email: string; displayName?: string | null };
      /** When the link row was written; a later re-link after an unlink is a new event. */
      linkedAt: Date;
      /**
       * `added`: the owner linked a method they can remove themselves.
       * `sso_settled`: an enterprise SSO sign-in settled onto the account. It
       * replaced the account's other sign-in methods (none or more), signed
       * out every browser, and only Kilo support can remove it.
       */
      change:
        | { kind: 'added' }
        | { kind: 'sso_settled'; replacedProviders: readonly AuthProviderId[] };
    }
  | {
      type: 'sign_in_method_unlinked';
      provider: AuthProviderId;
      /** When each removed link row was written: the identity of what this unlink removed. */
      removedLinkCreatedAt: readonly [string, ...string[]];
    }
  | {
      type: 'device_sign_in_approved';
      deviceAuthRequestId: string;
      /** The requesting client, from its stored request, never from the approving browser. */
      requester: DeviceSignInRequester;
      requestIp: string | null;
    }
  /**
   * `rotationId` identifies the committed change by the pepper it installed
   * (`newPepperRotation`), so two changes are two notices and a repeated
   * schedule of one is one.
   */
  | { type: 'api_key_reset'; rotationId: string }
  | { type: 'browser_sessions_revoked'; rotationId: string }
  | {
      type: 'device_session_revoked';
      deviceSessionId: string;
      /** Kilo's description of the signed-out device, or null when it has none. */
      revokedDevice: string | null;
    }
  | { type: 'sign_in_reset_by_support'; rotationId: string }
  | {
      type: 'new_sign_in';
      /** The sign-in provider id; an id this build does not name renders generically. */
      method: string;
    };

type SecurityNoticeType = SecurityNoticeEvent['type'];

/** The one `transactional_email_log` type every notice claims its key under. */
const SECURITY_NOTICE_EMAIL_TYPE = 'security_notice';

/**
 * At most one new-sign-in notice per user per hour: the sign-in check's own
 * cap claims at most one per rolling hour from the same `occurredAt`, so two
 * notices it allows are always at least an hour apart and fall in different
 * fixed hour buckets.
 */
const NEW_SIGN_IN_BUCKET_MS = 60 * 60 * 1000;

/** The longest device or location label the push carries; the dispatch schema enforces it. */
const PUSH_LABEL_MAX_LENGTH = 120;

/** The owner's own request, read from its headers. */
export function securityNoticeRequestFromHeaders(
  headersList: Headers,
  occurredAt: Date = new Date()
): SecurityNoticeRequest {
  return {
    actor: 'owner',
    occurredAt,
    ip: clientIpFromHeaders(headersList),
    location: approximateLocation(headersList),
    device: describeUserAgent(headersList.get('user-agent')),
  };
}

/**
 * The owner's current request. Outside a request scope there are no headers,
 * so the request holds only the time.
 */
export async function currentSecurityNoticeRequest(): Promise<SecurityNoticeRequest> {
  try {
    return securityNoticeRequestFromHeaders(new Headers(await headers()));
  } catch {
    return { actor: 'owner', occurredAt: new Date(), ip: null, location: null, device: null };
  }
}

/** An action Kilo support took: the notice names support and the time, never the staff member's request. */
export function supportSecurityNoticeRequest(occurredAt: Date = new Date()): SecurityNoticeRequest {
  return { actor: 'support', occurredAt };
}

/**
 * Kilo's own description of a client from its recorded user agent: a
 * recognised client kind or a parsed browser label, never the raw header.
 */
export function recognisedClientLabel(userAgent: string | null): string | null {
  const client = classifyDeviceSessionClient(userAgent);
  switch (client.kind) {
    case 'cli':
      return 'Kilo CLI';
    case 'app':
      return client.platform === 'ios' ? 'Kilo app on iOS' : 'Kilo app on Android';
    case 'browser':
      return describeUserAgent(userAgent);
    case 'other':
      return null;
  }
}

function timeBucket(occurredAt: Date, bucketMs: number): string {
  return String(Math.floor(occurredAt.getTime() / bucketMs));
}

/**
 * The event's identity: two schedules of one event share it, two events never
 * do. Every part is a server-issued random id, a digest of a fresh random
 * pepper, a provider id from a fixed list, or a time; no email address, IP
 * address, network or provider account id goes in, because a plain SHA-256 of
 * a guessable value can be reversed by anyone who can read the outbox row.
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
        return [event.provider, event.linkedAt.toISOString()];
      case 'sign_in_method_unlinked':
        return [event.provider, ...[...event.removedLinkCreatedAt].sort()];
      case 'device_sign_in_approved':
        return [event.deviceAuthRequestId];
      case 'device_session_revoked':
        return [event.deviceSessionId];
      case 'api_key_reset':
      case 'browser_sessions_revoked':
      case 'sign_in_reset_by_support':
        return [event.rotationId];
      case 'new_sign_in':
        return [timeBucket(request.occurredAt, NEW_SIGN_IN_BUCKET_MS)];
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
  switch (event.type) {
    case 'passkey_added':
      return sendPasskeyAddedEmail(email, event.passkeyName, request);
    case 'passkey_removed':
      return sendPasskeyRemovedEmail(email, event.passkeyName, request);
    case 'sign_in_method_linked':
      return sendNewSignInMethodEmail(
        email,
        AUTH_PROVIDER_DISPLAY_NAMES[event.provider],
        event.linkedIdentity,
        event.change.kind === 'added'
          ? { kind: 'added' }
          : {
              kind: 'sso_settled',
              replacedMethodNames: event.change.replacedProviders.map(
                provider => AUTH_PROVIDER_DISPLAY_NAMES[provider]
              ),
            },
        request
      );
    case 'sign_in_method_unlinked':
      return sendSignInMethodRemovedEmail(
        email,
        AUTH_PROVIDER_DISPLAY_NAMES[event.provider],
        request
      );
    case 'device_sign_in_approved':
      return sendDeviceSignInApprovedEmail(
        email,
        { client: event.requester, ip: event.requestIp },
        request
      );
    case 'api_key_reset':
      return sendApiKeyResetEmail(email, request);
    case 'browser_sessions_revoked':
      return sendBrowserSessionsRevokedEmail(email, request);
    case 'device_session_revoked':
      return sendDeviceSessionRevokedEmail(email, event.revokedDevice, request);
    case 'sign_in_reset_by_support':
      return sendSignInResetBySupportEmail(email, request);
    case 'new_sign_in':
      return sendNewSignInEmail(
        email,
        isNamedAuthProvider(event.method) ? AUTH_PROVIDER_DISPLAY_NAMES[event.method] : null,
        request
      );
  }
}

function pushLabel(value: string | null): string | null {
  const label = value?.trim().slice(0, PUSH_LABEL_MAX_LENGTH).trim();
  return label ? label : null;
}

/**
 * Who the push says acted. A device sign-in approval describes the device
 * that was signed in, never the approving browser: in a device-code phishing
 * attack the owner approves from their own browser, and naming it would
 * reassure them instead of warning them.
 */
function pushOrigin(
  event: SecurityNoticeEvent,
  request: SecurityNoticeRequest
): AccountSecurityOrigin {
  if (request.actor === 'support') return { actor: 'support' };
  if (event.type !== 'device_sign_in_approved') {
    return {
      actor: 'owner',
      device: pushLabel(request.device),
      location: pushLabel(request.location),
    };
  }
  const { requester } = event;
  switch (requester.kind) {
    case 'self_named': {
      // The push quotes the name and attributes it to the device, as the
      // email does; the name holds no quote mark that could close the quote.
      const name = selfNamedClientName(requester.name);
      return name
        ? { actor: 'self_named_device', name }
        : { actor: 'owner', device: null, location: null };
    }
    case 'recognised':
      return { actor: 'owner', device: pushLabel(requester.label), location: null };
    case 'unidentified':
      return { actor: 'owner', device: null, location: null };
  }
}

/**
 * Reports a failure with the event type as the only tag. The error itself is
 * never passed on: a database error's message carries the query parameters,
 * which hold the user id and the notice key.
 */
function reportNoticeFailure(type: SecurityNoticeType): void {
  captureException(new Error('security_notice_failed'), { tags: { security_notice: type } });
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
  } catch {
    reportNoticeFailure(type);
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
  } catch {
    reportNoticeFailure(type);
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
        origin: pushOrigin(event, request),
      }),
      sendSecurityNoticeEmail(user.google_user_email, event, request),
    ]);

    if (email.status === 'rejected') {
      // A transport failure may succeed later, so the claim is freed for it.
      reportNoticeFailure(event.type);
      if (claim === 'claimed') {
        await releaseNoticeClaim(event.type, idempotencyKey);
      }
      return;
    }
    if (!email.value.sent) {
      // A rejected address or a missing provider will not change on a retry.
      captureException(new Error('security_notice_email_not_sent'), {
        tags: { security_notice: event.type },
        extra: { reason: email.value.reason },
      });
    }
  } catch {
    reportNoticeFailure(event.type);
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
  } catch {
    reportNoticeFailure(event.type);
  }
}
