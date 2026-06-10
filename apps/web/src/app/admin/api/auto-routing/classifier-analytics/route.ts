import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import * as z from 'zod';
import { getAutoRoutingClassifierAnalytics } from '@/lib/ai-gateway/auto-routing-admin-client';
import { getUserFromAuth } from '@/lib/user/server';

const periodSchema = z.enum(['1h', '24h', '7d', '30d']);

export async function GET(request: NextRequest) {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  const period = request.nextUrl.searchParams.get('period') ?? '24h';
  const parsedPeriod = periodSchema.safeParse(period);
  if (!parsedPeriod.success) {
    return NextResponse.json({ error: 'Invalid analytics period' }, { status: 400 });
  }

  const result = await getAutoRoutingClassifierAnalytics(parsedPeriod.data);
  return NextResponse.json(result.body, { status: result.status });
}
