import type { Context } from 'hono';
import {
  buildScopedConnectCanonicalUrl,
  OrgConnectRouteParamsSchema,
  UserConnectRouteParamsSchema,
  type OrgConnectRouteParams,
  type UserConnectRouteParams,
} from '@kilocode/mcp-gateway';
import type { MCPGatewayEnv } from '../types';

function metadata(c: Context<MCPGatewayEnv>, resource: string) {
  return c.json({
    resource,
    authorization_servers: [c.env.APP_BASE_URL],
    scopes_supported: ['profile'],
  });
}

export function handleProtectedResourceMetadata(c: Context<MCPGatewayEnv>) {
  return metadata(c, new URL('/mcp-connect', c.env.MCP_GATEWAY_BASE_URL).toString());
}

export function handleUserProtectedResourceMetadata(
  c: Context<MCPGatewayEnv>,
  params: UserConnectRouteParams
) {
  const validatedParams = UserConnectRouteParamsSchema.parse(params);
  const resource = buildScopedConnectCanonicalUrl(c.env.MCP_GATEWAY_BASE_URL, {
    ownerScope: 'personal',
    ownerId: validatedParams.userId,
    configId: validatedParams.configId,
    routeKey: validatedParams.routeKey,
  });
  return metadata(c, resource);
}

export function handleOrgProtectedResourceMetadata(
  c: Context<MCPGatewayEnv>,
  params: OrgConnectRouteParams
) {
  const validatedParams = OrgConnectRouteParamsSchema.parse(params);
  const resource = buildScopedConnectCanonicalUrl(c.env.MCP_GATEWAY_BASE_URL, {
    ownerScope: 'organization',
    ownerId: validatedParams.orgId,
    configId: validatedParams.configId,
    routeKey: validatedParams.routeKey,
  });
  return metadata(c, resource);
}
