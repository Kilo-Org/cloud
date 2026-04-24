import { db } from '@/lib/drizzle';
import { kilocode_users } from '@kilocode/db/schema';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { successResult, type CustomResult } from '@/lib/maybe-result';

export type BulkBlockResponse = CustomResult<
  { updatedCount: number },
  { error: string; foundIds: string[] }
>;

export async function bulkBlockUsers(
  kilo_user_emails_or_ids: string[],
  block_reason: string,
  blockedByKiloUserId: string
): Promise<BulkBlockResponse> {
  const reason = block_reason.trim();
  const idsOrEmails = [...new Set(kilo_user_emails_or_ids.map(id => id.trim()).filter(Boolean))];

  const existing = await db
    .select({
      id: kilocode_users.id,
      blocked_reason: kilocode_users.blocked_reason,
      google_user_email: kilocode_users.google_user_email,
    })
    .from(kilocode_users)
    .where(
      or(
        inArray(kilocode_users.id, idsOrEmails),
        inArray(kilocode_users.google_user_email, idsOrEmails)
      )
    );

  const existingSet = new Set(existing.flatMap(r => [r.id, r.google_user_email]));
  const missing = idsOrEmails.filter(id => !existingSet.has(id));
  const blocked = existing.filter(r => r.blocked_reason?.toString().trim()).map(r => r.id);
  const validButUncounted = existing.map(r => r.id).filter(id => !blocked.includes(id));
  const valid = validButUncounted.slice(0, 10_000);

  if (missing.length || blocked.length) {
    const error = [
      missing.length &&
        `${missing.length} users not found: ${missing.slice(0, 50).join(' ')}${missing.length > 50 ? ` …(+${missing.length - 50} more)` : ''}`,
      blocked.length &&
        `${blocked.length} users already blocked: ${blocked.slice(0, 50).join(' ')}${blocked.length > 50 ? ` …(+${blocked.length - 50} more)` : ''}`,
    ]
      .filter(Boolean)
      .join('; ');
    return { success: false, error, foundIds: valid };
  }

  const blockedAt = new Date().toISOString();
  const updated = await db
    .update(kilocode_users)
    .set({
      blocked_reason: reason,
      blocked_at: blockedAt,
      blocked_by_kilo_user_id: blockedByKiloUserId,
    })
    .where(inArray(kilocode_users.id, valid))
    .returning({ id: kilocode_users.id });

  return successResult({ updatedCount: updated.length });
}

export async function unblockBulkBlockedUsers(
  blocked_reason: string,
  date: string,
  blockedByKiloUserId: string | null
) {
  const blockedByCondition = blockedByKiloUserId
    ? eq(kilocode_users.blocked_by_kilo_user_id, blockedByKiloUserId)
    : isNull(kilocode_users.blocked_by_kilo_user_id);

  const rows = await db
    .update(kilocode_users)
    .set({
      blocked_reason: null,
      blocked_at: null,
      blocked_by_kilo_user_id: null,
    })
    .where(
      and(
        eq(kilocode_users.blocked_reason, blocked_reason.trim()),
        sql<boolean>`DATE(COALESCE(${kilocode_users.blocked_at}, ${kilocode_users.updated_at})) = ${date}`,
        blockedByCondition
      )
    )
    .returning({ id: kilocode_users.id });

  return { updatedCount: rows.length };
}
