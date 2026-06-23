import type { Context } from 'hono';
import { GatewayMcpAccessScope } from '@kilocode/mcp-gateway';
import type { MCPGatewayEnv } from '../types';

function authorizationChallenge(c: Context<MCPGatewayEnv>, resource: string) {
  const authorizationUrl = new URL(
    '/api/mcp-gateway/oauth/authorize',
    c.env.APP_BASE_URL
  ).toString();
  const resourcePath = new URL(resource).pathname;
  const resourceMetadataUrl = new URL(
    `/.well-known/oauth-protected-resource${resourcePath}`,
    c.env.MCP_GATEWAY_BASE_URL
  ).toString();
  return { authorizationUrl, resourceMetadataUrl };
}

export function challengeResponse(c: Context<MCPGatewayEnv>, resource: string) {
  const { authorizationUrl, resourceMetadataUrl } = authorizationChallenge(c, resource);
  return c.json({ error: 'unauthorized', resource }, 401, {
    'WWW-Authenticate': `Bearer resource="${resource}", resource_metadata="${resourceMetadataUrl}", scope="${GatewayMcpAccessScope}", authorization_uri="${authorizationUrl}"`,
  });
}

export function insufficientScopeResponse(c: Context<MCPGatewayEnv>, resource: string) {
  const { authorizationUrl, resourceMetadataUrl } = authorizationChallenge(c, resource);
  return c.json({ error: 'insufficient_scope', resource }, 403, {
    'WWW-Authenticate': `Bearer error="insufficient_scope", resource="${resource}", resource_metadata="${resourceMetadataUrl}", scope="${GatewayMcpAccessScope}", authorization_uri="${authorizationUrl}"`,
  });
}

export function forbiddenResponse(_c: Context<MCPGatewayEnv>) {
  return new Response(null, { status: 403 });
}
