import { NextResponse } from 'next/server';
import { getAuthorizedOrgContextOrSupport } from '@/lib/organizations/organization-auth';
import type { NextRequest } from 'next/server';
import type { OrganizationMode } from '@/lib/organizations/organization-modes';
import { getAllOrganizationModes } from '@/lib/organizations/organization-modes';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse<{ modes: OrganizationMode[] } | { error: string }>> {
  const organizationId = (await params).id;
  const { success, data, nextResponse } = await getAuthorizedOrgContextOrSupport(
    organizationId,
    '/api/organizations/[id]/modes',
    undefined,
    { requestMethod: request.method }
  );
  if (!success) {
    return nextResponse;
  }

  const { organization } = data;

  return NextResponse.json({
    modes: await getAllOrganizationModes(organization.id),
  });
}
