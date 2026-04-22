import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { db } from '@/lib/drizzle';
import { kilocode_users } from '@kilocode/db';
import { and, count, inArray, isNotNull, isNull, like, not, sql } from 'drizzle-orm';

export const blockedAtBackfillCandidates = and(
  isNotNull(kilocode_users.blocked_reason),
  isNull(kilocode_users.blocked_at),
  not(like(kilocode_users.blocked_reason, 'soft-deleted at %'))
);

export type BlockedAtCountsResponse = {
  missing: number;
};

export type BlockedAtBackfillResponse = {
  processed: number;
  remaining: boolean;
};

export async function GET(): Promise<NextResponse<BlockedAtCountsResponse | { error: string }>> {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  const [result] = await db
    .select({ count: count() })
    .from(kilocode_users)
    .where(blockedAtBackfillCandidates);

  return NextResponse.json({ missing: result?.count ?? 0 });
}

const BATCH_SIZE = 1000;
const BATCHES_PER_REQUEST = 50;

export async function backfillBlockedAtBatch(): Promise<BlockedAtBackfillResponse> {
  let totalProcessed = 0;
  let reachedEnd = false;

  for (let i = 0; i < BATCHES_PER_REQUEST; i++) {
    const rows = await db
      .select({ id: kilocode_users.id })
      .from(kilocode_users)
      .where(blockedAtBackfillCandidates)
      .limit(BATCH_SIZE);

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

    if (rows.length < BATCH_SIZE) {
      reachedEnd = true;
      break;
    }
  }

  return { processed: totalProcessed, remaining: !reachedEnd };
}

export async function POST(): Promise<NextResponse<BlockedAtBackfillResponse | { error: string }>> {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  return NextResponse.json(await backfillBlockedAtBatch());
}
