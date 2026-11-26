import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { getOrganizationById } from '@kilocode/web-shared/lib/organizations/organizations';
import { processOrganizationExpirations } from '@kilocode/web-shared/lib/creditExpiration';
import {
  auditedAdminRoute,
  inputFieldTarget,
  setAdminAuditActor,
} from '@kilocode/web-shared/lib/admin/admin-action-audit';
import { recomputeOrganizationBalances } from '@/lib/recomputeOrganizationBalances';

export const POST = auditedAdminRoute(
  {
    kind: 'declarative',
    action: 'organization.credit_expiration.force_check',
    target: inputFieldTarget('organization', 'id'),
  },
  async (
    _request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
  ): Promise<NextResponse<{ success: boolean; recomputed: boolean } | { error: string }>> => {
    const id = (await params).id;
    const { user: admin, authFailedResponse } = await getUserFromAuth({ adminOnly: true });

    if (authFailedResponse) {
      return authFailedResponse;
    }
    setAdminAuditActor(admin);

    const org = await getOrganizationById(id);
    if (!org) {
      return NextResponse.json({ error: 'Organization not found: ' + id }, { status: 404 });
    }

    // Recompute balances first to fix any ledger drift
    const recomputeResult = await recomputeOrganizationBalances({ organizationId: id });

    if (!recomputeResult.success) {
      return NextResponse.json(
        { error: 'Balance recomputation failed (concurrent modification) — retry' },
        { status: 409 }
      );
    }

    await processOrganizationExpirations(id, new Date(), { force: true });

    return NextResponse.json({
      success: true,
      recomputed: true,
    });
  }
);
