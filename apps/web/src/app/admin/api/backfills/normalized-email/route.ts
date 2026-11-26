import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import {
  addAdminAuditMetadata,
  auditedAdminRoute,
  setAdminAuditActor,
} from '@kilocode/web-shared/lib/admin/admin-action-audit';
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

// The batch updates rows without returning which, so the row carries the count.
export const POST = auditedAdminRoute(
  { kind: 'declarative', action: 'backfill.normalized_email.run' },
  async (
    _request: Request
  ): Promise<NextResponse<NormalizedEmailBackfillResponse | { error: string }>> => {
    const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: true });
    if (authFailedResponse) return authFailedResponse;
    setAdminAuditActor(user);

    const result = await backfillNormalizedEmailBatch();
    addAdminAuditMetadata(result);
    return NextResponse.json(result);
  }
);
