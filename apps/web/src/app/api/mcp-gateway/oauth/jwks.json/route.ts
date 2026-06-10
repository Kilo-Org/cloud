import 'server-only';
import { NextResponse } from 'next/server';
import { createGatewayServices } from '@/lib/mcp-gateway/services';
import { gatewayErrorResponse } from '@/lib/mcp-gateway/http';

export async function GET() {
  try {
    const services = createGatewayServices();
    return NextResponse.json(services.tokenService.publicJwks(services.config));
  } catch (error) {
    return gatewayErrorResponse(error);
  }
}
