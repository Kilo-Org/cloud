import { AutoRouterSchema, DEFAULT_AUTO_ROUTER } from '@kilocode/auto-routing-contracts';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { cancelBenchmarkRun } from '@kilocode/web-shared/lib/ai-gateway/auto-routing-benchmark-admin-client';
import {
  addAdminAuditMetadata,
  auditedAdminRoute,
  inputFieldTarget,
  setAdminAuditActor,
} from '@kilocode/web-shared/lib/admin/admin-action-audit';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';

export const POST = auditedAdminRoute(
  {
    kind: 'declarative',
    action: 'auto_routing.benchmark_run.cancel',
    target: inputFieldTarget('other', 'runId'),
  },
  async (request: NextRequest, { params }: { params: Promise<{ runId: string }> }) => {
    const { authFailedResponse, user } = await getUserFromAuth({ adminOnly: true });
    if (authFailedResponse) return authFailedResponse;
    setAdminAuditActor(user);

    const router = AutoRouterSchema.safeParse(
      request.nextUrl.searchParams.get('router') ?? DEFAULT_AUTO_ROUTER
    );
    if (!router.success) return NextResponse.json({ error: 'Invalid router' }, { status: 400 });
    addAdminAuditMetadata({ router: router.data });
    const result = await cancelBenchmarkRun((await params).runId, router.data);
    return NextResponse.json(result.body, { status: result.status });
  }
);
