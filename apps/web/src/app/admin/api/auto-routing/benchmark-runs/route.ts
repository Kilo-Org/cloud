import {
  BenchmarkKindSchema,
  BenchmarkRunPurposeSchema,
  StartBenchmarkRunRequestSchema,
} from '@kilocode/auto-routing-contracts';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  listBenchmarkRuns,
  startBenchmarkRun,
} from '@/lib/ai-gateway/auto-routing-benchmark-admin-client';
import { getUserFromAuth } from '@/lib/user/server';

export async function GET(request: NextRequest) {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  // Classifier, platform-queue and user-queue runs share one table and the user
  // queue is by far the busiest, so the list filters server-side.
  const kind = BenchmarkKindSchema.safeParse(request.nextUrl.searchParams.get('kind'));
  const purpose = BenchmarkRunPurposeSchema.safeParse(request.nextUrl.searchParams.get('purpose'));
  const result = await listBenchmarkRuns({
    kind: kind.success ? kind.data : undefined,
    purpose: purpose.success ? purpose.data : undefined,
  });
  return NextResponse.json(result.body, { status: result.status });
}

export async function POST(request: NextRequest) {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

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

  const result = await startBenchmarkRun(parsed.data.kind, parsed.data.force, parsed.data.queue);
  return NextResponse.json(result.body, { status: result.status });
}
