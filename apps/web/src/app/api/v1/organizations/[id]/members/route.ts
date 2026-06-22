import type { NextRequest } from 'next/server';
import { PublicOrganizationMembersSchema } from '@/lib/organizations/organization-types';
import { handleTRPCRequest } from '@/lib/trpc-route-handler';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const organizationId = (await params).id;

  return handleTRPCRequest(request, async caller => {
    const org = await caller.organizations.withMembers({ organizationId });
    return PublicOrganizationMembersSchema.parse(org.members);
  });
}
