import { and, count, isNull, not, or, sql } from 'drizzle-orm';
import { kilocode_users } from '@kilocode/db';
import { goneOrDeletingBlockedReasonSql } from '@kilocode/db/user-soft-delete';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { extractEmailDomain } from '@/lib/email-domain';
import {
  BACKFILL_BATCH_SIZE,
  BACKFILL_BATCHES_PER_REQUEST,
  type BackfillBatchResult,
} from '@/lib/backfills/batch';

// Skip soft-deleted and deletion-in-progress users. Soft-deleted emails are
// already anonymized; in-progress emails are still real, but backfill must not
// race with deletion.
export const emailDomainBackfillCandidates = and(
  isNull(kilocode_users.email_domain),
  or(
    isNull(kilocode_users.blocked_reason),
    not(goneOrDeletingBlockedReasonSql(kilocode_users.blocked_reason))
  )
);

export async function countMissingEmailDomains(): Promise<number> {
  const [result] = await db
    .select({ count: count() })
    .from(kilocode_users)
    .where(emailDomainBackfillCandidates);
  return result?.count ?? 0;
}

export async function backfillEmailDomainBatch(): Promise<BackfillBatchResult> {
  let totalProcessed = 0;

  for (let i = 0; i < BACKFILL_BATCHES_PER_REQUEST; i++) {
    const rows = await db
      .select({ id: kilocode_users.id, google_user_email: kilocode_users.google_user_email })
      .from(kilocode_users)
      .where(emailDomainBackfillCandidates)
      .limit(BACKFILL_BATCH_SIZE);

    if (rows.length === 0) break;

    const updates = rows
      .map(row => ({
        id: row.id,
        email_domain: extractEmailDomain(row.google_user_email),
      }))
      .filter((u): u is { id: string; email_domain: string } => u.email_domain !== null);

    if (updates.length === 0) break;

    await db.execute(sql`
      UPDATE ${kilocode_users}
      SET email_domain = domain_updates.email_domain
      FROM (VALUES ${sql.join(
        updates.map(u => sql`(${u.id}, ${u.email_domain})`),
        sql`, `
      )}) AS domain_updates(id, email_domain)
      WHERE ${kilocode_users.id} = domain_updates.id
    `);

    totalProcessed += updates.length;

    if (rows.length < BACKFILL_BATCH_SIZE) break;
  }

  return {
    processed: totalProcessed,
    remaining: totalProcessed === BACKFILL_BATCH_SIZE * BACKFILL_BATCHES_PER_REQUEST,
  };
}
