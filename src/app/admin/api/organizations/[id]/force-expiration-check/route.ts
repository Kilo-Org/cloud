import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { getOrganizationById } from '@/lib/organizations/organizations';
import { processOrganizationExpirations } from '@/lib/creditExpiration';
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

  // Re-fetch org since balance may have changed
  const updatedOrg = await getOrganizationById(id);
  if (updatedOrg) {
    await processOrganizationExpirations(
      {
        id: updatedOrg.id,
        microdollars_used: updatedOrg.microdollars_used,
        next_credit_expiration_at: updatedOrg.next_credit_expiration_at,
        total_microdollars_acquired: updatedOrg.total_microdollars_acquired,
      },
      new Date()
    );
  }

  return NextResponse.json({
    success: true,
    recomputed: recomputeResult.success,
  });
}
