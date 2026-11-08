import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import {
  device_auth_requests,
  device_refresh_tokens,
  device_sessions,
  native_attested_keys,
  passkey_challenges,
  passkey_credentials,
  passkey_sign_in_tickets,
} from '@kilocode/db/schema';
import type { db, DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import { revokeStepUpProofs } from '@kilocode/web-shared/lib/admin/step-up-store';

/**
 * Revokes a user's live sessions other than the pepper-bound browser and API
 * credentials: step-up proofs, pending or approved device authorization
 * requests, device sessions with their unconsumed refresh tokens, and native
 * attested keys. Run it inside the caller's transaction.
 *
 * Returns the ids of the device sessions it revoked, so the caller can drop
 * them from this instance's device-session cache after commit.
 */
export async function revokeUserSessions(
  tx: typeof db | DrizzleTransaction,
  kiloUserId: string,
  reasons: { stepUp: string; deviceSession: string }
): Promise<string[]> {
  await revokeStepUpProofs(kiloUserId, reasons.stepUp, tx);

  await tx
    .update(device_auth_requests)
    .set({ status: 'denied' })
    .where(
      and(
        eq(device_auth_requests.kilo_user_id, kiloUserId),
        or(eq(device_auth_requests.status, 'pending'), eq(device_auth_requests.status, 'approved'))
      )
    );

  const revokedSessions = await tx
    .update(device_sessions)
    .set({ revoked_at: new Date().toISOString(), revoked_reason: reasons.deviceSession })
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

  return revokedSessions.map(row => row.id);
}

/**
 * Deletes a user's passkeys and every passkey ceremony still bound to them.
 *
 * Open challenges are dropped so a pending registration or authentication
 * cannot complete. Usernameless challenges (`kilo_user_id IS NULL`) are not
 * attributable to the user; the device-auth cleanup cron removes them once
 * they expire. A sign-in ticket is a live proof that a passkey assertion
 * verified, so every ticket naming the user is deleted with the credentials.
 */
export async function deleteUserPasskeys(
  tx: typeof db | DrizzleTransaction,
  kiloUserId: string
): Promise<number> {
  const removed = await tx
    .delete(passkey_credentials)
    .where(eq(passkey_credentials.kilo_user_id, kiloUserId))
    .returning({ id: passkey_credentials.id });
  await tx
    .delete(passkey_challenges)
    .where(
      and(eq(passkey_challenges.kilo_user_id, kiloUserId), isNull(passkey_challenges.consumed_at))
    );
  await tx
    .delete(passkey_sign_in_tickets)
    .where(eq(passkey_sign_in_tickets.kilo_user_id, kiloUserId));
  return removed.length;
}
