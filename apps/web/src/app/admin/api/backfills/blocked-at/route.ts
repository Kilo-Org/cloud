import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import type { BackfillBatchResult } from '@/lib/backfills/batch';
import { backfillBlockedAtBatch, countMissingBlockedAt } from '@/lib/backfills/blocked-at';

export type BlockedAtCountsResponse = {
  missing: number;
};

export type BlockedAtBackfillResponse = BackfillBatchResult;

export async function GET(): Promise<NextResponse<BlockedAtCountsResponse | { error: string }>> {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  return NextResponse.json({ missing: await countMissingBlockedAt() });
}

export async function POST(): Promise<NextResponse<BlockedAtBackfillResponse | { error: string }>> {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  return NextResponse.json(await backfillBlockedAtBatch());
}
