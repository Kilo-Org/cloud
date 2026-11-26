import { BenchmarkSchedulerOverridesSchema } from '@kilocode/auto-routing-contracts';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  getBenchmarkSchedulerConfig,
  updateBenchmarkSchedulerConfig,
} from '@kilocode/web-shared/lib/ai-gateway/auto-routing-benchmark-admin-client';
import {
  addAdminAuditMetadata,
  auditedAdminRoute,
  setAdminAuditActor,
} from '@kilocode/web-shared/lib/admin/admin-action-audit';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';

export async function GET() {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  const result = await getBenchmarkSchedulerConfig();
  return NextResponse.json(result.body, { status: result.status });
}

export const PUT = auditedAdminRoute(
  { kind: 'declarative', action: 'auto_routing.benchmark_scheduler_config.update' },
  async (request: NextRequest) => {
    const { authFailedResponse, user } = await getUserFromAuth({ adminOnly: true });
    if (authFailedResponse) return authFailedResponse;
    setAdminAuditActor(user);

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const parsed = BenchmarkSchedulerOverridesSchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid scheduler config' }, { status: 400 });
    }
    // The overrides are a closed set of numeric limits, so the row keeps them.
    addAdminAuditMetadata({ overrides: parsed.data });

    const result = await updateBenchmarkSchedulerConfig(parsed.data, user.google_user_email);
    return NextResponse.json(result.body, { status: result.status });
  }
);
