import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { createTRPCContext } from '@/lib/trpc/init';
import { ensureOrganizationAccessAndFetchOrg } from '@/routers/organizations/utils';
import { getUserFromAuth } from '@/lib/user.server';
import { isEnabledForUser } from '@/lib/code-indexing/util';

type EnabledResponse = { enabled: boolean };
type ErrorResponse = { error: string; message?: string };

/**
 * GET /api/code-indexing/enabled?organizationId=<uuid>
 *
 * Returns whether code indexing is enabled for the specified organization.
 * Returns { enabled: true } if:
 * - organizationId is provided in query params
 * - User is a member of the organization
 * - Organization has code_indexing_enabled set to true in settings
 *
 * Returns { enabled: false } otherwise
 */
export async function GET(
  request: NextRequest
): Promise<NextResponse<EnabledResponse | ErrorResponse>> {
  const res = await getUserFromAuth({ adminOnly: false });
  if (!res.user) {
    return res.authFailedResponse;
  }

  // Get organizationId from query params
  const { searchParams } = new URL(request.url);
  const organizationId = searchParams.get('organizationId');

  // If no organizationId provided, return false
  if (!organizationId) {
    return NextResponse.json({ enabled: isEnabledForUser(res.user) });
  }

  // Check if user has access to the organization and fetch it
  try {
    // Create tRPC context for authentication
    const ctx = await createTRPCContext();
    const org = await ensureOrganizationAccessAndFetchOrg(ctx, organizationId);

    // Check if code indexing is enabled in organization settings
    const enabled = org.settings?.code_indexing_enabled === true;

    return NextResponse.json({ enabled });
  } catch (_error) {
    // If user doesn't have access or org doesn't exist, return false
    return NextResponse.json({ enabled: false });
  }
}
