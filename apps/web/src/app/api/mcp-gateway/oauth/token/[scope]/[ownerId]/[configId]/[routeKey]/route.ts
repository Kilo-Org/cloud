import 'server-only';
import type { NextRequest } from 'next/server';
import { exchangeToken } from '../../../../route';
import { gatewayErrorResponse } from '@/lib/mcp-gateway/http';
import { parseScopedRouteParams } from '@/lib/mcp-gateway/route-params';

export async function POST(
  request: NextRequest,
  {
    params,
  }: { params: Promise<{ scope: string; ownerId: string; configId: string; routeKey: string }> }
) {
  try {
    return await exchangeToken(request, parseScopedRouteParams(await params));
  } catch (error) {
    return gatewayErrorResponse(error);
  }
}
