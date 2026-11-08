import { randomUUID } from 'crypto';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import {
  device_auth_requests,
  device_refresh_tokens,
  device_sessions,
  kilocode_users,
  native_attested_keys,
  user_auth_provider,
} from '@kilocode/db/schema';
import type { AuthProviderId } from '@kilocode/db/schema-types';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { revokeStepUpProofs } from '@kilocode/web-shared/lib/admin/step-up-store';
import { invalidateDeviceSession } from '@kilocode/web-shared/lib/auth/device-session-cache';

export type MagicLinkRecoveryResult = {
  removedProviders: AuthProviderId[];
  revokedDeviceSessionCount: number;
};

/**
 * Resets an account to magic-link sign-in and evicts whoever held it.
 *
 * Removing the provider rows alone restores the owner's access but leaves a
 * prior holder signed in, so the same transaction rotates the browser-session
 * and API-token peppers, revokes step-up proofs, denies open device
 * authorization requests, revokes every device session with its unconsumed
 * refresh tokens, and deletes native attested keys. A failure in any step
 * rolls back the provider deletion with it.
 *
 * Passkeys are kept: they are sign-in credentials, not sessions.
 *
 * Returns null when the user does not exist.
 */
export async function resetAccountToMagicLink(
  kiloUserId: string
): Promise<MagicLinkRecoveryResult | null> {
  const outcome = await db.transaction(async tx => {
    const [user] = await tx
      .update(kilocode_users)
      .set({ web_session_pepper: randomUUID(), api_token_pepper: randomUUID() })
      .where(eq(kilocode_users.id, kiloUserId))
      .returning({ id: kilocode_users.id });
    if (!user) return null;

    const removed = await tx
      .delete(user_auth_provider)
      .where(eq(user_auth_provider.kilo_user_id, kiloUserId))
      .returning({ provider: user_auth_provider.provider });

    await revokeStepUpProofs(kiloUserId, 'account_recovery', tx);

    await tx
      .update(device_auth_requests)
      .set({ status: 'denied' })
      .where(
        and(
          eq(device_auth_requests.kilo_user_id, kiloUserId),
          or(
            eq(device_auth_requests.status, 'pending'),
            eq(device_auth_requests.status, 'approved')
          )
        )
      );

    const revokedSessions = await tx
      .update(device_sessions)
      .set({ revoked_at: new Date().toISOString(), revoked_reason: 'account_recovery' })
      .where(and(eq(device_sessions.kilo_user_id, kiloUserId), isNull(device_sessions.revoked_at)))
      .returning({ id: device_sessions.id });

    await tx
      .delete(device_refresh_tokens)
      .where(
        and(
          inArray(
            device_refresh_tokens.device_session_id,
            tx
              .select({ id: device_sessions.id })
              .from(device_sessions)
              .where(eq(device_sessions.kilo_user_id, kiloUserId))
          ),
          isNull(device_refresh_tokens.consumed_at)
        )
      );

    await tx.delete(native_attested_keys).where(eq(native_attested_keys.kilo_user_id, kiloUserId));

    return {
      removedProviders: removed.map(row => row.provider),
      revokedSessionIds: revokedSessions.map(row => row.id),
    };
  });

  if (!outcome) return null;

  for (const sessionId of outcome.revokedSessionIds) {
    invalidateDeviceSession(sessionId);
  }

  return {
    removedProviders: outcome.removedProviders,
    revokedDeviceSessionCount: outcome.revokedSessionIds.length,
  };
}

const RETRYABLE_POSTGRES_CODES: Record<string, true> = {
  '40001': true,
  '40P01': true,
  '55P03': true,
  '57014': true,
  '08000': true,
  '08003': true,
  '08006': true,
};

/** Whether a failed reset hit a transient database condition that a retry can clear. */
export function isRetryableRecoveryError(error: unknown): boolean {
  const errorCode = (value: unknown): unknown =>
    value && typeof value === 'object' && 'code' in value ? value.code : undefined;
  const cause = error && typeof error === 'object' && 'cause' in error ? error.cause : undefined;
  const code = errorCode(cause) ?? errorCode(error);
  return typeof code === 'string' && RETRYABLE_POSTGRES_CODES[code] === true;
}
