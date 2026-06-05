import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { createGatewayServices } from '@/lib/mcp-gateway/services';
import { extractBearerToken, gatewayErrorResponse } from '@/lib/mcp-gateway/http';

export async function GET(request: NextRequest) {
  try {
    const token = extractBearerToken(request.headers);
    if (!token) return NextResponse.json({ error: 'invalid_token' }, { status: 401 });
    const services = createGatewayServices();
    return NextResponse.json(await services.tokenService.userInfo(token));
  } catch (error) {
    return gatewayErrorResponse(error);
  }
}
