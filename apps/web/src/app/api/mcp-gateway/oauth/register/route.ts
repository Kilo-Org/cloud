import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { createGatewayServices } from '@/lib/mcp-gateway/services';
import { gatewayErrorResponse } from '@/lib/mcp-gateway/http';
import { serializeRegistrationResponse } from '@/lib/mcp-gateway/oauth-client-response';
import { readBoundedJsonBody } from '@/lib/mcp-gateway/oauth-request-params';

export async function POST(request: NextRequest) {
  try {
    const services = createGatewayServices();
    await services.clientService.consumeRegistrationRateLimit(request.headers);
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
