import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user/server';
import { db } from '@/lib/drizzle';
import { kilocode_users } from '@kilocode/db';
import { and, count, inArray, isNotNull, isNull, sql } from 'drizzle-orm';

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

export type BlockedUserPepperCountsResponse = {
  missing: number;
};

export type BlockedUserPepperBackfillResponse = {
  processed: number;
  remaining: boolean;
};

export async function GET(): Promise<
  NextResponse<BlockedUserPepperCountsResponse | { error: string }>
> {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  const [result] = await db
    .select({ count: count() })
    .from(kilocode_users)
    .where(blockedUserPepperBackfillCandidates);

  return NextResponse.json({ missing: result?.count ?? 0 });
}

const BATCH_SIZE = 1000;
const BATCHES_PER_REQUEST = 50;

export async function backfillBlockedUserPepperBatch(): Promise<BlockedUserPepperBackfillResponse> {
  let totalProcessed = 0;
  // A short select is the only reliable signal the candidate set is exhausted;
  // the update shrinks the set each batch by setting a non-null pepper.
  let reachedEnd = false;

  for (let i = 0; i < BATCHES_PER_REQUEST; i++) {
    const rows = await db
      .select({ id: kilocode_users.id })
      .from(kilocode_users)
      .where(blockedUserPepperBackfillCandidates)
      .limit(BATCH_SIZE);

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

    if (rows.length < BATCH_SIZE) {
      reachedEnd = true;
      break;
    }
  }

  return { processed: totalProcessed, remaining: !reachedEnd };
}

export async function POST(): Promise<
  NextResponse<BlockedUserPepperBackfillResponse | { error: string }>
> {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  return NextResponse.json(await backfillBlockedUserPepperBatch());
}
