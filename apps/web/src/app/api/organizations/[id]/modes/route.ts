import { NextResponse } from 'next/server';
import { getAuthorizedOrgContext } from '@/lib/organizations/organization-auth';
import type { NextRequest } from 'next/server';
import type { OrganizationMode } from '@/lib/organizations/organization-modes';
import { getAllOrganizationModes } from '@/lib/organizations/organization-modes';
import { projectOrganizationAutoRoutesIntoModes } from '@/lib/organizations/organization-auto-model';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse<{ modes: OrganizationMode[] } | { error: string }>> {
  const organizationId = (await params).id;
  const { success, data, nextResponse } = await getAuthorizedOrgContext(organizationId);
  if (!success) {
    return nextResponse;
  }

  const { organization } = data;
  const modes = projectOrganizationAutoRoutesIntoModes(
    await getAllOrganizationModes(organization.id),
    organization.settings
  );

  return NextResponse.json({
    modes,
  });
}
