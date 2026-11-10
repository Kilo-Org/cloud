import { count, isNull, sql } from 'drizzle-orm';
import { kilocode_users } from '@kilocode/db';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { normalizeEmail } from '@kilocode/web-shared/lib/email-address';
import {
  BACKFILL_BATCH_SIZE,
  BACKFILL_BATCHES_PER_REQUEST,
  type BackfillBatchResult,
} from '@/lib/backfills/batch';

export async function countMissingNormalizedEmails(): Promise<number> {
  const [result] = await db
    .select({ count: count() })
    .from(kilocode_users)
    .where(isNull(kilocode_users.normalized_email));
  return result?.count ?? 0;
}

export async function backfillNormalizedEmailBatch(): Promise<BackfillBatchResult> {
  let totalProcessed = 0;

  for (let i = 0; i < BACKFILL_BATCHES_PER_REQUEST; i++) {
    const rows = await db
      .select({ id: kilocode_users.id, google_user_email: kilocode_users.google_user_email })
      .from(kilocode_users)
      .where(isNull(kilocode_users.normalized_email))
      .limit(BACKFILL_BATCH_SIZE);

    if (rows.length === 0) break;

    const updates = rows.map(row => ({
      id: row.id,
      normalized_email: normalizeEmail(row.google_user_email),
    }));

    await db.execute(sql`
      UPDATE ${kilocode_users}
      SET normalized_email = email_updates.normalized_email
      FROM (VALUES ${sql.join(
        updates.map(u => sql`(${u.id}, ${u.normalized_email})`),
        sql`, `
      )}) AS email_updates(id, normalized_email)
      WHERE ${kilocode_users.id} = email_updates.id
    `);

    totalProcessed += rows.length;

    if (rows.length < BACKFILL_BATCH_SIZE) break;
  }

  return {
    processed: totalProcessed,
    remaining: totalProcessed === BACKFILL_BATCH_SIZE * BACKFILL_BATCHES_PER_REQUEST,
  };
}
