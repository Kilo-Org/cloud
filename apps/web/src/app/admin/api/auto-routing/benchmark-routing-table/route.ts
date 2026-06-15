import { NextResponse } from 'next/server';
import { getBenchmarkRoutingTable } from '@/lib/ai-gateway/auto-routing-benchmark-admin-client';
import { getUserFromAuth } from '@/lib/user/server';

export async function GET() {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  const result = await getBenchmarkRoutingTable();
  return NextResponse.json(result.body, { status: result.status });
}
