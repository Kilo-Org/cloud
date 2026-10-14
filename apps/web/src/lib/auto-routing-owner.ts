import type { AutoRoutingModeOwnerType } from '@kilocode/auto-routing-contracts';
import { TRPCError } from '@trpc/server';
import { NextResponse, type NextRequest } from 'next/server';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { ensureOrganizationAccess } from '@kilocode/web-shared/routers/organizations/utils';

export function trpcErrorResponse(error: unknown): NextResponse<{ error: string }> | null {
  if (!(error instanceof TRPCError)) return null;
  const status =
    error.code === 'UNAUTHORIZED'
      ? 401
      : error.code === 'FORBIDDEN'
        ? 403
        : error.code === 'NOT_FOUND'
          ? 404
          : 500;
  return NextResponse.json({ error: error.message }, { status });
}
export async function resolveOwner(
  request: NextRequest,
  roles?: Parameters<typeof ensureOrganizationAccess>[2]
): Promise<
  | {
      ownerType: AutoRoutingModeOwnerType;
      ownerId: string;
      userId: string;
      organizationId: string | null;
    }
  | { response: NextResponse<{ error: string }> }
> {
  const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });
  if (!user || authFailedResponse) {
    return { response: NextResponse.json({ error: 'Authentication required' }, { status: 401 }) };
  }

  const organizationId = request.nextUrl.searchParams.get('organizationId');
  if (!organizationId) {
    return {
      ownerType: 'user',
      ownerId: user.id,
      userId: user.id,
      organizationId: null,
    };
  }

  try {
    await ensureOrganizationAccess({ user }, organizationId, roles);
  } catch (error) {
    const response = trpcErrorResponse(error);
    if (response) return { response };
    throw error;
  }
  return {
    ownerType: 'org',
    ownerId: organizationId,
    userId: user.id,
    organizationId,
  };
}
