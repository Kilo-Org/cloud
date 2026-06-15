import 'server-only';
import type { NextRequest } from 'next/server';
import { approveRequest, consentResponse, redirectOAuthError } from '../../../../route';
import { gatewayErrorResponse } from '@/lib/mcp-gateway/http';
import { parseScopedRouteParams } from '@/lib/mcp-gateway/route-params';
import { OAuthAuthorizationRedirectError } from '@/lib/mcp-gateway/authorization-service';

export async function GET(
  request: NextRequest,
  {
    params,
  }: { params: Promise<{ scope: string; ownerId: string; configId: string; routeKey: string }> }
) {
  try {
    return await consentResponse(request, parseScopedRouteParams(await params));
  } catch (error) {
    if (error instanceof OAuthAuthorizationRedirectError) {
      return redirectOAuthError(error);
    }
    return gatewayErrorResponse(error);
  }
}

export async function POST(
  request: NextRequest,
  {
    params,
  }: { params: Promise<{ scope: string; ownerId: string; configId: string; routeKey: string }> }
) {
  try {
    return await approveRequest(request, parseScopedRouteParams(await params));
  } catch (error) {
    if (error instanceof OAuthAuthorizationRedirectError) {
      return redirectOAuthError(error);
    }
    return gatewayErrorResponse(error);
  }
}
