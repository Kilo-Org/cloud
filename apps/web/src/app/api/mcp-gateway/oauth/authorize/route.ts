import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { OAuthAuthorizationQuerySchema } from '@kilocode/mcp-gateway';
import { getUserFromAuth } from '@/lib/user/server';
import { createGatewayServices } from '@/lib/mcp-gateway/services';
import { gatewayErrorResponse } from '@/lib/mcp-gateway/http';
import type { ScopedConnectRoute } from '@kilocode/mcp-gateway';
import { executionContextFromAuth } from '@/lib/mcp-gateway/context';

async function authorizeRequest(request: NextRequest, route?: ScopedConnectRoute) {
  const { user, authFailedResponse, organizationId } = await getUserFromAuth({ adminOnly: false });
  if (authFailedResponse) return authFailedResponse;
  if (!user) return NextResponse.json({ error: 'access_denied' }, { status: 401 });

  const parsed = OAuthAuthorizationQuerySchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams.entries())
  );
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }
  const services = createGatewayServices();
  const result = await services.authorizationService.authorize({
    query: parsed.data,
    route,
    userId: user.id,
    executionContext: executionContextFromAuth(organizationId),
  });
  if (result.kind === 'provider_redirect') {
    return NextResponse.redirect(result.authorizationUrl);
  }
  return NextResponse.redirect(result.redirectUrl);
}

export async function GET(request: NextRequest) {
  try {
    return await authorizeRequest(request);
  } catch (error) {
    return gatewayErrorResponse(error);
  }
}

export { authorizeRequest };
