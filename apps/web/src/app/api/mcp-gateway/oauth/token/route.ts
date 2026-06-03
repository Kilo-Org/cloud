import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { OAuthTokenRequestSchema } from '@kilocode/mcp-gateway';
import { createGatewayServices } from '@/lib/mcp-gateway/services';
import { gatewayErrorResponse } from '@/lib/mcp-gateway/http';
import type { ScopedConnectRoute } from '@kilocode/mcp-gateway';

async function exchangeToken(request: NextRequest, route?: ScopedConnectRoute) {
  const form = await request.formData();
  const raw = Object.fromEntries(form.entries());
  const parsed = OAuthTokenRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }
  const services = createGatewayServices();
  const result = await services.tokenService.exchangeToken({
    request: parsed.data,
    headers: request.headers,
    route,
  });
  return NextResponse.json(result);
}

export async function POST(request: NextRequest) {
  try {
    return await exchangeToken(request);
  } catch (error) {
    return gatewayErrorResponse(error);
  }
}

export { exchangeToken };
