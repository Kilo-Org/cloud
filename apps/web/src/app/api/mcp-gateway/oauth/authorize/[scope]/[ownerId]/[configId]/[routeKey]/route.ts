import 'server-only';
import type { NextRequest } from 'next/server';
import { authorizeRequest } from '../../../../route';
import { gatewayErrorResponse } from '@/lib/mcp-gateway/http';
import { parseScopedRouteParams } from '@/lib/mcp-gateway/route-params';

export async function GET(
  request: NextRequest,
  {
    params,
  }: { params: Promise<{ scope: string; ownerId: string; configId: string; routeKey: string }> }
) {
  try {
    return await authorizeRequest(request, parseScopedRouteParams(await params));
  } catch (error) {
    return gatewayErrorResponse(error);
  }
}
