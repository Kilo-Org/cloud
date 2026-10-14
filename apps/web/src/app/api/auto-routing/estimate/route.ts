import { EstimateBenchmarkProfilesRequestSchema } from '@kilocode/auto-routing-contracts';
import { ORGANIZATION_BILLING_ROLES } from '@kilocode/app-shared/organizations';
import { estimateAutoRoutingProfiles } from '@kilocode/web-shared/lib/ai-gateway/auto-routing-admin-client';
import { NextResponse, type NextRequest } from 'next/server';
import { validatePoolEntries } from '@/lib/auto-routing-pool-validation';
import { resolveOwner, trpcErrorResponse } from '@/lib/auto-routing-owner';
import { requireActiveSubscriptionOrTrial } from '@kilocode/web-shared/lib/organizations/trial-middleware';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const owner = await resolveOwner(request, ORGANIZATION_BILLING_ROLES);
  if ('response' in owner) return owner.response;
  if (owner.ownerType === 'org') {
    try {
      await requireActiveSubscriptionOrTrial(owner.ownerId);
    } catch (error) {
      const response = trpcErrorResponse(error);
      if (response) return response;
      throw error;
    }
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = EstimateBenchmarkProfilesRequestSchema.safeParse({
    ...(body !== null && typeof body === 'object' ? body : {}),
    ownerType: owner.ownerType,
    ownerId: owner.ownerId,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid benchmark estimate request' }, { status: 400 });
  }
  const validation = await validatePoolEntries({
    user: { id: owner.userId },
    organizationId: owner.organizationId,
    entries: parsed.data.entries,
  });
  if (!validation.ok) {
    return NextResponse.json(
      { error: validation.error.message, reason: validation.error.reason },
      { status: 400 }
    );
  }
  const result = await estimateAutoRoutingProfiles({ ...parsed.data, entries: validation.entries });
  return NextResponse.json(result.body, { status: result.status });
}
