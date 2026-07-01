import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { OAuthTokenRequestSchema, isNativeMcpResource } from '@kilocode/mcp-gateway';
import { createGatewayServices } from '@/lib/mcp-gateway/services';
import { gatewayErrorResponse } from '@/lib/mcp-gateway/http';
import type { ScopedConnectRoute } from '@kilocode/mcp-gateway';
import {
  hasDuplicateSingletonParams,
  readFormData,
  stringFormParams,
} from '@/lib/mcp-gateway/oauth-request-params';

const tokenResponseHeaders = {
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
};

export function withTokenResponseHeaders(response: NextResponse) {
  response.headers.set('Cache-Control', tokenResponseHeaders['Cache-Control']);
  response.headers.set('Pragma', tokenResponseHeaders.Pragma);
  return response;
}

const tokenSingletonParams = [
  'grant_type',
  'code',
  'refresh_token',
  'redirect_uri',
  'client_id',
  'client_secret',
  'code_verifier',
  'resource',
] as const;

async function exchangeToken(request: NextRequest, route?: ScopedConnectRoute) {
  const form = await readFormData(request);
  if (hasDuplicateSingletonParams(form, tokenSingletonParams)) {
    return withTokenResponseHeaders(
      NextResponse.json({ error: 'invalid_request' }, { status: 400 })
    );
  }
  const raw = stringFormParams(form, tokenSingletonParams);
  const parsed = OAuthTokenRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return withTokenResponseHeaders(
      NextResponse.json({ error: 'invalid_request' }, { status: 400 })
    );
  }
  const services = createGatewayServices();
  let nativeRefreshToken = false;
  if (
    parsed.data.grant_type === 'refresh_token' &&
    !parsed.data.resource &&
    parsed.data.refresh_token
  ) {
    nativeRefreshToken = await services.nativeMcpTokenService.hasRefreshToken(
      parsed.data.refresh_token
    );
  }
  if (isNativeMcpResource(parsed.data.resource, services.config.appBaseUrl) || nativeRefreshToken) {
    const result = await services.nativeMcpTokenService.exchangeToken({
      request: parsed.data,
      headers: request.headers,
    });
    return NextResponse.json(result);
  }
  const result = await services.tokenService.exchangeToken({
    request: parsed.data,
    headers: request.headers,
    route,
  });
  return withTokenResponseHeaders(NextResponse.json(result));
}

export async function POST(request: NextRequest) {
  try {
    return await exchangeToken(request);
  } catch (error) {
    return withTokenResponseHeaders(gatewayErrorResponse(error));
  }
}

export { exchangeToken };
