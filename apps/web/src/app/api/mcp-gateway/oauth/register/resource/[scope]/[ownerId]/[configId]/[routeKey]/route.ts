import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { createGatewayServices } from '@/lib/mcp-gateway/services';
import { gatewayErrorResponse } from '@/lib/mcp-gateway/http';
import { parseScopedRouteParams } from '@/lib/mcp-gateway/route-params';
import { serializeRegistrationResponse } from '@/lib/mcp-gateway/oauth-client-response';
import { readBoundedJsonBody } from '@/lib/mcp-gateway/oauth-request-params';

export async function POST(
  request: NextRequest,
  {
    params,
  }: { params: Promise<{ scope: string; ownerId: string; configId: string; routeKey: string }> }
) {
  try {
    const services = createGatewayServices();
    await services.clientService.consumeRegistrationRateLimit(request.headers);
    const route = parseScopedRouteParams(await params);
    await services.routeService.resolveRouteParams(route);
    const body = await readBoundedJsonBody(request);
    const registration = await services.clientService.registerClient({
      metadata: body,
      headers: request.headers,
      rateLimitConsumed: true,
    });
    return NextResponse.json(
      serializeRegistrationResponse(registration, services.config.appBaseUrl),
      {
        status: 201,
      }
    );
  } catch (error) {
    return gatewayErrorResponse(error);
  }
}
