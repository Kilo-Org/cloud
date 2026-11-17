import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getAuthorizedOrgContextOrSupport } from '@/lib/organizations/organization-auth';
import {
  resolveOrganizationBrowserPolicy,
  type OrganizationBrowserPolicy,
} from '@/lib/organizations/browser-policy';

/**
 * The organization's browser automation policy for its clients to enforce: whether
 * browser tools exist at all, whether the bundled browser is the only backend, and the
 * origins every member's client treats as granted. Readable by any member, because
 * every member's client applies it.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse<OrganizationBrowserPolicy | { error: string }>> {
  const organizationId = (await params).id;
  const { success, data, nextResponse } = await getAuthorizedOrgContextOrSupport(
    organizationId,
    '/api/organizations/[id]/browser-policy',
    undefined,
    { requestMethod: request.method }
  );
  if (!success) {
    return nextResponse;
  }

  return NextResponse.json(resolveOrganizationBrowserPolicy(data.organization));
}
