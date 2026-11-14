import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import type { BackfillBatchResult } from '@/lib/backfills/batch';
import { backfillEmailDomainBatch, countMissingEmailDomains } from '@/lib/backfills/email-domain';

export type EmailDomainCountsResponse = {
  missing: number;
};

export type EmailDomainBackfillResponse = BackfillBatchResult;

export async function GET(): Promise<NextResponse<EmailDomainCountsResponse | { error: string }>> {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  return NextResponse.json({ missing: await countMissingEmailDomains() });
}

export async function POST(): Promise<
  NextResponse<EmailDomainBackfillResponse | { error: string }>
> {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  return NextResponse.json(await backfillEmailDomainBatch());
}
