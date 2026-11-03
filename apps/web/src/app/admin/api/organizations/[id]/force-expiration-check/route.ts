import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { getOrganizationById } from '@kilocode/web-shared/lib/organizations/organizations';
import { processOrganizationExpirations } from '@kilocode/web-shared/lib/creditExpiration';
import { recomputeOrganizationBalances } from '@/lib/recomputeOrganizationBalances';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse<{ success: boolean; recomputed: boolean } | { error: string }>> {
  const id = (await params).id;
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });

  if (authFailedResponse) {
    return authFailedResponse;
  }

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
