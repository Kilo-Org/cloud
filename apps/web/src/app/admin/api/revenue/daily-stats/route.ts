import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import type { RevenueKpiResponse } from '@/lib/revenueKpi';
import { getRevenueKpiData } from '@/lib/revenueKpi';
import { format, subDays } from 'date-fns';

export async function GET(
  request: NextRequest
): Promise<NextResponse<{ error: string } | RevenueKpiResponse>> {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) {
    return authFailedResponse;
  }

  const { searchParams } = new URL(request.url);
  const includeFirstTopupCategories = searchParams.get('includeFirstTopupCategories') === 'true';
  const startDateParam = searchParams.get('startDate');
  const endDateParam = searchParams.get('endDate');

  const now = new Date();
  const defaultEnd = subDays(now, 1); // end at yesterday by default to avoid partial today
  const defaultStart = subDays(defaultEnd, 6); // 7 days total

  const startDate = startDateParam ?? format(defaultStart, 'yyyy-MM-dd');
  const endDate = endDateParam ?? format(defaultEnd, 'yyyy-MM-dd');

  return NextResponse.json(
    await getRevenueKpiData(includeFirstTopupCategories, startDate, endDate)
  );
}
