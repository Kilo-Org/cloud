import 'server-only';
import {
  GatewayAuthMode,
  GatewayAuthorizationRequestStatus,
  GatewayInstanceStatus,
  GatewayOAuthClientAuthMethod,
  createGatewayError,
  GatewayErrorCode,
  GatewayError,
  filterSupportedScopes,
  parseScopeString,
  type OAuthAuthorizationQuery,
  type ScopedConnectRoute,
  type GatewayExecutionContext,
} from '@kilocode/mcp-gateway';
import {
  mcp_gateway_authorization_codes,
  mcp_gateway_authorization_requests,
} from '@kilocode/db/schema';
import { and, eq, gt, sql } from 'drizzle-orm';
import type { GatewayRepository, ResolvedGatewayRoute } from './repository';
import type { GatewayRouteService } from './route-service';
import type { GatewayOAuthClientService } from './oauth-client-service';
import type { GatewayProviderOAuthService } from './provider-oauth-service';
import { expiresAtIso, hashToken, randomToken } from './crypto';
import type { GatewayAppConfig } from './config';
import { createAuditService } from './audit-service';

type OAuthErrorCode = (typeof GatewayErrorCode)[keyof typeof GatewayErrorCode];

function createOAuthRedirectError(params: {
  code: OAuthErrorCode;
  message: string;
  redirectUri: string;
  state?: string;
}) {
  return new OAuthAuthorizationRedirectError(
    params.code,
    params.message,
    params.redirectUri,
    params.state
  );
}

export class OAuthAuthorizationRedirectError extends Error {
  readonly code: string;
  readonly redirectUri: string;
  readonly state?: string;

  constructor(code: string, message: string, redirectUri: string, state?: string) {
    super(message);
    this.name = 'OAuthAuthorizationRedirectError';
    this.code = code;
    this.redirectUri = redirectUri;
    this.state = state;
  }
}

export function createAuthorizationService(params: {
  repository: GatewayRepository;
  routeService: GatewayRouteService;
  clientService: GatewayOAuthClientService;
  providerOAuthService: GatewayProviderOAuthService;
  config: GatewayAppConfig;
}) {
  async function resolveAuthorizationRoute(input: {
    query: OAuthAuthorizationQuery;
    route?: ScopedConnectRoute;
  }): Promise<{ route: ScopedConnectRoute; resolved: ResolvedGatewayRoute }> {
    if (input.route) {
      const resolved = await params.routeService.resolveRouteParams(input.route);
      if (input.query.resource) {
        const resource = params.routeService.parseResource(input.query.resource);
        if (resource.rootPath !== input.route.rootPath) {
          throw createGatewayError(
            GatewayErrorCode.InvalidRequest,
            'Resource does not match route',
            400
          );
        }
      }
      return { route: input.route, resolved };
    }
    if (!input.query.resource) {
      throw createGatewayError(GatewayErrorCode.InvalidRequest, 'Resource is required', 400);
    }
    return await params.routeService.resolveResource(input.query.resource);
  }

  function grantedScopes(clientScopes: string[], requested: string | undefined): string[] {
    const requestedScopes = parseScopeString(requested);
    const supportedScopes = filterSupportedScopes(requestedScopes);
    if (supportedScopes.length !== requestedScopes.length) {
      throw createGatewayError(GatewayErrorCode.InvalidScope, 'Unsupported scope requested', 400);
    }
    if (supportedScopes.some(scope => !clientScopes.includes(scope))) {
      throw createGatewayError(
        GatewayErrorCode.InvalidScope,
        'Scope is not declared by client',
        400
      );
    }
    return supportedScopes;
  }

  async function createAuthorizationRequestWithInstance(paramsInput: {
    client: NonNullable<Awaited<ReturnType<GatewayOAuthClientService['findClientById']>>>;
    route: ScopedConnectRoute;
    resolved: ResolvedGatewayRoute;
    userId: string;
    redirectUri: string;
    scopes: string[];
    oauthState?: string;
    codeChallenge: string | null;
    executionContext: GatewayExecutionContext;
    instanceId: string;
  }) {
    const [request] = await params.repository.database
      .insert(mcp_gateway_authorization_requests)
      .values({
        request_state_hash: hashToken(randomToken(32)),
        oauth_client_id: paramsInput.client.oauth_client_id,
        client_id: paramsInput.client.client_id,
        owner_scope: paramsInput.resolved.config.owner_scope,
        owner_id: paramsInput.resolved.config.owner_id,
        config_id: paramsInput.resolved.config.config_id,
        route_key: paramsInput.resolved.route.route_key,
        canonical_resource_url: paramsInput.resolved.route.canonical_url,
        redirect_uri: paramsInput.redirectUri,
        requested_scopes: paramsInput.scopes,
        granted_scopes: paramsInput.scopes,
        oauth_state: paramsInput.oauthState ?? null,
        code_challenge: paramsInput.codeChallenge,
        code_challenge_method: 'S256',
        execution_context: paramsInput.executionContext,
        kilo_user_id: paramsInput.userId,
        instance_id: paramsInput.instanceId,
        request_status: GatewayAuthorizationRequestStatus.Pending,
        expires_at: expiresAtIso(params.config.authorizationRequestTtlSeconds),
      })
      .returning();
    return request;
  }

  async function finalizeAuthorizationRequest(
    request: typeof mcp_gateway_authorization_requests.$inferSelect
  ) {
    const code = randomToken(32);
    const codeHash = hashToken(code);
    const [updated] = await params.repository.database
      .update(mcp_gateway_authorization_requests)
      .set({
        request_status: GatewayAuthorizationRequestStatus.Completed,
        consumed_at: new Date().toISOString(),
      })
      .where(
        and(
          eq(
            mcp_gateway_authorization_requests.authorization_request_id,
            request.authorization_request_id
          ),
          eq(
            mcp_gateway_authorization_requests.request_status,
            GatewayAuthorizationRequestStatus.Pending
          ),
          gt(mcp_gateway_authorization_requests.expires_at, sql`NOW()`)
        )
      )
      .returning();
    if (!updated) {
      throw createGatewayError(
        GatewayErrorCode.InvalidGrant,
        'Authorization request is no longer available',
        400
      );
    }
    await params.repository.database.insert(mcp_gateway_authorization_codes).values({
      code_hash: codeHash,
      authorization_request_id: updated.authorization_request_id,
      oauth_client_id: updated.oauth_client_id,
      client_id: updated.client_id,
      owner_scope: updated.owner_scope,
      owner_id: updated.owner_id,
      config_id: updated.config_id,
      route_key: updated.route_key,
      canonical_resource_url: updated.canonical_resource_url,
      redirect_uri: updated.redirect_uri,
      granted_scopes: updated.granted_scopes,
      code_challenge: updated.code_challenge,
      code_challenge_method: updated.code_challenge_method,
      execution_context: updated.execution_context,
      kilo_user_id: updated.kilo_user_id,
      instance_id: updated.instance_id,
      expires_at: expiresAtIso(params.config.authorizationCodeTtlSeconds),
    });
    const redirect = new URL(updated.redirect_uri);
    redirect.searchParams.set('code', code);
    if (updated.oauth_state) {
      redirect.searchParams.set('state', updated.oauth_state);
    }
    return { code, redirectUrl: redirect.toString() };
  }

  function executionContextMatchesRoute(
    executionContext: GatewayExecutionContext,
    route: ScopedConnectRoute
  ): boolean {
    if (route.ownerScope === 'personal') return executionContext.type === 'personal';
    return (
      executionContext.type === 'organization' && executionContext.organizationId === route.ownerId
    );
  }

  async function prepareAuthorization(input: {
    query: OAuthAuthorizationQuery;
    route?: ScopedConnectRoute;
    userId: string;
    executionContext: GatewayExecutionContext;
    redirectErrors?: boolean;
  }) {
    const client = await params.clientService.findClientById(input.query.client_id);
    if (!client) {
      throw createGatewayError(GatewayErrorCode.InvalidClient, 'Unknown client', 400);
    }
    if (!client.redirect_uris.includes(input.query.redirect_uri)) {
      throw createGatewayError(
        GatewayErrorCode.InvalidRequest,
        'Redirect URI is not registered',
        400
      );
    }
    const redirectError = (code: OAuthErrorCode, message: string) => {
      if (input.redirectErrors) {
        throw createOAuthRedirectError({
          code,
          message,
          redirectUri: input.query.redirect_uri,
          state: input.query.state,
        });
      }
      throw createGatewayError(code, message, 400);
    };
    if (
      !client.response_types.includes('code') ||
      !client.grant_types.includes('authorization_code')
    ) {
      redirectError(GatewayErrorCode.UnauthorizedClient, 'Client cannot use authorization code');
    }
    if (client.token_endpoint_auth_method === GatewayOAuthClientAuthMethod.None) {
      if (!input.query.code_challenge || input.query.code_challenge_method !== 'S256') {
        redirectError(GatewayErrorCode.InvalidRequest, 'PKCE is required for public clients');
      }
    }
    let route: ScopedConnectRoute;
    let resolved: ResolvedGatewayRoute;
    try {
      const resolvedRoute = await resolveAuthorizationRoute({
        query: input.query,
        route: input.route,
      });
      route = resolvedRoute.route;
      resolved = resolvedRoute.resolved;
      if (!executionContextMatchesRoute(input.executionContext, route)) {
        redirectError(
          GatewayErrorCode.AccessDenied,
          'Execution context does not match resource owner'
        );
      }
      await params.routeService.authorize({
        resolved,
        route,
        userId: input.userId,
        executionContext: input.executionContext,
      });
    } catch (error) {
      if (input.redirectErrors && error instanceof Error) {
        redirectError(GatewayErrorCode.AccessDenied, error.message);
      }
      throw error;
    }
    let scopes: string[];
    try {
      scopes = grantedScopes(client.declared_scopes, input.query.scope);
    } catch (error) {
      if (input.redirectErrors && error instanceof Error) {
        redirectError(GatewayErrorCode.InvalidScope, error.message);
      }
      throw error;
    }
    return { client, route, resolved, scopes };
  }

  async function previewAuthorization(input: {
    query: OAuthAuthorizationQuery;
    route?: ScopedConnectRoute;
    userId: string;
    executionContext: GatewayExecutionContext;
    redirectErrors?: boolean;
  }) {
    const prepared = await prepareAuthorization(input);
    return {
      clientId: prepared.client.client_id,
      clientName: prepared.client.client_name,
      resource: prepared.resolved.route.canonical_url,
      scopes: prepared.scopes,
    };
  }

  async function authorize(input: {
    query: OAuthAuthorizationQuery;
    route?: ScopedConnectRoute;
    userId: string;
    executionContext: GatewayExecutionContext;
  }) {
    const { client, route, resolved, scopes } = await prepareAuthorization({
      ...input,
      redirectErrors: true,
    });
    try {
      const instance = await params.repository.ensureConnectionInstance({
        ownerScope: resolved.config.owner_scope,
        ownerId: resolved.config.owner_id,
        configId: resolved.config.config_id,
        userId: input.userId,
      });
      const request = await createAuthorizationRequestWithInstance({
        client,
        route,
        resolved,
        userId: input.userId,
        redirectUri: input.query.redirect_uri,
        scopes,
        oauthState: input.query.state,
        codeChallenge: input.query.code_challenge ?? null,
        executionContext: input.executionContext,
        instanceId: instance.instance_id,
      });
      if (
        resolved.config.auth_mode === GatewayAuthMode.OAuthDynamic ||
        resolved.config.auth_mode === GatewayAuthMode.OAuthStatic
      ) {
        const grant = await params.repository.findActiveGrant(instance.instance_id);
        if (!grant || instance.instance_status !== GatewayInstanceStatus.Active) {
          const provider = await params.providerOAuthService.initiateProviderAuthorization({
            authorizationRequest: request,
            resolved,
            instanceId: instance.instance_id,
            scopes,
          });
          await createAuditService(params.repository).record({
            actorUserId: input.userId,
            ownerScope: resolved.config.owner_scope,
            ownerId: resolved.config.owner_id,
            configId: resolved.config.config_id,
            connectResourceId: resolved.route.connect_resource_id,
            instanceId: instance.instance_id,
            eventType: 'authorization_pending_provider',
            outcome: 'success',
          });
          return {
            kind: 'provider_redirect' as const,
            authorizationUrl: provider.authorizationUrl,
          };
        }
      }
      const finalized = await finalizeAuthorizationRequest(request);
      await createAuditService(params.repository).record({
        actorUserId: input.userId,
        ownerScope: resolved.config.owner_scope,
        ownerId: resolved.config.owner_id,
        configId: resolved.config.config_id,
        connectResourceId: resolved.route.connect_resource_id,
        instanceId: instance.instance_id,
        eventType: 'authorization_completed',
        outcome: 'success',
      });
      return { kind: 'redirect' as const, redirectUrl: finalized.redirectUrl };
    } catch (error) {
      if (error instanceof OAuthAuthorizationRedirectError) throw error;
      if (error instanceof GatewayError) {
        throw createOAuthRedirectError({
          code: error.code,
          message: error.message,
          redirectUri: input.query.redirect_uri,
          state: input.query.state,
        });
      }
      throw error;
    }
  }

  async function completeProviderAuthorization(paramsInput: {
    authorizationRequest: typeof mcp_gateway_authorization_requests.$inferSelect;
  }) {
    return await finalizeAuthorizationRequest(paramsInput.authorizationRequest);
  }

  return {
    previewAuthorization,
    authorize,
    finalizeAuthorizationRequest,
    completeProviderAuthorization,
  };
}

export type GatewayAuthorizationService = ReturnType<typeof createAuthorizationService>;
