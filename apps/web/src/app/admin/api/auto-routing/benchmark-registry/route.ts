import { RequeueBenchmarkRegistryRequestSchema } from '@kilocode/auto-routing-contracts';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  getBenchmarkRegistry,
  requeueBenchmarkRegistry,
} from '@/lib/ai-gateway/auto-routing-benchmark-admin-client';
import { getUserFromAuth } from '@/lib/user/server';

export async function GET() {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  const result = await getBenchmarkRegistry();
  return NextResponse.json(result.body, { status: result.status });
}

/** Requeue failed registry rows of the selected queue(s). */
export async function POST(request: NextRequest) {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = RequeueBenchmarkRegistryRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid requeue request' }, { status: 400 });
  }

  const result = await requeueBenchmarkRegistry(parsed.data.scope);
  return NextResponse.json(result.body, { status: result.status });
}
