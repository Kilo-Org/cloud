import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { createGatewayServices } from '@/lib/mcp-gateway/services';
import { gatewayErrorResponse } from '@/lib/mcp-gateway/http';

export async function POST(request: NextRequest) {
  try {
    const services = createGatewayServices();
    const body: unknown = await request.json();
    const registration = await services.clientService.registerClient({
      metadata: body,
      headers: request.headers,
    });
    return NextResponse.json(
      {
        client_id: registration.clientId,
        client_secret: registration.clientSecret,
        registration_access_token: registration.registrationAccessToken,
        registration_access_token_expires_at: registration.registrationAccessTokenExpiresAt,
        registration_client_uri: new URL(
          `/api/mcp-gateway/oauth/register/${registration.clientId}`,
          services.config.appBaseUrl
        ).toString(),
      },
      { status: 201 }
    );
  } catch (error) {
    return gatewayErrorResponse(error);
  }
}
