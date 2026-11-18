import {
  AutoRouterSchema,
  DEFAULT_AUTO_ROUTER,
  RequeueBenchmarkRegistryRequestSchema,
} from '@kilocode/auto-routing-contracts';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  getBenchmarkRegistry,
  requeueBenchmarkRegistry,
} from '@kilocode/web-shared/lib/ai-gateway/auto-routing-benchmark-admin-client';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';

export async function GET(request?: NextRequest) {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  const router = AutoRouterSchema.safeParse(
    request?.nextUrl.searchParams.get('router') ?? DEFAULT_AUTO_ROUTER
  );
  if (!router.success) return NextResponse.json({ error: 'Invalid router' }, { status: 400 });
  const result = await getBenchmarkRegistry(router.data);
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

  const result = await requeueBenchmarkRegistry(parsed.data.scope, parsed.data.router);
  return NextResponse.json(result.body, { status: result.status });
}
