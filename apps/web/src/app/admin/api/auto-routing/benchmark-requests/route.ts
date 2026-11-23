import {
  AutoRouterSchema,
  DEFAULT_AUTO_ROUTER,
  PaidBenchmarkAdminRequestStatusSchema,
} from '@kilocode/auto-routing-contracts';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import * as z from 'zod';
import { listPaidBenchmarkAdminRequests } from '@kilocode/web-shared/lib/ai-gateway/auto-routing-benchmark-admin-client';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { withAdminLabels } from './labels';

export async function GET(request: NextRequest) {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  const router = AutoRouterSchema.safeParse(
    request.nextUrl.searchParams.get('router') ?? DEFAULT_AUTO_ROUTER
  );
  if (!router.success) return NextResponse.json({ error: 'Invalid router' }, { status: 400 });
  const statuses = (request.nextUrl.searchParams.get('status') ?? '')
    .split(',')
    .map(value => value.trim())
    .filter(value => value.length > 0);
  const parsedStatuses = z.array(PaidBenchmarkAdminRequestStatusSchema).safeParse(statuses);
  if (!parsedStatuses.success) {
    return NextResponse.json({ error: 'Unknown paid request status' }, { status: 400 });
  }
  const cursor = request.nextUrl.searchParams.get('cursor') ?? undefined;
  const limitText = request.nextUrl.searchParams.get('limit');
  const limit = limitText === null ? undefined : Number(limitText);
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)) {
    return NextResponse.json({ error: 'Invalid limit' }, { status: 400 });
  }
  const result = await listPaidBenchmarkAdminRequests({
    router: router.data,
    statuses: parsedStatuses.data,
    cursor,
    limit,
  });
  if (result.status !== 200 || !('requests' in result.body)) {
    return NextResponse.json(result.body, { status: result.status });
  }
  const requests = await withAdminLabels(result.body.requests);
  return NextResponse.json({ requests, nextCursor: result.body.nextCursor });
}
