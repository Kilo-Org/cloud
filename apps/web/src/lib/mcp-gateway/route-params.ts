import 'server-only';
import {
  GatewayRouteScope,
  OrgConnectRouteParamsSchema,
  UserConnectRouteParamsSchema,
  type ScopedConnectRoute,
  buildScopedConnectRootPath,
} from '@kilocode/mcp-gateway';
import { createGatewayError, GatewayErrorCode } from '@kilocode/mcp-gateway';

export function parseScopedRouteParams(params: {
  scope: string;
  ownerId: string;
  configId: string;
  routeKey: string;
}): ScopedConnectRoute {
  if (params.scope === GatewayRouteScope.User) {
    const parsed = UserConnectRouteParamsSchema.safeParse({
      userId: params.ownerId,
      configId: params.configId,
      routeKey: params.routeKey,
    });
    if (!parsed.success) {
      throw createGatewayError(GatewayErrorCode.InvalidRequest, 'Invalid user route', 400);
    }
    const rootPath = buildScopedConnectRootPath({
      ownerScope: 'personal',
      ownerId: parsed.data.userId,
      configId: parsed.data.configId,
      routeKey: parsed.data.routeKey,
    });
    return {
      routeScope: GatewayRouteScope.User,
      ownerScope: 'personal',
      ownerId: parsed.data.userId,
      configId: parsed.data.configId,
      routeKey: parsed.data.routeKey,
      rootPath,
      descendantPath: null,
    };
  }
  if (params.scope === GatewayRouteScope.Org) {
    const parsed = OrgConnectRouteParamsSchema.safeParse({
      orgId: params.ownerId,
      configId: params.configId,
      routeKey: params.routeKey,
    });
    if (!parsed.success) {
      throw createGatewayError(GatewayErrorCode.InvalidRequest, 'Invalid org route', 400);
    }
    const rootPath = buildScopedConnectRootPath({
      ownerScope: 'organization',
      ownerId: parsed.data.orgId,
      configId: parsed.data.configId,
      routeKey: parsed.data.routeKey,
    });
    return {
      routeScope: GatewayRouteScope.Org,
      ownerScope: 'organization',
      ownerId: parsed.data.orgId,
      configId: parsed.data.configId,
      routeKey: parsed.data.routeKey,
      rootPath,
      descendantPath: null,
    };
  }
  throw createGatewayError(GatewayErrorCode.InvalidRequest, 'Invalid route scope', 400);
}
