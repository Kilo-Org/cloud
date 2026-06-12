import { StartBenchmarkRunRequestSchema } from '@kilocode/auto-routing-contracts';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  listBenchmarkRuns,
  startBenchmarkRun,
} from '@/lib/ai-gateway/auto-routing-benchmark-admin-client';
import { getUserFromAuth } from '@/lib/user/server';

export async function GET() {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  const result = await listBenchmarkRuns();
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

  const result = await startBenchmarkRun(parsed.data.kind, parsed.data.force);
  return NextResponse.json(result.body, { status: result.status });
}
