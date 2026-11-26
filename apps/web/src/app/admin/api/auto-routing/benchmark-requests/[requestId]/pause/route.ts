import { PaidBenchmarkIdSchema } from '@kilocode/auto-routing-contracts';
import { NextResponse } from 'next/server';
import { pausePaidBenchmarkAdminRequest } from '@kilocode/web-shared/lib/ai-gateway/auto-routing-benchmark-admin-client';
import {
  auditedAdminRoute,
  inputFieldTarget,
  setAdminAuditActor,
} from '@kilocode/web-shared/lib/admin/admin-action-audit';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';

export const POST = auditedAdminRoute(
  {
    kind: 'declarative',
    action: 'auto_routing.paid_benchmark_request.pause',
    target: inputFieldTarget('other', 'requestId'),
  },
  async (_request: Request, { params }: { params: Promise<{ requestId: string }> }) => {
    const { authFailedResponse, user } = await getUserFromAuth({ adminOnly: true });
    if (authFailedResponse) return authFailedResponse;
    setAdminAuditActor(user);

    const requestId = PaidBenchmarkIdSchema.safeParse((await params).requestId);
    if (!requestId.success) {
      return NextResponse.json({ error: 'Invalid paid request id' }, { status: 400 });
    }
    const result = await pausePaidBenchmarkAdminRequest(requestId.data);
    return NextResponse.json(result.body, { status: result.status });
  }
);
