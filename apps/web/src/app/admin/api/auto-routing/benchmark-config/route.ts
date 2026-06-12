import { BenchmarkConfigUpdateSchema } from '@kilocode/auto-routing-contracts';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  getBenchmarkConfig,
  updateBenchmarkConfig,
} from '@/lib/ai-gateway/auto-routing-benchmark-admin-client';
import { supportedApiKindsForModel } from '@/lib/ai-gateway/model-api-kinds';
import { getUserFromAuth } from '@/lib/user/server';

export async function GET() {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  const result = await getBenchmarkConfig();
  return NextResponse.json(result.body, { status: result.status });
}

export async function PUT(request: NextRequest) {
  const { authFailedResponse, user } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = BenchmarkConfigUpdateSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid benchmark config' }, { status: 400 });
  }

  // supportedApiKinds is server-derived from gateway provider definitions —
  // the admin UI never sends it.
  const config = {
    ...parsed.data,
    deciderModels: parsed.data.deciderModels.map(m => ({
      ...m,
      supportedApiKinds: supportedApiKindsForModel(m.id),
    })),
  };

  const email = user?.google_user_email ?? '';
  const result = await updateBenchmarkConfig(config, email);
  return NextResponse.json(result.body, { status: result.status });
}
