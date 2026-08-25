import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { db } from '@/lib/drizzle';
import { device_refresh_tokens, device_sessions, user_auth_provider } from '@kilocode/db/schema';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { captureException } from '@sentry/nextjs';
import { logExceptInTest } from '@/lib/utils.server';
import { APPLE_CLIENT_ID } from '@/lib/config.server';
import { AppleJwtClientError, verifyAppleJwtWithJwks } from '@/lib/auth/apple-jwks';
import { revokeWebSessions } from '@/lib/web-session-revocation';

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

async function handleAppleEvent(event: AppleEvent): Promise<void> {
  const { type, sub } = event;

  logExceptInTest(`Apple auth event: ${type} for sub=${sub}`);

  if (type === 'consent-revoked' || type === 'account-delete') {
    // Compatibility: the old handler deleted the provider row only. Keep the
    // extra web/device revocation until Apple stops sending these events.
    await db.transaction(async tx => {
      const deletedProviders = await tx
        .delete(user_auth_provider)
        .where(
          and(
            eq(user_auth_provider.provider, 'apple'),
            eq(user_auth_provider.provider_account_id, sub)
          )
        )
        .returning({ kilo_user_id: user_auth_provider.kilo_user_id });
      if (deletedProviders.length === 0) return;

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
    });
    logExceptInTest(`Removed apple auth provider for sub=${sub} (${type})`);
  }
  // email-disabled and email-enabled are informational — no action needed
}

/**
 * Apple Sign in with Apple server-to-server notification endpoint.
 * Apple sends a POST with a signed JWT when users change their
 * account or email forwarding preferences.
 *
 * See: https://developer.apple.com/documentation/sign_in_with_apple/processing_changes_for_sign_in_with_apple_accounts
 */
export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const payload = formData.get('payload');

    if (typeof payload !== 'string') {
      return NextResponse.json({ error: 'Missing payload' }, { status: 400 });
    }

    const jwtPayload = await verifyAppleJwtWithJwks(payload, APPLE_CLIENT_ID);
    const event = extractAppleEvent(jwtPayload);
    await handleAppleEvent(event);

    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof AppleJwtClientError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    captureException(error);
    logExceptInTest(`Apple notification error: ${error}`);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
