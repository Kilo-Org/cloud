import {
  AutoRouterSchema,
  DEFAULT_AUTO_ROUTER,
  BenchmarkKindSchema,
  BenchmarkRunPurposeSchema,
  StartBenchmarkRunRequestSchema,
} from '@kilocode/auto-routing-contracts';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  listBenchmarkRuns,
  startBenchmarkRun,
} from '@kilocode/web-shared/lib/ai-gateway/auto-routing-benchmark-admin-client';
import {
  addAdminAuditMetadata,
  auditedAdminRoute,
  setAdminAuditActor,
} from '@kilocode/web-shared/lib/admin/admin-action-audit';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';

export async function GET(request: NextRequest) {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  // Classifier, platform-queue and user-queue runs share one table and the user
  // queue is by far the busiest, so the list filters server-side.
  const router = AutoRouterSchema.safeParse(
    request.nextUrl.searchParams.get('router') ?? DEFAULT_AUTO_ROUTER
  );
  if (!router.success) return NextResponse.json({ error: 'Invalid router' }, { status: 400 });
  const kind = BenchmarkKindSchema.safeParse(request.nextUrl.searchParams.get('kind'));
  const purpose = BenchmarkRunPurposeSchema.safeParse(request.nextUrl.searchParams.get('purpose'));
  const result = await listBenchmarkRuns({
    router: router.data,
    kind: kind.success ? kind.data : undefined,
    purpose: purpose.success ? purpose.data : undefined,
  });
  return NextResponse.json(result.body, { status: result.status });
}

export const POST = auditedAdminRoute(
  { kind: 'declarative', action: 'auto_routing.benchmark_run.start' },
  startRun
);

async function startRun(request: NextRequest) {
  const { authFailedResponse, user } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;
  setAdminAuditActor(user);

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = StartBenchmarkRunRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid start benchmark run request' }, { status: 400 });
  }
  const { kind, force, queue, router } = parsed.data;
  addAdminAuditMetadata({ kind, force, queue, router });

  const result = await startBenchmarkRun(kind, force, queue, router);
  return NextResponse.json(result.body, { status: result.status });
}
