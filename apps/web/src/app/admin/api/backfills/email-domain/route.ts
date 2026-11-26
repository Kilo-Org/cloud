import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import {
  addAdminAuditMetadata,
  auditedAdminRoute,
  setAdminAuditActor,
} from '@kilocode/web-shared/lib/admin/admin-action-audit';
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

// The batch updates rows without returning which, so the row carries the count.
export const POST = auditedAdminRoute(
  { kind: 'declarative', action: 'backfill.email_domain.run' },
  async (
    _request: Request
  ): Promise<NextResponse<EmailDomainBackfillResponse | { error: string }>> => {
    const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: true });
    if (authFailedResponse) return authFailedResponse;
    setAdminAuditActor(user);

    const result = await backfillEmailDomainBatch();
    addAdminAuditMetadata(result);
    return NextResponse.json(result);
  }
);
