import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  device_refresh_tokens,
  device_sessions,
  kilocode_users,
  user_auth_provider,
} from '@kilocode/db/schema';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { captureException } from '@sentry/nextjs';
import { logExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import { APPLE_CLIENT_ID } from '@kilocode/web-shared/lib/config.server';
import { AppleJwtClientError, verifyAppleJwtWithJwks } from '@/lib/auth/apple-jwks';
import { revokeWebSessions } from '@kilocode/web-shared/lib/web-session-revocation';
import {
  auditAuthRoute,
  authAuditRequestFromHeaders,
  recordAuthEvent,
  type AuthAuditAttempt,
} from '@/lib/auth/auth-audit';

type AppleEvent = {
  type: 'consent-revoked' | 'account-delete' | 'email-disabled' | 'email-enabled';
  sub: string;
  email?: string;
  is_private_email?: string;
  event_time: number;
};

function extractAppleEvent(payload: Record<string, unknown>): AppleEvent {
  const events = payload.events;
  if (typeof events === 'string') {
    return JSON.parse(events) as AppleEvent;
  }

  return events as AppleEvent;
}

/** An account whose Apple sign-in a notification removed, with its email for the audit row. */
type UnlinkedAccount = { userId: string; email: string | null };

/**
 * The email of each unlinked account, for its audit row only. The unlink has
 * committed, so a failed read is reported and the rows go without the hash.
 */
async function unlinkedAccountsWithEmail(userIds: string[]): Promise<UnlinkedAccount[]> {
  if (userIds.length === 0) return [];
  try {
    const rows = await db
      .select({ userId: kilocode_users.id, email: kilocode_users.google_user_email })
      .from(kilocode_users)
      .where(inArray(kilocode_users.id, userIds));
    const emails = new Map(rows.map(row => [row.userId, row.email]));
    return userIds.map(userId => ({ userId, email: emails.get(userId) ?? null }));
  } catch (error) {
    captureException(error, { tags: { operation: 'apple_unlink_audit_email' } });
    return userIds.map(userId => ({ userId, email: null }));
  }
}

/** Applies one Apple event and returns the accounts whose Apple sign-in it removed. */
async function handleAppleEvent(event: AppleEvent): Promise<UnlinkedAccount[]> {
  const { type, sub } = event;

  logExceptInTest(`Apple auth event: ${type} for sub=${sub}`);

  if (type === 'consent-revoked' || type === 'account-delete') {
    // Compatibility: the old handler deleted the provider row only. Keep the
    // extra web/device revocation until Apple stops sending these events.
    const unlinkedUserIds = await db.transaction(async tx => {
      const deletedProviders = await tx
        .delete(user_auth_provider)
        .where(
          and(
            eq(user_auth_provider.provider, 'apple'),
            eq(user_auth_provider.provider_account_id, sub)
          )
        )
        .returning({ kilo_user_id: user_auth_provider.kilo_user_id });
      if (deletedProviders.length === 0) return [];

      const now = new Date().toISOString();
      for (const { kilo_user_id } of deletedProviders) {
        await revokeWebSessions(kilo_user_id, tx);

        await tx
          .update(device_sessions)
          .set({ revoked_at: now, revoked_reason: 'apple_provider_revoked' })
          .where(
            and(eq(device_sessions.kilo_user_id, kilo_user_id), isNull(device_sessions.revoked_at))
          );

        await tx
          .delete(device_refresh_tokens)
          .where(
            and(
              inArray(
                device_refresh_tokens.device_session_id,
                tx
                  .select({ id: device_sessions.id })
                  .from(device_sessions)
                  .where(eq(device_sessions.kilo_user_id, kilo_user_id))
              ),
              isNull(device_refresh_tokens.consumed_at)
            )
          );
      }
      return [...new Set(deletedProviders.map(provider => provider.kilo_user_id))];
    });
    logExceptInTest(`Removed apple auth provider for sub=${sub} (${type})`);
    return unlinkedAccountsWithEmail(unlinkedUserIds);
  }
  // email-disabled and email-enabled are informational — no action needed
  return [];
}

const MAX_NOTIFICATION_BODY_BYTES = 64 * 1024;

const FORM_CONTENT_TYPES: Record<string, true> = {
  'application/x-www-form-urlencoded': true,
  'multipart/form-data': true,
};

/** True when the media type of `contentType` is a form encoding, ignoring parameters. */
function isFormContentType(contentType: string): boolean {
  const [mediaType] = contentType.split(';', 1);
  return FORM_CONTENT_TYPES[mediaType.trim().toLowerCase()] === true;
}

class NotificationBodyTooLargeError extends Error {}

async function readBoundedBody(request: NextRequest): Promise<ArrayBuffer> {
  const contentLength = request.headers.get('content-length');
  if (
    contentLength !== null &&
    (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_NOTIFICATION_BODY_BYTES)
  ) {
    throw new NotificationBodyTooLargeError();
  }
  if (!request.body) return new ArrayBuffer(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > MAX_NOTIFICATION_BODY_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The request remains rejected when stream cancellation fails.
        }
        throw new NotificationBodyTooLargeError();
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new ArrayBuffer(totalBytes);
  const view = new Uint8Array(body);
  let offset = 0;
  for (const chunk of chunks) {
    view.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/**
 * Apple Sign in with Apple server-to-server notification endpoint.
 * Apple sends a POST with a signed JWT when users change their
 * account or email forwarding preferences.
 *
 * See: https://developer.apple.com/documentation/sign_in_with_apple/processing_changes_for_sign_in_with_apple_accounts
 */
export async function POST(request: NextRequest) {
  // An unlink writes one success row per account it removed Apple from; a
  // refused or failed notification writes one failure row.
  const auditRequest = authAuditRequestFromHeaders(
    request.headers,
    '/api/auth/apple-notifications'
  );
  const attempt: AuthAuditAttempt = {
    action: 'auth.sign_in_method.unlink',
    method: 'apple',
    skipSuccessRow: true,
  };
  return auditAuthRoute(auditRequest, attempt, async () => {
    const contentType = request.headers.get('content-type');
    if (!contentType || !isFormContentType(contentType)) {
      attempt.failureReason = 'unsupported_content_type';
      return NextResponse.json({ error: 'Unsupported content type' }, { status: 400 });
    }

    // Form parsing answers a client error on its own, without reaching the
    // server-fault path below.
    let formData: FormData;
    try {
      const body = await readBoundedBody(request);
      formData = await new Response(body, { headers: { 'content-type': contentType } }).formData();
    } catch (error) {
      if (error instanceof NotificationBodyTooLargeError) {
        attempt.failureReason = 'payload_too_large';
        return NextResponse.json({ error: 'Payload too large' }, { status: 400 });
      }
      attempt.failureReason = 'invalid_form_data';
      return NextResponse.json({ error: 'Invalid form data' }, { status: 400 });
    }

    const payload = formData.get('payload');
    if (typeof payload !== 'string') {
      attempt.failureReason = 'missing_payload';
      return NextResponse.json({ error: 'Missing payload' }, { status: 400 });
    }

    try {
      const jwtPayload = await verifyAppleJwtWithJwks(payload, APPLE_CLIENT_ID);
      const event = extractAppleEvent(jwtPayload);
      const unlinkedAccounts = await handleAppleEvent(event);
      for (const { userId, email } of unlinkedAccounts) {
        await recordAuthEvent(auditRequest, {
          action: 'auth.sign_in_method.unlink',
          outcome: 'success',
          userId,
          email,
          method: 'apple',
          metadata: {
            reason: event.type === 'consent-revoked' ? 'consent_revoked' : 'account_delete',
          },
        });
      }

      return NextResponse.json({ ok: true });
    } catch (error) {
      if (error instanceof AppleJwtClientError) {
        attempt.failureReason = 'invalid_notification';
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
      captureException(error);
      logExceptInTest(`Apple notification error: ${error}`);
      attempt.failureReason = 'internal_error';
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
  });
}
