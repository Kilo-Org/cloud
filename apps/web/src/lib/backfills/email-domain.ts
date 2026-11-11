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

    const updates = rows.flatMap(row => {
      const email_domain = extractEmailDomain(row.google_user_email);
      return email_domain === null
        ? []
        : [{ id: row.id, google_user_email: row.google_user_email, email_domain }];
    });

    if (updates.length === 0) break;

    // Matching the email that was read skips rows a soft delete anonymized after the select.
    await db.execute(sql`
      UPDATE ${kilocode_users}
      SET email_domain = domain_updates.email_domain
      FROM (VALUES ${sql.join(
        updates.map(u => sql`(${u.id}, ${u.google_user_email}, ${u.email_domain})`),
        sql`, `
      )}) AS domain_updates(id, google_user_email, email_domain)
      WHERE ${kilocode_users.id} = domain_updates.id
        AND ${kilocode_users.google_user_email} = domain_updates.google_user_email
        AND ${emailDomainBackfillCandidates}
    `);

    totalProcessed += updates.length;

    if (rows.length < BACKFILL_BATCH_SIZE) break;
  }

  return {
    processed: totalProcessed,
    remaining: totalProcessed === BACKFILL_BATCH_SIZE * BACKFILL_BATCHES_PER_REQUEST,
  };
}
