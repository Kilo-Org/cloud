import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getAuthorizedOrgContext } from '@/lib/organizations/organization-auth';
import {
  getPermissionPolicy,
  ifNoneMatchMatches,
} from '@/lib/organizations/guardrails/permission-policy';
import type { PermissionPolicyResponse } from '@/lib/organizations/permissions/types';

const CACHE_CONTROL = 'private, no-cache';

/**
 * The organization's ordered tool and command permission policy for its clients to enforce.
 * Readable by any member. Clients revalidate with `If-None-Match` and get `304` when unchanged.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse<PermissionPolicyResponse | { error: string } | null>> {
  const organizationId = (await params).id;
  const { success, data, nextResponse } = await getAuthorizedOrgContext(organizationId);
  if (!success) {
    return nextResponse;
  }

  const { policy, etag } = await getPermissionPolicy(data.organization);
  const headers = { ETag: etag, 'Cache-Control': CACHE_CONTROL, Vary: 'Authorization, Cookie' };
  if (ifNoneMatchMatches(request.headers.get('if-none-match'), etag)) {
    return new NextResponse(null, { status: 304, headers });
  }
  return NextResponse.json(policy, { headers });
}
