import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { TRPCError } from '@trpc/server';
import {
  ensureOrganizationAccessAndFetchOrg,
  organizationRestAccessContext,
  StaffRequestRefusal,
} from '@kilocode/web-shared/routers/organizations/utils';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { isCodeIndexingEnabled } from '@/lib/code-indexing/availability.server';
import { getCodeIndexOrganizationId } from '@/routers/code-indexing/code-indexing-router';

type EnabledResponse = { enabled: boolean };
type ErrorResponse = { error: string; message?: string };
type EnabledRouteResponse = NextResponse<EnabledResponse | ErrorResponse>;

/**
 * The answer for a failed access check: a refused staff admission keeps the
 * adapter's status and step-up detail; any other refusal is `false`. Only the
 * organization path also answers `false` for an unexpected failure, such as a
 * malformed id.
 */
function refusalResponse(error: unknown, organizationPath: boolean): EnabledRouteResponse {
  if (error instanceof TRPCError && error.cause instanceof StaffRequestRefusal) {
    return error.cause.response;
  }
  if (error instanceof TRPCError || organizationPath) return NextResponse.json({ enabled: false });
  throw error;
}

/**
 * GET /api/code-indexing/enabled?organizationId=<uuid>
 *
 * Returns { enabled: true } if:
 * - organizationId is provided in query params
 * - User is a member of the organization, or staff the staff guard admits
 *   for a read of it
 * - Organization has code_indexing_enabled set to true in settings
 *
 * Without organizationId, returns whether the personal index is enabled: the
 * configured list enables it, and a platform admin needs the staff guard.
 * Both paths reuse this request's one authentication result.
 *
 * Returns { enabled: false } otherwise
 */
export async function GET(request: NextRequest): Promise<EnabledRouteResponse> {
  const auth = await getUserFromAuth({ adminOnly: false });
  if (auth.authFailedResponse) {
    return auth.authFailedResponse;
  }

  if (!isCodeIndexingEnabled()) {
    return NextResponse.json({ enabled: false });
  }

  const ctx = organizationRestAccessContext(auth, {
    headers: request.headers,
    method: request.method,
  });
  const organizationId = request.nextUrl.searchParams.get('organizationId');

  try {
    if (!organizationId) {
      await getCodeIndexOrganizationId(ctx, {}, { actionClass: 'platform_read' });
      return NextResponse.json({ enabled: true });
    }
    const org = await ensureOrganizationAccessAndFetchOrg(ctx, organizationId);
    return NextResponse.json({ enabled: org.settings?.code_indexing_enabled === true });
  } catch (error) {
    return refusalResponse(error, organizationId !== null && organizationId !== '');
  }
}
