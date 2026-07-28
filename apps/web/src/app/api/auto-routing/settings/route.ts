import {
  AutoRoutingModeResponseSchema,
  AutoRoutingSettingsResponseSchema,
  BenchmarkProfileQuotaErrorSchema,
  UpdateAutoRoutingSettingsRequestSchema,
  type AutoRoutingModeOwnerType,
  type AutoRoutingSettingsResponse,
} from '@kilocode/auto-routing-contracts';
import { TRPCError } from '@trpc/server';
import { NextResponse, type NextRequest } from 'next/server';
import {
  getAutoRoutingMode,
  getAutoRoutingSettings,
  updateAutoRoutingSettings,
} from '@/lib/ai-gateway/auto-routing-admin-client';
import {
  annotateConfiguredPool,
  poolValidationMessage,
  toApiSettingsResponse,
  toLegacyModeApiSettingsResponse,
  validatePoolEntries,
  type AutoRoutingSettingsApiResponse,
} from '@/lib/ai-gateway/auto-routing-pool-validation';
import { getUserFromAuth } from '@/lib/user/server';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import { requireActiveSubscriptionOrTrial } from '@/lib/organizations/trial-middleware';

export type { AutoRoutingSettingsApiResponse };

const POOL_TEMPORARILY_UNAVAILABLE_MESSAGE =
  'Custom pools are temporarily unavailable while routing backends update. Try again shortly.';

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

async function annotateWorkerSuccess(
  status: number,
  body: AutoRoutingSettingsResponse,
  owner: { userId: string; organizationId: string | null }
): Promise<NextResponse> {
  const configuredPool = await annotateConfiguredPool({
    userId: owner.userId,
    organizationId: owner.organizationId,
    configuredPool: body.configuredPool,
  });
  const apiBody: AutoRoutingSettingsApiResponse = toApiSettingsResponse(body, configuredPool);
  return NextResponse.json(apiBody, { status });
}

function workerErrorResponse(result: { status: number; body: unknown }): NextResponse {
  if (result.status === 429) {
    const quota = BenchmarkProfileQuotaErrorSchema.safeParse(result.body);
    if (quota.success) {
      return NextResponse.json(quota.data, { status: 429 });
    }
  }
  return NextResponse.json(result.body, { status: result.status });
}

function workerResultResponse(
  result: { status: number; body: unknown },
  owner: { userId: string; organizationId: string | null }
): Promise<NextResponse> | NextResponse {
  if (result.status >= 400) {
    return workerErrorResponse(result);
  }

  const parsed = AutoRoutingSettingsResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid worker settings response' }, { status: 502 });
  }

  return annotateWorkerSuccess(result.status, parsed.data, owner);
}

function legacyModeSuccessResponse(result: { status: number; body: unknown }): NextResponse {
  if (result.status >= 400) {
    return workerErrorResponse(result);
  }
  const parsed = AutoRoutingModeResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid worker mode response' }, { status: 502 });
  }
  // No annotateConfiguredPool — pool is null; no catalog fetch.
  return NextResponse.json(toLegacyModeApiSettingsResponse(parsed.data), { status: 200 });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const owner = await resolveOwner(request);
  if ('response' in owner) return owner.response;

  const result = await getAutoRoutingSettings({
    ownerType: owner.ownerType,
    ownerId: owner.ownerId,
  });
  if (result.status === 404) {
    const legacy = await getAutoRoutingMode({
      ownerType: owner.ownerType,
      ownerId: owner.ownerId,
    });
    return legacyModeSuccessResponse(legacy);
  }
  return workerResultResponse(result, owner);
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

  // Reuse the shared worker contract (includes retryEntries refinements).
  // Owner identity is resolved from auth/query, not the client body.
  const parsed = UpdateAutoRoutingSettingsRequestSchema.safeParse({
    ownerType: owner.ownerType,
    ownerId: owner.ownerId,
    ...(rawBody !== null && typeof rawBody === 'object' ? rawBody : {}),
  });
  if (!parsed.success) {
    // Map common pool/retry shape failures to specific messages when possible.
    const issue = parsed.error.issues[0];
    if (issue) {
      const path = issue.path.join('.');
      if (path.startsWith('retryEntries')) {
        return NextResponse.json(
          {
            error: issue.message,
            reason: 'invalid_retry_entries',
          },
          { status: 400 }
        );
      }
      if (path.startsWith('pool') && issue.message.toLowerCase().includes('duplicate')) {
        return NextResponse.json(
          { error: poolValidationMessage('duplicate_pair'), reason: 'duplicate_pair' },
          { status: 400 }
        );
      }
      if (
        path === 'pool' &&
        (issue.code === 'too_big' || issue.message.toLowerCase().includes('at most'))
      ) {
        return NextResponse.json(
          { error: poolValidationMessage('too_many_entries'), reason: 'too_many_entries' },
          { status: 400 }
        );
      }
      if (
        path === 'pool' &&
        (issue.code === 'too_small' || issue.message.toLowerCase().includes('at least'))
      ) {
        return NextResponse.json(
          { error: poolValidationMessage('empty_pool'), reason: 'empty_pool' },
          { status: 400 }
        );
      }
    }
    return NextResponse.json({ error: 'Invalid routing settings' }, { status: 400 });
  }

  let pool = parsed.data.pool;
  if (pool !== null) {
    const validation = await validatePoolEntries({
      user: { id: owner.userId },
      organizationId: owner.organizationId,
      entries: pool,
    });
    if (!validation.ok) {
      return NextResponse.json(
        {
          error: validation.error.message,
          reason: validation.error.reason,
          ...(validation.error.index !== undefined ? { index: validation.error.index } : {}),
        },
        { status: 400 }
      );
    }
    pool = validation.entries;
  }

  const result = await updateAutoRoutingSettings({
    ownerType: owner.ownerType,
    ownerId: owner.ownerId,
    mode: parsed.data.mode,
    pool,
    ...(parsed.data.retryEntries !== undefined ? { retryEntries: parsed.data.retryEntries } : {}),
  });

  // Settings PUT callers always intend pool-aware writes. An old worker that
  // 404s cannot honor `pool: null` clear intent (or any pool mutation); return
  // a retryable 503 rather than silently falling back to mode-only PUT.
  if (result.status === 404) {
    return NextResponse.json(
      {
        error: POOL_TEMPORARILY_UNAVAILABLE_MESSAGE,
        reason: 'pool_temporarily_unavailable',
      },
      { status: 503 }
    );
  }

  return workerResultResponse(result, owner);
}
