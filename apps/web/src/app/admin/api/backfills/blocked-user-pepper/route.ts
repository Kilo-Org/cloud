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

// One summary row for the run, plus one row per user whose tokens it revoked.
export const POST = auditedAdminRoute(
  { kind: 'declarative', action: 'backfill.blocked_user_pepper.run' },
  async (
    request: Request
  ): Promise<NextResponse<BlockedUserPepperBackfillResponse | { error: string }>> => {
    const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: true });
    if (authFailedResponse) return authFailedResponse;
    setAdminAuditActor(user);

    const auditContext = adminActionContextFromHeaders(user, request.headers);
    const result = await backfillBlockedUserPepperBatch(userIds =>
      recordAdminActions(
        auditContext,
        userIds.map(userId => ({
          action: 'user.api_token_pepper.backfill',
          target: userActionTarget(userId),
          message: 'Assigned an API token pepper to a blocked user',
        }))
      )
    );
    addAdminAuditMetadata(result);
    return NextResponse.json(result);
  }
);
