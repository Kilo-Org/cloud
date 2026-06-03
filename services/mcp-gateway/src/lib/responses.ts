import type { Context } from 'hono';
import type { MCPGatewayEnv } from '../types';

export function challengeResponse(c: Context<MCPGatewayEnv>, resource: string) {
  const authorizationUrl = new URL(
    '/api/mcp-gateway/oauth/authorize',
    c.env.APP_BASE_URL
  ).toString();
  return c.json({ error: 'unauthorized', resource }, 401, {
    'WWW-Authenticate': `Bearer resource="${resource}", authorization_uri="${authorizationUrl}"`,
  });
}

export function forbiddenResponse(c: Context<MCPGatewayEnv>) {
  return c.json({ error: 'forbidden' }, 403);
}
