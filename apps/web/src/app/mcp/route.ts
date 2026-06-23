import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  GatewayError,
  GatewayErrorCode,
  nativeMcpAuthorizationUrl,
  nativeMcpProtectedResourceMetadataUrl,
  nativeMcpResourceUrl,
} from '@kilocode/mcp-gateway';
import { extractBearerToken } from '@/lib/mcp-gateway/http';
import { createGatewayServices } from '@/lib/mcp-gateway/services';
import { createKiloDatasetMcpServer } from '@/lib/mcp/kilo-dataset-server';
import { APP_URL } from '@/lib/constants';

export const dynamic = 'force-dynamic';

function withNoStore(response: Response) {
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

function methodNotAllowed() {
  return NextResponse.json(
    { error: 'method_not_allowed' },
    { status: 405, headers: { Allow: 'POST', 'Cache-Control': 'no-store' } }
  );
}

function unauthorizedChallenge(appBaseUrl: string) {
  const authenticate = [
    `Bearer resource="${nativeMcpResourceUrl(appBaseUrl)}"`,
    `resource_metadata="${nativeMcpProtectedResourceMetadataUrl(appBaseUrl)}"`,
    'scope="mcp:access"',
    `authorization_uri="${nativeMcpAuthorizationUrl(appBaseUrl)}"`,
  ].join(', ');
  return NextResponse.json(
    { error: 'invalid_token' },
    {
      status: 401,
      headers: {
        'WWW-Authenticate': authenticate,
        'Cache-Control': 'no-store',
      },
    }
  );
}

function insufficientScopeChallenge(appBaseUrl: string) {
  const authenticate = [
    'Bearer error="insufficient_scope"',
    `resource="${nativeMcpResourceUrl(appBaseUrl)}"`,
    `resource_metadata="${nativeMcpProtectedResourceMetadataUrl(appBaseUrl)}"`,
    'scope="mcp:access"',
    `authorization_uri="${nativeMcpAuthorizationUrl(appBaseUrl)}"`,
  ].join(', ');
  return NextResponse.json(
    { error: 'insufficient_scope' },
    {
      status: 403,
      headers: {
        'WWW-Authenticate': authenticate,
        'Cache-Control': 'no-store',
      },
    }
  );
}

function forbidden() {
  return NextResponse.json(
    { error: 'forbidden' },
    { status: 403, headers: { 'Cache-Control': 'no-store' } }
  );
}

function originAllowed(request: NextRequest, appBaseUrl: string) {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  const allowedOrigins = new Set([
    new URL(request.url).origin,
    new URL(appBaseUrl).origin,
    new URL(nativeMcpResourceUrl(appBaseUrl)).origin,
  ]);
  return allowedOrigins.has(origin);
}

async function authenticateNativeMcpRequest(request: NextRequest) {
  const appBaseUrl = process.env.MCP_GATEWAY_APP_BASE_URL || APP_URL;
  if (!originAllowed(request, appBaseUrl)) {
    return {
      response: NextResponse.json(
        { error: 'forbidden' },
        { status: 403, headers: { 'Cache-Control': 'no-store' } }
      ),
    };
  }
  const token = extractBearerToken(request.headers);
  if (!token) return { response: unauthorizedChallenge(appBaseUrl) };
  const services = createGatewayServices();
  try {
    return await services.nativeMcpTokenVerifier.verify(token);
  } catch (error) {
    if (error instanceof GatewayError) {
      if (error.code === GatewayErrorCode.InvalidScope) {
        return { response: insufficientScopeChallenge(services.config.appBaseUrl) };
      }
      if (error.code === GatewayErrorCode.Forbidden) {
        return { response: forbidden() };
      }
    }
    return { response: unauthorizedChallenge(services.config.appBaseUrl) };
  }
}

export async function POST(request: NextRequest) {
  const authenticated = await authenticateNativeMcpRequest(request);
  if ('response' in authenticated) return authenticated.response;

  const server = createKiloDatasetMcpServer({ user: authenticated.user });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return withNoStore(await transport.handleRequest(request));
}

export async function GET(request: NextRequest) {
  const authenticated = await authenticateNativeMcpRequest(request);
  if ('response' in authenticated) return authenticated.response;
  return methodNotAllowed();
}

export function DELETE() {
  return methodNotAllowed();
}

export function OPTIONS() {
  return methodNotAllowed();
}
