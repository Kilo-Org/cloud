import { AutoRouterSchema, BenchmarkConfigSchema, DEFAULT_AUTO_ROUTER } from '@kilocode/auto-routing-contracts';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  getBenchmarkConfig,
  updateBenchmarkConfig,
} from '@kilocode/web-shared/lib/ai-gateway/auto-routing-benchmark-admin-client';
import { gatewayChatApisForModel, modelServesAllGatewayChatApis } from '@/lib/model-api-kinds';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';

export async function GET(request?: NextRequest) {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  const router = AutoRouterSchema.safeParse(request?.nextUrl.searchParams.get('router') ?? DEFAULT_AUTO_ROUTER);
  if (!router.success) return NextResponse.json({ error: 'Invalid router' }, { status: 400 });
  const result = await getBenchmarkConfig(router.data);
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

  const parsed = BenchmarkConfigSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid benchmark config' }, { status: 400 });
  }

  // Routing-table candidates carry no per-protocol metadata, so every decider
  // model must be servable on ALL gateway chat API kinds by the provider the
  // gateway would route it to.
  const unsupported = parsed.data.deciderModels
    .map(m => m.id)
    .filter(id => !modelServesAllGatewayChatApis(id))
    .map(id => `${id} (supports: ${gatewayChatApisForModel(id).join(', ') || 'none'})`);
  if (unsupported.length > 0) {
    return NextResponse.json(
      {
        error: `Decider models must support all gateway chat APIs (chat_completions, responses, messages): ${unsupported.join('; ')}`,
      },
      { status: 400 }
    );
  }

  const email = user?.google_user_email ?? '';
  const result = await updateBenchmarkConfig(parsed.data, email);
  return NextResponse.json(result.body, { status: result.status });
}
