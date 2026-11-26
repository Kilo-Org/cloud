import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { getBalanceForUser } from '@kilocode/web-shared/lib/user/balance';
import { findUserById } from '@kilocode/web-shared/lib/user/find-user-by-id';
import {
  auditedAdminRoute,
  setAdminAuditActor,
  setAdminAuditTarget,
  userActionTarget,
} from '@kilocode/web-shared/lib/admin/admin-action-audit';

export const POST = auditedAdminRoute(
  { kind: 'declarative', action: 'user.balance_cache.refresh' },
  async (
    _request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
  ): Promise<NextResponse<{ success: boolean } | { error: string }>> => {
    const id = (await params).id;
    const { user: admin, authFailedResponse } = await getUserFromAuth({ adminOnly: true });

    if (authFailedResponse) {
      return authFailedResponse;
    }
    setAdminAuditActor(admin);

    const userId = decodeURIComponent(id);
    setAdminAuditTarget(userActionTarget(userId));

    const user = await findUserById(userId);
    if (!user) {
      return NextResponse.json({ error: 'User not found: ' + userId }, { status: 404 });
    }
    await getBalanceForUser(user, { forceRefresh: true });

    return NextResponse.json({ success: true });
  }
);
