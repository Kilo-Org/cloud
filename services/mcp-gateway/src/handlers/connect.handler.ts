import type { Context } from 'hono';
import {
  buildMCPID,
  buildScopedConnectCanonicalUrl,
  parseScopedConnectPath,
  parseAuxiliaryHeaders,
  type ScopedConnectRoute,
  UserConnectRouteParamsSchema,
  OrgConnectRouteParamsSchema,
  type UserConnectRouteParams,
  type OrgConnectRouteParams,
} from '@kilocode/mcp-gateway';
import {
  GatewayAuthMode,
  GatewayError,
  GatewayErrorCode,
  createGatewayError,
} from '@kilocode/mcp-gateway';
import type { MCPGatewayEnv } from '../types';
import { verifyGatewayToken } from '../lib/jwt';
import {
  recordRuntimeAudit,
  resolveActiveRoute,
  resolveRuntimeState,
} from '../db/runtime-repository';
import { resolveProviderAuthorization } from '../lib/provider-refresh';
import { loadStaticHeaders } from '../lib/credentials';
import { proxyUpstream } from '../lib/upstream-proxy';
import { challengeResponse, forbiddenResponse } from '../lib/responses';
import { validateIncomingOrigin } from '../lib/origin';

function bearerToken(header: string | undefined): string | null {
  if (!header?.toLowerCase().startsWith('bearer ')) return null;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}

type RuntimePhase =
  | 'parse_route'
  | 'load_route'
  | 'load_jwt_keyset'
  | 'verify_token'
  | 'load_runtime_state'
  | 'load_static_headers'
  | 'load_provider_authorization'
  | 'parse_auxiliary_headers'
  | 'proxy_upstream';

function logRuntimeFailure(params: {
  c: Context<MCPGatewayEnv>;
  route: ScopedConnectRoute | null;
  phase: RuntimePhase;
  hasBearerToken: boolean;
  authMode?: GatewayAuthMode;
  error: unknown;
}) {
  const status = params.error instanceof GatewayError ? params.error.status : 500;
  if (status < 500) return;
  console.error(
    JSON.stringify({
      message: 'mcp-gateway runtime request failed',
      method: params.c.req.method,
      phase: params.phase,
      ownerScope: params.route?.ownerScope,
      configId: params.route?.configId,
      hasBearerToken: params.hasBearerToken,
      authMode: params.authMode,
      status,
      errorCode: params.error instanceof GatewayError ? params.error.code : 'unhandled_error',
      errorName: params.error instanceof Error ? params.error.name : 'non_error_throw',
      errorMessage: params.error instanceof Error ? params.error.message : 'Non-Error thrown',
    })
  );
}

function logUpstreamServerError(params: {
  c: Context<MCPGatewayEnv>;
  route: ScopedConnectRoute;
  authMode: GatewayAuthMode;
  remoteUrl: string;
  status: number;
}) {
  let remoteHost: string | undefined;
  try {
    remoteHost = new URL(params.remoteUrl).host;
  } catch {
    remoteHost = undefined;
  }
  console.warn(
    JSON.stringify({
      message: 'mcp-gateway upstream returned server error',
      method: params.c.req.method,
      ownerScope: params.route.ownerScope,
      configId: params.route.configId,
      authMode: params.authMode,
      remoteHost,
      status: params.status,
    })
  );
}

function requestRoute(c: Context<MCPGatewayEnv>): ScopedConnectRoute {
  const route = parseScopedConnectPath(c.req.path);
  if (!route) {
    throw createGatewayError(GatewayErrorCode.InvalidRequest, 'Invalid scoped route', 400);
  }
  return route;
}

async function handleConnect(
  c: Context<MCPGatewayEnv>,
  _params: UserConnectRouteParams | OrgConnectRouteParams
) {
  let phase: RuntimePhase = 'parse_route';
  let loggedRoute: ScopedConnectRoute | null = null;
  let hasBearerToken = false;
  let authMode: GatewayAuthMode | undefined;
  try {
    const route = requestRoute(c);
    loggedRoute = route;
    const canonicalUrl = buildScopedConnectCanonicalUrl(c.env.MCP_GATEWAY_BASE_URL, {
      ownerScope: route.ownerScope,
      ownerId: route.ownerId,
      configId: route.configId,
      routeKey: route.routeKey,
    });
    validateIncomingOrigin({ request: c.req.raw, env: c.env });
    phase = 'load_route';
    const activeRoute = await resolveActiveRoute({ env: c.env, route });
    if (!activeRoute) {
      return c.json({ error: 'not_found' }, 404);
    }
    const token = bearerToken(c.req.header('authorization'));
    hasBearerToken = Boolean(token);
    if (!token) {
      return challengeResponse(c, canonicalUrl);
    }
    phase = 'load_jwt_keyset';
    const publicKeysetJson = c.env.MCP_GATEWAY_JWT_PUBLIC_KEYSET_JSON;
    if (!publicKeysetJson) {
      logRuntimeFailure({
        c,
        route: loggedRoute,
        phase,
        hasBearerToken,
        error: createGatewayError(GatewayErrorCode.ServerError, 'JWT keyset is unavailable', 500),
      });
      return c.json({ error: 'server_error' }, 500);
    }
    phase = 'verify_token';
    let claims;
    try {
      claims = await verifyGatewayToken({
        token,
        jwksJson: publicKeysetJson,
        issuer: c.env.MCP_GATEWAY_JWT_ISSUER,
        expectedAudience: canonicalUrl,
      });
    } catch {
      return challengeResponse(c, canonicalUrl);
    }
    if (
      claims.sub.length === 0 ||
      claims.owner_scope !== route.ownerScope ||
      claims.owner_id !== route.ownerId ||
      claims.config_id !== route.configId ||
      claims.route_key !== route.routeKey ||
      (route.ownerScope === 'personal' && claims.execution_context.type !== 'personal') ||
      (route.ownerScope === 'organization' &&
        (claims.execution_context.type !== 'organization' ||
          claims.execution_context.organizationId !== route.ownerId)) ||
      claims.MCPID !==
        buildMCPID({
          ownerScope: route.ownerScope,
          ownerId: route.ownerId,
          configId: route.configId,
          routeKey: route.routeKey,
        })
    ) {
      return forbiddenResponse(c);
    }
    phase = 'load_runtime_state';
    let resolution = await resolveRuntimeState({ env: c.env, route, userId: claims.sub });
    if (!resolution) {
      return forbiddenResponse(c);
    }
    authMode = resolution.config.auth_mode;
    if (
      resolution.config.owner_scope !== route.ownerScope ||
      resolution.config.owner_id !== route.ownerId ||
      resolution.instance.instance_id !== claims.instance_id ||
      resolution.config.config_version !== claims.config_version ||
      resolution.route.route_key !== route.routeKey
    ) {
      return forbiddenResponse(c);
    }
    if (
      resolution.config.auth_mode !== GatewayAuthMode.None &&
      resolution.config.auth_mode !== GatewayAuthMode.StaticHeaders
    ) {
      if (resolution.instance.instance_status !== 'active') {
        return forbiddenResponse(c);
      }
    }

    let staticHeaders: Record<string, string> | undefined;
    if (resolution.config.auth_mode === GatewayAuthMode.StaticHeaders) {
      if (!resolution.staticSecret) return forbiddenResponse(c);
      phase = 'load_static_headers';
      staticHeaders = await loadStaticHeaders({
        env: c.env,
        configId: resolution.config.config_id,
        encryptedSecret: resolution.staticSecret.encrypted_secret,
      });
    }
    let providerAuthorization: string | undefined;
    if (
      resolution.config.auth_mode === GatewayAuthMode.OAuthDynamic ||
      resolution.config.auth_mode === GatewayAuthMode.OAuthStatic
    ) {
      phase = 'load_provider_authorization';
      const refreshed = await resolveProviderAuthorization({ env: c.env, resolution, route });
      if (!refreshed) return forbiddenResponse(c);
      providerAuthorization = refreshed.providerAuthorization;
      resolution = refreshed.resolution;
      if (
        resolution.config.owner_scope !== route.ownerScope ||
        resolution.config.owner_id !== route.ownerId ||
        resolution.instance.instance_id !== claims.instance_id ||
        resolution.config.config_version !== claims.config_version ||
        resolution.route.route_key !== route.routeKey
      ) {
        return forbiddenResponse(c);
      }
    }
    let auxiliaryHeaders: Record<string, string> | undefined;
    phase = 'parse_auxiliary_headers';
    try {
      auxiliaryHeaders = parseAuxiliaryHeaders(resolution.config.auxiliary_headers);
    } catch {
      return forbiddenResponse(c);
    }
    phase = 'proxy_upstream';
    const response = await proxyUpstream({
      env: c.env,
      request: c.req.raw,
      remoteUrl: resolution.config.remote_url,
      descendantPath: route.descendantPath,
      pathPassthrough: resolution.config.path_passthrough,
      staticHeaders,
      auxiliaryHeaders,
      providerAuthorization,
    });
    if (response.status >= 500) {
      logUpstreamServerError({
        c,
        route,
        authMode: resolution.config.auth_mode,
        remoteUrl: resolution.config.remote_url,
        status: response.status,
      });
    }
    c.executionCtx.waitUntil(
      recordRuntimeAudit({
        env: c.env,
        resolution,
        eventType: 'runtime_proxy',
        outcome: response.ok ? 'success' : 'failure',
        metadata: { status: response.status, method: c.req.method },
      }).catch(() => undefined)
    );
    return response;
  } catch (error) {
    logRuntimeFailure({
      c,
      route: loggedRoute,
      phase,
      hasBearerToken,
      authMode,
      error,
    });
    throw error;
  }
}

function gatewayHandlerError(c: Context<MCPGatewayEnv>, error: GatewayError) {
  if (error.code === GatewayErrorCode.Forbidden) return forbiddenResponse(c);
  return new Response(JSON.stringify({ error: error.code }), {
    status: error.status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function handleUserConnect(c: Context<MCPGatewayEnv>, params: UserConnectRouteParams) {
  try {
    const validatedParams = UserConnectRouteParamsSchema.parse(params);
    return await handleConnect(c, validatedParams);
  } catch (error) {
    if (error instanceof GatewayError) return gatewayHandlerError(c, error);
    return c.json({ error: 'server_error' }, 500);
  }
}

export async function handleOrgConnect(c: Context<MCPGatewayEnv>, params: OrgConnectRouteParams) {
  try {
    const validatedParams = OrgConnectRouteParamsSchema.parse(params);
    return await handleConnect(c, validatedParams);
  } catch (error) {
    if (error instanceof GatewayError) return gatewayHandlerError(c, error);
    return c.json({ error: 'server_error' }, 500);
  }
}
