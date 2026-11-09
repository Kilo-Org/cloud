import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { kilocode_users, user_auth_provider } from '@kilocode/db/schema';
import type { AuthProviderId } from '@kilocode/db/schema-types';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { invalidateDeviceSession } from '@kilocode/web-shared/lib/auth/device-session-cache';
import { getPostgresErrorCode } from '@/lib/db-errors';
import { deleteUserPasskeys, revokeUserSessions } from '@/lib/user/session-revocation';

export type MagicLinkRecoveryResult = {
  removedProviders: AuthProviderId[];
  removedPasskeyCount: number;
  revokedDeviceSessionCount: number;
};

/**
 * Resets an account to magic-link sign-in and evicts whoever held it.
 *
 * Removing the provider rows alone restores the owner's access but leaves a
 * prior holder signed in, so the same transaction rotates the browser-session
 * and API-token peppers, revokes the remaining sessions through
 * `revokeUserSessions`, and deletes the account's passkeys, which sign in by
 * credential id alone. A failure in any step rolls back the provider deletion
 * with it.
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

    const revokedSessionIds = await revokeUserSessions(tx, kiloUserId, {
      stepUp: 'account_recovery',
      deviceSession: 'account_recovery',
    });
    const removedPasskeyCount = await deleteUserPasskeys(tx, kiloUserId);

    return {
      removedProviders: removed.map(row => row.provider),
      removedPasskeyCount,
      revokedSessionIds,
    };
  });

  if (!outcome) return null;

  for (const sessionId of outcome.revokedSessionIds) {
    invalidateDeviceSession(sessionId);
  }

  return {
    removedProviders: outcome.removedProviders,
    removedPasskeyCount: outcome.removedPasskeyCount,
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
  const code = getPostgresErrorCode(error);
  return code !== null && RETRYABLE_POSTGRES_CODES[code] === true;
}
