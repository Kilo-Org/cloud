import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import type { BackfillBatchResult } from '@/lib/backfills/batch';
import {
  backfillNormalizedEmailBatch,
  countMissingNormalizedEmails,
} from '@/lib/backfills/normalized-email';

export type NormalizedEmailCountsResponse = {
  missing: number;
};

export type NormalizedEmailBackfillResponse = BackfillBatchResult;

export async function GET(): Promise<
  NextResponse<NormalizedEmailCountsResponse | { error: string }>
> {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  return NextResponse.json({ missing: await countMissingNormalizedEmails() });
}

export async function POST(): Promise<
  NextResponse<NormalizedEmailBackfillResponse | { error: string }>
> {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  return NextResponse.json(await backfillNormalizedEmailBatch());
}
