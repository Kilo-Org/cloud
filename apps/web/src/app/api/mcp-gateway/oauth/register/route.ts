import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { createGatewayServices } from '@/lib/mcp-gateway/services';
import { gatewayErrorResponse } from '@/lib/mcp-gateway/http';
import { serializeRegistrationResponse } from '@/lib/mcp-gateway/oauth-client-response';

export async function POST(request: NextRequest) {
  try {
    const services = createGatewayServices();
    const body: unknown = await request.json();
    const registration = await services.clientService.registerClient({
      metadata: body,
      headers: request.headers,
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
