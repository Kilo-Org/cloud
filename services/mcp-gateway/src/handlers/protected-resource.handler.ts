import type { Context } from 'hono';
import {
  buildScopedConnectCanonicalUrl,
  parseScopedConnectPath,
  OrgConnectRouteParamsSchema,
  UserConnectRouteParamsSchema,
  type OrgConnectRouteParams,
  type UserConnectRouteParams,
} from '@kilocode/mcp-gateway';
import type { MCPGatewayEnv } from '../types';
import { resolveActiveRoute } from '../db/runtime-repository';

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

export async function handleUserProtectedResourceMetadata(
  c: Context<MCPGatewayEnv>,
  params: UserConnectRouteParams
) {
  const validatedParams = UserConnectRouteParamsSchema.parse(params);
  const route = parseScopedConnectPath(
    `/mcp-connect/user/${validatedParams.userId}/${validatedParams.configId}/${validatedParams.routeKey}`
  );
  if (!route) return c.json({ error: 'not_found' }, 404);
  const activeRoute = await resolveActiveRoute({ env: c.env, route });
  if (!activeRoute) return c.json({ error: 'not_found' }, 404);
  const resource = buildScopedConnectCanonicalUrl(c.env.MCP_GATEWAY_BASE_URL, {
    ownerScope: 'personal',
    ownerId: validatedParams.userId,
    configId: validatedParams.configId,
    routeKey: validatedParams.routeKey,
  });
  return metadata(c, resource);
}

export async function handleOrgProtectedResourceMetadata(
  c: Context<MCPGatewayEnv>,
  params: OrgConnectRouteParams
) {
  const validatedParams = OrgConnectRouteParamsSchema.parse(params);
  const route = parseScopedConnectPath(
    `/mcp-connect/org/${validatedParams.orgId}/${validatedParams.configId}/${validatedParams.routeKey}`
  );
  if (!route) return c.json({ error: 'not_found' }, 404);
  const activeRoute = await resolveActiveRoute({ env: c.env, route });
  if (!activeRoute) return c.json({ error: 'not_found' }, 404);
  const resource = buildScopedConnectCanonicalUrl(c.env.MCP_GATEWAY_BASE_URL, {
    ownerScope: 'organization',
    ownerId: validatedParams.orgId,
    configId: validatedParams.configId,
    routeKey: validatedParams.routeKey,
  });
  return metadata(c, resource);
}
