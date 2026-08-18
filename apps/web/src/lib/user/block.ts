import { randomUUID } from 'crypto';
import { after } from 'next/server';
import { and, eq, isNull, or, inArray } from 'drizzle-orm';
import {
  kilocode_users,
  device_auth_requests,
  device_sessions,
  device_refresh_tokens,
  native_attested_keys,
} from '@kilocode/db/schema';
import { db, type DrizzleTransaction } from '@/lib/drizzle';
import { invalidateUserAuthCache } from '@/lib/session-ingest-client';
import { errorExceptInTest } from '@/lib/utils.server';

export type BlockUserParams = {
  kiloUserId: string;
  reason: string;
  blockedByKiloUserId?: string | null;
  /** Run inside an existing transaction; defaults to the shared `db`. */
  dbOrTx?: typeof db | DrizzleTransaction;
};

async function invalidateUserAuthCacheBestEffort(kiloUserId: string): Promise<void> {
  try {
    await invalidateUserAuthCache(kiloUserId);
  } catch (error) {
    errorExceptInTest('Failed to invalidate cached user auth after block', {
      kiloUserId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function scheduleUserAuthCacheInvalidation(kiloUserId: string): void {
  try {
    after(() => invalidateUserAuthCacheBestEffort(kiloUserId));
  } catch (error) {
    errorExceptInTest('Failed to schedule cached user auth invalidation after block', {
      kiloUserId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Block a single user.
 *
 * Sets `blocked_reason`/`blocked_at`/`blocked_by_kilo_user_id` and rotates
 * `api_token_pepper` so every previously-issued API token is invalidated on
 * every service that validates the pepper against the database. The update is
 * guarded by `isNull(blocked_reason)` so an existing block is never
 * overwritten — the original block reason is preserved and callers can rely on
 * the return value to detect the unblocked->blocked transition.
 *
 * Also in the same transaction:
 * - Denies every pending or approved device auth request for this user.
 * - Revokes every non-revoked device session for this user.
 * - Deletes every unconsumed device refresh token owned by those sessions.
 *
 * @returns `true` if this call transitioned the user from unblocked to blocked,
 * `false` if the user was already blocked (or does not exist).
 */
export async function blockUser(params: BlockUserParams): Promise<boolean> {
  const executor = params.dbOrTx;

  async function run(tx: typeof db | DrizzleTransaction): Promise<boolean> {
    const rows = await tx
      .update(kilocode_users)
      .set({
        blocked_reason: params.reason,
        blocked_at: new Date().toISOString(),
        blocked_by_kilo_user_id: params.blockedByKiloUserId ?? null,
        api_token_pepper: randomUUID(),
      })
      .where(and(eq(kilocode_users.id, params.kiloUserId), isNull(kilocode_users.blocked_reason)))
      .returning({ id: kilocode_users.id });

    if (rows.length === 0) return false;

    const now = new Date().toISOString();

    // Deny every pending or approved device auth request for this user.
    await tx
      .update(device_auth_requests)
      .set({ status: 'denied' })
      .where(
        and(
          eq(device_auth_requests.kilo_user_id, params.kiloUserId),
          or(
            eq(device_auth_requests.status, 'pending'),
            eq(device_auth_requests.status, 'approved')
          )
        )
      );

    // Revoke every non-revoked device session for this user.
    await tx
      .update(device_sessions)
      .set({ revoked_at: now, revoked_reason: 'user_blocked' })
      .where(
        and(eq(device_sessions.kilo_user_id, params.kiloUserId), isNull(device_sessions.revoked_at))
      );

    // Delete every unconsumed device refresh token owned by those sessions.
    await tx
      .delete(device_refresh_tokens)
      .where(
        and(
          inArray(
            device_refresh_tokens.device_session_id,
            tx
              .select({ id: device_sessions.id })
              .from(device_sessions)
              .where(eq(device_sessions.kilo_user_id, params.kiloUserId))
          ),
          isNull(device_refresh_tokens.consumed_at)
        )
      );

    // Delete every native attested key for this user.
    await tx
      .delete(native_attested_keys)
      .where(eq(native_attested_keys.kilo_user_id, params.kiloUserId));

    return true;
  }

  const didBlock = executor ? await run(executor) : await db.transaction(tx => run(tx));

  if (didBlock) {
    if (executor) {
      scheduleUserAuthCacheInvalidation(params.kiloUserId);
    } else {
      await invalidateUserAuthCacheBestEffort(params.kiloUserId);
    }
  }

  return didBlock;
}
