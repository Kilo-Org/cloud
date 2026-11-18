import { AutoRoutingAnalyticsPeriodSchema } from '@kilocode/auto-routing-contracts';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getAutoRoutingClassifierAnalytics } from '@kilocode/web-shared/lib/ai-gateway/auto-routing-admin-client';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';

export async function GET(request: NextRequest) {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  const period = request.nextUrl.searchParams.get('period') ?? '24h';
  const parsedPeriod = AutoRoutingAnalyticsPeriodSchema.safeParse(period);
  if (!parsedPeriod.success) {
    return NextResponse.json({ error: 'Invalid analytics period' }, { status: 400 });
  }

  const result = await getAutoRoutingClassifierAnalytics(parsedPeriod.data);
  return NextResponse.json(result.body, { status: result.status });
}
