import 'server-only';
import { NextResponse } from 'next/server';
import { createGatewayServices } from '@/lib/mcp-gateway/services';

function authorizationServerMetadata() {
  const { config } = createGatewayServices();
  return {
    issuer: config.appBaseUrl,
    authorization_endpoint: new URL(
      '/api/mcp-gateway/oauth/authorize',
      config.appBaseUrl
    ).toString(),
    token_endpoint: new URL('/api/mcp-gateway/oauth/token', config.appBaseUrl).toString(),
    registration_endpoint: new URL('/api/mcp-gateway/oauth/register', config.appBaseUrl).toString(),
    jwks_uri: new URL('/api/mcp-gateway/oauth/jwks.json', config.appBaseUrl).toString(),
    userinfo_endpoint: new URL('/api/mcp-gateway/oauth/userinfo', config.appBaseUrl).toString(),
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: ['profile'],
  };
}

export async function GET() {
  return NextResponse.json(authorizationServerMetadata());
}
