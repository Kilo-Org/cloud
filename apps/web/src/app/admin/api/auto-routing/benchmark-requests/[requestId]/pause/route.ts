import { PaidBenchmarkIdSchema } from '@kilocode/auto-routing-contracts';
import { NextResponse } from 'next/server';
import { pausePaidBenchmarkAdminRequest } from '@kilocode/web-shared/lib/ai-gateway/auto-routing-benchmark-admin-client';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ requestId: string }> }
) {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  const requestId = PaidBenchmarkIdSchema.safeParse((await params).requestId);
  if (!requestId.success) {
    return NextResponse.json({ error: 'Invalid paid request id' }, { status: 400 });
  }
  const result = await pausePaidBenchmarkAdminRequest(requestId.data);
  return NextResponse.json(result.body, { status: result.status });
}
