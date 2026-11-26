import { PaidBenchmarkIdSchema } from '@kilocode/auto-routing-contracts';
import { NextResponse } from 'next/server';
import { getPaidBenchmarkAdminRoutingTable } from '@kilocode/web-shared/lib/ai-gateway/auto-routing-benchmark-admin-client';
import { auditedAdminRoute } from '@kilocode/web-shared/lib/admin/admin-action-audit';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';

export const POST = auditedAdminRoute(
  {
    kind: 'exempt',
    reason: 'POST-typed read: returns the stored routing table; the Worker writes nothing',
  },
  async (_request: Request, { params }: { params: Promise<{ requestId: string }> }) => {
    const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
    if (authFailedResponse) return authFailedResponse;

    const requestId = PaidBenchmarkIdSchema.safeParse((await params).requestId);
    if (!requestId.success) {
      return NextResponse.json({ error: 'Invalid paid request id' }, { status: 400 });
    }
    const result = await getPaidBenchmarkAdminRoutingTable(requestId.data);
    return NextResponse.json(result.body, { status: result.status });
  }
);
