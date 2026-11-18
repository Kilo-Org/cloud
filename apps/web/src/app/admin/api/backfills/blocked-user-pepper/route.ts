import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import type { BackfillBatchResult } from '@/lib/backfills/batch';
import {
  backfillBlockedUserPepperBatch,
  countMissingBlockedUserPeppers,
} from '@/lib/backfills/blocked-user-pepper';

export type BlockedUserPepperCountsResponse = {
  missing: number;
};

export type BlockedUserPepperBackfillResponse = BackfillBatchResult;

export async function GET(): Promise<
  NextResponse<BlockedUserPepperCountsResponse | { error: string }>
> {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  return NextResponse.json({ missing: await countMissingBlockedUserPeppers() });
}

export async function POST(): Promise<
  NextResponse<BlockedUserPepperBackfillResponse | { error: string }>
> {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  return NextResponse.json(await backfillBlockedUserPepperBatch());
}
