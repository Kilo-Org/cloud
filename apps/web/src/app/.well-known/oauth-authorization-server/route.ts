import 'server-only';
import { NextResponse } from 'next/server';
import { GatewaySupportedScopes } from '@kilocode/mcp-gateway';
import { APP_URL } from '@/lib/constants';

function authorizationServerMetadata() {
  const appBaseUrl = process.env.MCP_GATEWAY_APP_BASE_URL || APP_URL;
  return {
    issuer: appBaseUrl,
    authorization_endpoint: new URL('/api/mcp-gateway/oauth/authorize', appBaseUrl).toString(),
    token_endpoint: new URL('/api/mcp-gateway/oauth/token', appBaseUrl).toString(),
    registration_endpoint: new URL('/api/mcp-gateway/oauth/register', appBaseUrl).toString(),
    jwks_uri: new URL('/api/mcp-gateway/oauth/jwks.json', appBaseUrl).toString(),
    userinfo_endpoint: new URL('/api/mcp-gateway/oauth/userinfo', appBaseUrl).toString(),
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: GatewaySupportedScopes,
    resource_indicators_supported: true,
  };
}

export async function GET() {
  return NextResponse.json(authorizationServerMetadata(), {
    headers: { 'Cache-Control': 'no-store' },
  });
}
