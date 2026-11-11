import { and, count, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { kilocode_users } from '@kilocode/db';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  BACKFILL_BATCH_SIZE,
  BACKFILL_BATCHES_PER_REQUEST,
  type BackfillBatchResult,
} from '@/lib/backfills/batch';

/**
 * Users who are blocked but have never had an `api_token_pepper` set. Their
 * existing API/device tokens carry a null pepper, which the pepper check
 * treats as "no revocation" — so those tokens stay valid even though the user
 * is blocked. Assigning a pepper invalidates them.
 *
 * Users with a non-null pepper are excluded: a non-null value only ever comes
 * from a prior rotation (block, admin reset, or soft delete), which already
 * invalidated their earlier tokens. Soft-deleted users therefore fall out here
 * too, since `softDeleteUser` already rotates the pepper.
 */
export const blockedUserPepperBackfillCandidates = and(
  isNotNull(kilocode_users.blocked_reason),
  isNull(kilocode_users.api_token_pepper)
);

export async function countMissingBlockedUserPeppers(): Promise<number> {
  const [result] = await db
    .select({ count: count() })
    .from(kilocode_users)
    .where(blockedUserPepperBackfillCandidates);
  return result?.count ?? 0;
}

export async function backfillBlockedUserPepperBatch(): Promise<BackfillBatchResult> {
  let totalProcessed = 0;
  // A short select is the only reliable signal the candidate set is exhausted;
  // the update shrinks the set each batch by setting a non-null pepper.
  let reachedEnd = false;

  for (let i = 0; i < BACKFILL_BATCHES_PER_REQUEST; i++) {
    const rows = await db
      .select({ id: kilocode_users.id })
      .from(kilocode_users)
      .where(blockedUserPepperBackfillCandidates)
      .limit(BACKFILL_BATCH_SIZE);

    if (rows.length === 0) {
      reachedEnd = true;
      break;
    }

    const updated = await db
      .update(kilocode_users)
      .set({
        // Per-row rotation so each user gets a distinct pepper.
        api_token_pepper: sql`gen_random_uuid()::text`,
      })
      .where(
        and(
          inArray(
            kilocode_users.id,
            rows.map(r => r.id)
          ),
          blockedUserPepperBackfillCandidates
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
