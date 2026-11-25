import {
  AutoRoutingModeSchema,
  AutoRoutingModeResponseSchema,
  type AutoRoutingModeOwnerQuery,
} from '@kilocode/auto-routing-contracts';
import { TRPCError } from '@trpc/server';
import { NextResponse, type NextRequest } from 'next/server';
import * as z from 'zod';
import {
  getAutoRoutingMode,
  updateAutoRoutingMode,
} from '@kilocode/web-shared/lib/ai-gateway/auto-routing-admin-client';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { ORGANIZATION_BILLING_ROLES } from '@kilocode/app-shared/organizations';
import { ensureOrganizationAccess } from '@kilocode/web-shared/routers/organizations/utils';
import { requireActiveSubscriptionOrTrial } from '@kilocode/web-shared/lib/organizations/trial-middleware';
import {
  adminActionContextFromHeaders,
  recordElevatedOrganizationAdminAction,
} from '@kilocode/web-shared/lib/admin/admin-action-audit';
import type { User } from '@kilocode/db/schema';

function workerResultResponse(result: { status: number; body: unknown }): NextResponse {
  if (result.status >= 400) {
    return NextResponse.json(result.body, { status: result.status });
  }
  return NextResponse.json(AutoRoutingModeResponseSchema.parse(result.body), {
    status: result.status,
  });
}

function trpcErrorResponse(error: unknown): NextResponse<{ error: string }> | null {
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

async function resolveOwner(
  request: NextRequest,
  roles?: Parameters<typeof ensureOrganizationAccess>[2]
): Promise<
  { owner: AutoRoutingModeOwnerQuery; user: User } | { response: NextResponse<{ error: string }> }
> {
  const { user, tokenSource, authFailedResponse } = await getUserFromAuth({ adminOnly: false });
  if (!user || authFailedResponse) {
    return { response: NextResponse.json({ error: 'Authentication required' }, { status: 401 }) };
  }

  const organizationId = request.nextUrl.searchParams.get('organizationId');
  if (organizationId === null) {
    return { owner: { ownerType: 'user', ownerId: user.id }, user };
  }
  if (!z.uuid().safeParse(organizationId).success) {
    return { response: NextResponse.json({ error: 'Invalid organization ID' }, { status: 400 }) };
  }

  try {
    await ensureOrganizationAccess({ user, tokenSource }, organizationId, roles);
  } catch (error) {
    const response = trpcErrorResponse(error);
    if (response) return { response };
    throw error;
  }
  return { owner: { ownerType: 'org', ownerId: organizationId }, user };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const resolved = await resolveOwner(request);
  if ('response' in resolved) return resolved.response;

  return workerResultResponse(await getAutoRoutingMode(resolved.owner));
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const resolved = await resolveOwner(request, ORGANIZATION_BILLING_ROLES);
  if ('response' in resolved) return resolved.response;
  const { owner, user } = resolved;
  if (owner.ownerType === 'org') {
    try {
      await requireActiveSubscriptionOrTrial(owner.ownerId);
    } catch (error) {
      const response = trpcErrorResponse(error);
      if (response) return response;
      throw error;
    }
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = AutoRoutingModeSchema.nullable().safeParse(
    rawBody && typeof rawBody === 'object' && 'mode' in rawBody ? rawBody.mode : undefined
  );
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid routing mode' }, { status: 400 });
  }

  const result = await updateAutoRoutingMode({ ...owner, mode: parsed.data });
  if (owner.ownerType === 'org' && result.status < 400) {
    await recordElevatedOrganizationAdminAction(
      adminActionContextFromHeaders(user, request.headers),
      {
        organizationId: owner.ownerId,
        requiredRoles: ORGANIZATION_BILLING_ROLES,
        action: 'organization.auto_routing_mode.set',
        message: 'Set the auto-routing mode',
        metadata: { mode: parsed.data },
      }
    );
  }
  return workerResultResponse(result);
}
