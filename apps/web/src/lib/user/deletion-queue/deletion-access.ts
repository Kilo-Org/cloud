import { randomUUID } from 'crypto';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import {
  device_auth_requests,
  device_refresh_tokens,
  device_sessions,
  kilocode_users,
  native_attested_keys,
} from '@kilocode/db/schema';
import { createDeletionInProgressBlockedReason } from '@kilocode/db/user-soft-delete';
import type { DrizzleTransaction } from '@/lib/drizzle';

export async function disableUserAccessForDeletion(
  tx: DrizzleTransaction,
  params: {
    userId: string;
    requestedByKiloUserId: string | null;
    nowIso: string;
  }
): Promise<void> {
  await tx
    .update(kilocode_users)
    .set({
      blocked_reason: createDeletionInProgressBlockedReason(new Date(params.nowIso)),
      blocked_at: params.nowIso,
      blocked_by_kilo_user_id: params.requestedByKiloUserId,
      api_token_pepper: randomUUID(),
      web_session_pepper: randomUUID(),
    })
    .where(eq(kilocode_users.id, params.userId));

  await tx
    .update(device_auth_requests)
    .set({ status: 'denied' })
    .where(
      and(
        eq(device_auth_requests.kilo_user_id, params.userId),
        or(eq(device_auth_requests.status, 'pending'), eq(device_auth_requests.status, 'approved'))
      )
    );

  await tx
    .update(device_sessions)
    .set({ revoked_at: params.nowIso, revoked_reason: 'user_deletion' })
    .where(
      and(eq(device_sessions.kilo_user_id, params.userId), isNull(device_sessions.revoked_at))
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
            .where(eq(device_sessions.kilo_user_id, params.userId))
        ),
        isNull(device_refresh_tokens.consumed_at)
      )
    );

  await tx.delete(native_attested_keys).where(eq(native_attested_keys.kilo_user_id, params.userId));
}
