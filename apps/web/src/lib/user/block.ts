import { randomUUID } from 'crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { kilocode_users } from '@kilocode/db/schema';
import { db, type DrizzleTransaction } from '@/lib/drizzle';

export type BlockUserParams = {
  kiloUserId: string;
  reason: string;
  blockedByKiloUserId?: string | null;
  /** Run inside an existing transaction; defaults to the shared `db`. */
  dbOrTx?: typeof db | DrizzleTransaction;
};

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
 * @returns `true` if this call transitioned the user from unblocked to blocked,
 * `false` if the user was already blocked (or does not exist).
 */
export async function blockUser(params: BlockUserParams): Promise<boolean> {
  const executor = params.dbOrTx ?? db;
  const rows = await executor
    .update(kilocode_users)
    .set({
      blocked_reason: params.reason,
      blocked_at: new Date().toISOString(),
      blocked_by_kilo_user_id: params.blockedByKiloUserId ?? null,
      api_token_pepper: randomUUID(),
    })
    .where(and(eq(kilocode_users.id, params.kiloUserId), isNull(kilocode_users.blocked_reason)))
    .returning({ id: kilocode_users.id });
  return rows.length > 0;
}
