import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import {
  addAdminAuditMetadata,
  auditedAdminRoute,
  setAdminAuditActor,
} from '@kilocode/web-shared/lib/admin/admin-action-audit';
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

// The batch updates rows without returning which, so the row carries the count.
export const POST = auditedAdminRoute(
  { kind: 'declarative', action: 'backfill.safety_identifiers.run' },
  async (_request: Request): Promise<NextResponse<BackfillBatchResponse | { error: string }>> => {
    const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: true });
    if (authFailedResponse) return authFailedResponse;
    setAdminAuditActor(user);

    const result = await backfillSafetyIdentifiersBatch();
    addAdminAuditMetadata(result);
    return NextResponse.json(result);
  }
);
