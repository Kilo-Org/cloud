import { z } from 'zod';
import { GatewayOwnerScope, GatewayRouteScope } from './types';

const routeKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{32,}$/, 'route_key must be URL-safe and high entropy');
const configIdSchema = z.string().uuid();
const userIdSchema = z.string().min(1);
const orgIdSchema = z.string().uuid();

export const UserConnectRouteParamsSchema = z.object({
  userId: userIdSchema,
  configId: configIdSchema,
  routeKey: routeKeySchema,
});

export const OrgConnectRouteParamsSchema = z.object({
  orgId: orgIdSchema,
  configId: configIdSchema,
  routeKey: routeKeySchema,
});

export type UserConnectRouteParams = z.infer<typeof UserConnectRouteParamsSchema>;
export type OrgConnectRouteParams = z.infer<typeof OrgConnectRouteParamsSchema>;

export type ScopedConnectRoute = {
  routeScope: GatewayRouteScope;
  ownerScope: GatewayOwnerScope;
  ownerId: string;
  configId: string;
  routeKey: string;
  rootPath: string;
  descendantPath: string | null;
};

export function ownerScopeFromRouteScope(routeScope: GatewayRouteScope): GatewayOwnerScope {
  if (routeScope === GatewayRouteScope.User) return GatewayOwnerScope.Personal;
  return GatewayOwnerScope.Organization;
}

export function buildScopedConnectRootPath(params: {
  ownerScope: GatewayOwnerScope;
  ownerId: string;
  configId: string;
  routeKey: string;
}): string {
  if (params.ownerScope === GatewayOwnerScope.Personal) {
    return `/mcp-connect/user/${params.ownerId}/${params.configId}/${params.routeKey}`;
  }

  return `/mcp-connect/org/${params.ownerId}/${params.configId}/${params.routeKey}`;
}

export function buildScopedConnectCanonicalUrl(
  baseUrl: string,
  route: {
    ownerScope: GatewayOwnerScope;
    ownerId: string;
    configId: string;
    routeKey: string;
  }
): string {
  const base = new URL(baseUrl);
  base.pathname = buildScopedConnectRootPath(route);
  base.search = '';
  base.hash = '';
  return base.toString();
}

export function buildMCPID(route: {
  ownerScope: GatewayOwnerScope;
  ownerId: string;
  configId: string;
  routeKey: string;
}): string {
  return `${route.ownerScope}:${route.ownerId}:${route.configId}:${route.routeKey}`;
}

export function parseScopedConnectPath(pathname: string): ScopedConnectRoute | null {
  const segments = pathname.split('/').filter(segment => segment.length > 0);
  if (segments.length < 5 || segments[0] !== 'mcp-connect') return null;

  const [_, scope, ownerId, configId, routeKey, ...descendant] = segments;
  if (scope === GatewayRouteScope.User) {
    const parsed = UserConnectRouteParamsSchema.safeParse({ userId: ownerId, configId, routeKey });
    if (!parsed.success) return null;
    const rootPath = buildScopedConnectRootPath({
      ownerScope: GatewayOwnerScope.Personal,
      ownerId: parsed.data.userId,
      configId: parsed.data.configId,
      routeKey: parsed.data.routeKey,
    });
    return {
      routeScope: GatewayRouteScope.User,
      ownerScope: GatewayOwnerScope.Personal,
      ownerId: parsed.data.userId,
      configId: parsed.data.configId,
      routeKey: parsed.data.routeKey,
      rootPath,
      descendantPath: descendant.length > 0 ? `/${descendant.join('/')}` : null,
    };
  }

  if (scope === GatewayRouteScope.Org) {
    const parsed = OrgConnectRouteParamsSchema.safeParse({ orgId: ownerId, configId, routeKey });
    if (!parsed.success) return null;
    const rootPath = buildScopedConnectRootPath({
      ownerScope: GatewayOwnerScope.Organization,
      ownerId: parsed.data.orgId,
      configId: parsed.data.configId,
      routeKey: parsed.data.routeKey,
    });
    return {
      routeScope: GatewayRouteScope.Org,
      ownerScope: GatewayOwnerScope.Organization,
      ownerId: parsed.data.orgId,
      configId: parsed.data.configId,
      routeKey: parsed.data.routeKey,
      rootPath,
      descendantPath: descendant.length > 0 ? `/${descendant.join('/')}` : null,
    };
  }

  return null;
}
