import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import type { BackfillBatchResult } from '@/lib/backfills/batch';
import {
  backfillSafetyIdentifiersBatch,
  countMissingSafetyIdentifiers,
} from '@/lib/backfills/safety-identifiers';

export type SafetyIdentifierCountsResponse = {
  missing: number;
};

export type BackfillBatchResponse = BackfillBatchResult;

export async function GET(): Promise<
  NextResponse<SafetyIdentifierCountsResponse | { error: string }>
> {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  return NextResponse.json({ missing: await countMissingSafetyIdentifiers() });
}

export async function POST(): Promise<NextResponse<BackfillBatchResponse | { error: string }>> {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  return NextResponse.json(await backfillSafetyIdentifiersBatch());
}
