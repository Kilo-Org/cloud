import 'server-only';
import {
  buildMCPID,
  buildScopedConnectCanonicalUrl,
  parseScopedConnectPath,
  type ScopedConnectRoute,
} from '@kilocode/mcp-gateway';
import { createGatewayError, GatewayErrorCode } from '@kilocode/mcp-gateway';
import type { GatewayExecutionContext } from '@kilocode/mcp-gateway';
import type { GatewayRepository, ResolvedGatewayRoute } from './repository';

export function createRouteService(params: {
  repository: GatewayRepository;
  gatewayBaseUrl: string;
}) {
  function parseResource(resource: string): ScopedConnectRoute {
    let url: URL;
    try {
      url = new URL(resource);
    } catch {
      throw createGatewayError(GatewayErrorCode.InvalidRequest, 'Invalid resource URL', 400);
    }

    const expectedBase = new URL(params.gatewayBaseUrl);
    if (url.origin !== expectedBase.origin) {
      throw createGatewayError(GatewayErrorCode.InvalidRequest, 'Invalid resource origin', 400);
    }
    if (url.search || url.hash) {
      throw createGatewayError(
        GatewayErrorCode.InvalidRequest,
        'Resource must not include query or fragment',
        400
      );
    }

    const route = parseScopedConnectPath(url.pathname);
    if (!route || route.descendantPath) {
      throw createGatewayError(
        GatewayErrorCode.InvalidRequest,
        'Invalid scoped connect resource',
        400
      );
    }
    return route;
  }

  async function resolveResource(
    resource: string
  ): Promise<{ route: ScopedConnectRoute; resolved: ResolvedGatewayRoute }> {
    const route = parseResource(resource);
    const resolved = await params.repository.findActiveRouteByRoute({
      ownerScope: route.ownerScope,
      ownerId: route.ownerId,
      configId: route.configId,
      routeKey: route.routeKey,
    });
    if (!resolved) {
      throw createGatewayError(GatewayErrorCode.NotFound, 'Connect resource not available', 404);
    }
    return { route, resolved };
  }

  async function resolveRouteParams(route: ScopedConnectRoute): Promise<ResolvedGatewayRoute> {
    const resolved = await params.repository.findActiveRouteByRoute({
      ownerScope: route.ownerScope,
      ownerId: route.ownerId,
      configId: route.configId,
      routeKey: route.routeKey,
    });
    if (!resolved) {
      throw createGatewayError(GatewayErrorCode.NotFound, 'Connect resource not available', 404);
    }
    return resolved;
  }

  function canonicalUrl(route: ScopedConnectRoute): string {
    return buildScopedConnectCanonicalUrl(params.gatewayBaseUrl, {
      ownerScope: route.ownerScope,
      ownerId: route.ownerId,
      configId: route.configId,
      routeKey: route.routeKey,
    });
  }

  function mcpId(route: ScopedConnectRoute): string {
    return buildMCPID({
      ownerScope: route.ownerScope,
      ownerId: route.ownerId,
      configId: route.configId,
      routeKey: route.routeKey,
    });
  }

  async function authorize(input: {
    resolved: ResolvedGatewayRoute;
    route: ScopedConnectRoute;
    userId: string;
    executionContext: GatewayExecutionContext;
  }) {
    const subject = await params.repository.authorizeUserForRoute({
      route: input.resolved,
      userId: input.userId,
      executionContext: input.executionContext,
    });
    if (!subject) {
      throw createGatewayError(
        GatewayErrorCode.AccessDenied,
        'User is not authorized for this resource',
        403
      );
    }
    return subject;
  }

  return {
    parseResource,
    resolveResource,
    resolveRouteParams,
    canonicalUrl,
    mcpId,
    authorize,
  };
}

export type GatewayRouteService = ReturnType<typeof createRouteService>;
