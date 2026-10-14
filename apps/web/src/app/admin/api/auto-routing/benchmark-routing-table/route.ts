import { AutoRouterSchema, DEFAULT_AUTO_ROUTER } from '@kilocode/auto-routing-contracts';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getBenchmarkRoutingTable } from '@kilocode/web-shared/lib/ai-gateway/auto-routing-benchmark-admin-client';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';

export async function GET(request?: NextRequest) {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  const router = AutoRouterSchema.safeParse(request?.nextUrl.searchParams.get('router') ?? DEFAULT_AUTO_ROUTER);
  if (!router.success) return NextResponse.json({ error: 'Invalid router' }, { status: 400 });
  const result = await getBenchmarkRoutingTable(router.data);
  return NextResponse.json(result.body, { status: result.status });
}
