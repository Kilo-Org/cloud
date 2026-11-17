import { and, count, inArray, isNotNull, isNull, not, sql } from 'drizzle-orm';
import { kilocode_users } from '@kilocode/db';
import { goneOrDeletingBlockedReasonSql } from '@kilocode/db/user-soft-delete';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  BACKFILL_BATCH_SIZE,
  BACKFILL_BATCHES_PER_REQUEST,
  type BackfillBatchResult,
} from '@/lib/backfills/batch';

export const blockedAtBackfillCandidates = and(
  isNotNull(kilocode_users.blocked_reason),
  isNull(kilocode_users.blocked_at),
  not(goneOrDeletingBlockedReasonSql(kilocode_users.blocked_reason))
);

export async function countMissingBlockedAt(): Promise<number> {
  const [result] = await db
    .select({ count: count() })
    .from(kilocode_users)
    .where(blockedAtBackfillCandidates);
  return result?.count ?? 0;
}

export async function backfillBlockedAtBatch(): Promise<BackfillBatchResult> {
  let totalProcessed = 0;
  let reachedEnd = false;

  for (let i = 0; i < BACKFILL_BATCHES_PER_REQUEST; i++) {
    const rows = await db
      .select({ id: kilocode_users.id })
      .from(kilocode_users)
      .where(blockedAtBackfillCandidates)
      .limit(BACKFILL_BATCH_SIZE);

    if (rows.length === 0) {
      reachedEnd = true;
      break;
    }

    const updated = await db
      .update(kilocode_users)
      .set({
        blocked_at: sql`${kilocode_users.updated_at}`,
        updated_at: sql`${kilocode_users.updated_at}`,
      })
      .where(
        and(
          inArray(
            kilocode_users.id,
            rows.map(r => r.id)
          ),
          blockedAtBackfillCandidates
        )
      )
      .returning({ id: kilocode_users.id });

    totalProcessed += updated.length;

    if (rows.length < BACKFILL_BATCH_SIZE) {
      reachedEnd = true;
      break;
    }
  }

  return { processed: totalProcessed, remaining: !reachedEnd };
}
