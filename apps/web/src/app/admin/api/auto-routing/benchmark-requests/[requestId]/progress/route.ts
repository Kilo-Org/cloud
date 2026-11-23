import { PaidBenchmarkIdSchema } from '@kilocode/auto-routing-contracts';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getPaidBenchmarkAdminProgress } from '@kilocode/web-shared/lib/ai-gateway/auto-routing-benchmark-admin-client';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { withAdminLabels } from '../../labels';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ requestId: string }> }
) {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  const requestId = PaidBenchmarkIdSchema.safeParse((await params).requestId);
  if (!requestId.success) {
    return NextResponse.json({ error: 'Invalid paid request id' }, { status: 400 });
  }
  const result = await getPaidBenchmarkAdminProgress(
    requestId.data,
    request.nextUrl.searchParams.get('cursor') ?? undefined
  );
  if (result.status !== 200 || !('request' in result.body)) {
    return NextResponse.json(result.body, { status: result.status });
  }
  const { request: row, cases, nextCursor } = result.body;
  if (row === null) {
    return NextResponse.json({ status: 'empty', request: null, cases: [], nextCursor });
  }
  const [labelled] = await withAdminLabels([row]);
  return NextResponse.json({ status: row.status, request: labelled, cases, nextCursor });
}
