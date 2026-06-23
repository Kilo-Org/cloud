import {
  AutoRoutingModeSchema,
  AutoRoutingModeResponseSchema,
  type AutoRoutingModeOwnerType,
} from '@kilocode/auto-routing-contracts';
import { TRPCError } from '@trpc/server';
import { NextResponse, type NextRequest } from 'next/server';
import {
  getAutoRoutingMode,
  updateAutoRoutingMode,
} from '@/lib/ai-gateway/auto-routing-admin-client';
import { getUserFromAuth } from '@/lib/user/server';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import { requireActiveSubscriptionOrTrial } from '@/lib/organizations/trial-middleware';

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
  | { ownerType: AutoRoutingModeOwnerType; ownerId: string }
  | { response: NextResponse<{ error: string }> }
> {
  const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });
  if (!user || authFailedResponse) {
    return { response: NextResponse.json({ error: 'Authentication required' }, { status: 401 }) };
  }

  const organizationId = request.nextUrl.searchParams.get('organizationId');
  if (!organizationId) {
    return { ownerType: 'user', ownerId: user.id };
  }

  try {
    await ensureOrganizationAccess({ user }, organizationId, roles);
  } catch (error) {
    const response = trpcErrorResponse(error);
    if (response) return { response };
    throw error;
  }
  return { ownerType: 'org', ownerId: organizationId };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const owner = await resolveOwner(request);
  if ('response' in owner) return owner.response;

  const result = await getAutoRoutingMode(owner);
  return workerResultResponse(result);
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const owner = await resolveOwner(request, ['owner', 'billing_manager']);
  if ('response' in owner) return owner.response;
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
    rawBody && typeof rawBody === 'object' && 'mode' in rawBody
      ? (rawBody as { mode?: unknown }).mode
      : undefined
  );
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid routing mode' }, { status: 400 });
  }

  const result = await updateAutoRoutingMode({ ...owner, mode: parsed.data });
  return workerResultResponse(result);
}
