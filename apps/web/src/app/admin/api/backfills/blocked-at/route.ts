import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import {
  addAdminAuditMetadata,
  adminActionContextFromHeaders,
  auditedAdminRoute,
  recordAdminActions,
  setAdminAuditActor,
  userActionTarget,
} from '@kilocode/web-shared/lib/admin/admin-action-audit';
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

// One summary row for the run, plus one row per user a batch changed.
export const POST = auditedAdminRoute(
  { kind: 'declarative', action: 'backfill.blocked_at.run' },
  async (
    request: Request
  ): Promise<NextResponse<BlockedAtBackfillResponse | { error: string }>> => {
    const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: true });
    if (authFailedResponse) return authFailedResponse;
    setAdminAuditActor(user);

    const auditContext = adminActionContextFromHeaders(user, request.headers);
    const result = await backfillBlockedAtBatch(userIds =>
      recordAdminActions(
        auditContext,
        userIds.map(userId => ({
          action: 'user.blocked_at.backfill',
          target: userActionTarget(userId),
          message: 'Backfilled blocked_at',
        }))
      )
    );
    addAdminAuditMetadata(result);
    return NextResponse.json(result);
  }
);
