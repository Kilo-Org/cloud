import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { handleTRPCRequest } from '@/lib/trpc-route-handler';
import { resolveOrganizationRouteIdentifier } from '@/lib/organizations/organization-route-utils.server';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const routeIdentifier = (await params).id;
  const organizationId = await resolveOrganizationRouteIdentifier(routeIdentifier);

  if (!organizationId) {
    return NextResponse.json({ error: 'Organization not found' }, { status: 404 });
  }

  return handleTRPCRequest(request, async caller => {
    const org = await caller.organizations.withMembers({ organizationId });
    const res = {
      id: org.id,
      name: org.name,
      settings: org.settings || {},
    };
    // set this to false if its undefined, fixes extension coalescing undefined to true
    res.settings.code_indexing_enabled ??= false;
    return res;
  });
}
