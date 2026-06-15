import { createGatewayError, GatewayErrorCode } from '@kilocode/mcp-gateway';
import type { MCPGatewayEnv } from '../types';

function configuredOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    throw createGatewayError(GatewayErrorCode.ServerError, 'Gateway origin is misconfigured', 500);
  }
}

export function validateIncomingOrigin(params: {
  request: Request;
  env: MCPGatewayEnv['Bindings'];
}) {
  const origin = params.request.headers.get('origin');
  if (!origin) return;
  if (origin === 'null') {
    throw createGatewayError(GatewayErrorCode.Forbidden, 'Null origin is not allowed', 403);
  }
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw createGatewayError(GatewayErrorCode.Forbidden, 'Invalid origin is not allowed', 403);
  }
  if (
    parsed.username ||
    parsed.password ||
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
  ) {
    throw createGatewayError(GatewayErrorCode.Forbidden, 'Invalid origin is not allowed', 403);
  }
  const allowedOrigins = new Set([
    configuredOrigin(params.env.APP_BASE_URL),
    configuredOrigin(params.env.MCP_GATEWAY_BASE_URL),
    new URL(params.request.url).origin,
  ]);
  if (!allowedOrigins.has(parsed.origin)) {
    throw createGatewayError(GatewayErrorCode.Forbidden, 'Origin is not allowed', 403);
  }
}
