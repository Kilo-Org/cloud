import 'server-only';
import {
  GatewayAuthMode,
  GatewayAuthorizationRequestStatus,
  GatewayInstanceStatus,
  GatewayExecutionContextSchema,
  GatewayOAuthClientAuthMethod,
  GatewayMcpAccessScope,
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
  mcp_gateway_oauth_grants,
} from '@kilocode/db/schema';
import { MCPGatewayOAuthGrantStatus } from '@kilocode/db/schema-types';
import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import type { GatewayRepository, ResolvedGatewayRoute } from './repository';
import type { GatewayRouteService } from './route-service';
import type { GatewayOAuthClientService } from './oauth-client-service';
import type { GatewayProviderOAuthService } from './provider-oauth-service';
import type { GatewayOAuthGrantService } from './oauth-grant-service';
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
  oauthGrantService: GatewayOAuthGrantService;
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
    if (!supportedScopes.includes(GatewayMcpAccessScope)) {
      throw createGatewayError(
        GatewayErrorCode.InvalidScope,
        `${GatewayMcpAccessScope} scope is required`,
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
    oauthGrantId?: string | null;
  }) {
    const [request] = await params.repository.database
      .insert(mcp_gateway_authorization_requests)
      .values({
        request_state_hash: hashToken(randomToken(32)),
        oauth_client_id: paramsInput.client.oauth_client_id,
        oauth_grant_id: paramsInput.oauthGrantId,
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
    request: typeof mcp_gateway_authorization_requests.$inferSelect,
    options: { allowPendingGrant?: boolean } = {}
  ) {
    if (!request.oauth_grant_id) {
      throw createGatewayError(GatewayErrorCode.InvalidGrant, 'OAuth grant is unavailable', 400);
    }
    const oauthGrantId = request.oauth_grant_id;
    const code = randomToken(32);
    const codeHash = hashToken(code);
    const updated = await params.repository.database.transaction(async tx => {
      const allowedStatuses = options.allowPendingGrant
        ? [MCPGatewayOAuthGrantStatus.Pending]
        : [MCPGatewayOAuthGrantStatus.Active];
      const [grant] = await tx
        .select()
        .from(mcp_gateway_oauth_grants)
        .where(
          and(
            eq(mcp_gateway_oauth_grants.oauth_grant_id, oauthGrantId),
            eq(mcp_gateway_oauth_grants.oauth_client_id, request.oauth_client_id),
            eq(mcp_gateway_oauth_grants.kilo_user_id, request.kilo_user_id),
            eq(mcp_gateway_oauth_grants.instance_id, request.instance_id),
            inArray(mcp_gateway_oauth_grants.grant_status, allowedStatuses),
            isNull(mcp_gateway_oauth_grants.revoked_at)
          )
        )
        .limit(1);
      if (!grant) return null;
      const [completedRequest] = await tx
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
            eq(mcp_gateway_authorization_requests.oauth_grant_id, oauthGrantId),
            eq(
              mcp_gateway_authorization_requests.request_status,
              GatewayAuthorizationRequestStatus.Pending
            ),
            gt(mcp_gateway_authorization_requests.expires_at, sql`NOW()`)
          )
        )
        .returning();
      if (!completedRequest) return null;
      if (grant.grant_status === MCPGatewayOAuthGrantStatus.Pending) {
        const [activated] = await tx
          .update(mcp_gateway_oauth_grants)
          .set({
            grant_status: MCPGatewayOAuthGrantStatus.Active,
            approved_at: new Date().toISOString(),
          })
          .where(
            and(
              eq(mcp_gateway_oauth_grants.oauth_grant_id, grant.oauth_grant_id),
              eq(mcp_gateway_oauth_grants.grant_status, MCPGatewayOAuthGrantStatus.Pending),
              isNull(mcp_gateway_oauth_grants.revoked_at)
            )
          )
          .returning();
        if (!activated) return null;
      }
      await tx.insert(mcp_gateway_authorization_codes).values({
        code_hash: codeHash,
        authorization_request_id: completedRequest.authorization_request_id,
        oauth_client_id: completedRequest.oauth_client_id,
        oauth_grant_id: completedRequest.oauth_grant_id,
        client_id: completedRequest.client_id,
        owner_scope: completedRequest.owner_scope,
        owner_id: completedRequest.owner_id,
        config_id: completedRequest.config_id,
        route_key: completedRequest.route_key,
        canonical_resource_url: completedRequest.canonical_resource_url,
        redirect_uri: completedRequest.redirect_uri,
        granted_scopes: completedRequest.granted_scopes,
        code_challenge: completedRequest.code_challenge,
        code_challenge_method: completedRequest.code_challenge_method,
        execution_context: completedRequest.execution_context,
        kilo_user_id: completedRequest.kilo_user_id,
        instance_id: completedRequest.instance_id,
        expires_at: expiresAtIso(params.config.authorizationCodeTtlSeconds),
      });
      return completedRequest;
    });
    if (!updated) {
      throw createGatewayError(
        GatewayErrorCode.InvalidGrant,
        'Authorization request is no longer available',
        400
      );
    }
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
    allowBrowserOrgResourceContext?: boolean;
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
    if (!client.declared_scopes.includes(GatewayMcpAccessScope)) {
      redirectError(
        GatewayErrorCode.UnauthorizedClient,
        `Client must register the ${GatewayMcpAccessScope} scope`
      );
    }
    let route: ScopedConnectRoute;
    let resolved: ResolvedGatewayRoute;
    let executionContext = input.executionContext;
    try {
      const resolvedRoute = await resolveAuthorizationRoute({
        query: input.query,
        route: input.route,
      });
      route = resolvedRoute.route;
      resolved = resolvedRoute.resolved;
      if (
        input.allowBrowserOrgResourceContext &&
        executionContext.type === 'personal' &&
        route.ownerScope === 'organization'
      ) {
        executionContext = { type: 'organization', organizationId: route.ownerId };
      }
      if (!executionContextMatchesRoute(executionContext, route)) {
        redirectError(
          GatewayErrorCode.AccessDenied,
          'Execution context does not match resource owner'
        );
      }
      await params.routeService.authorize({
        resolved,
        route,
        userId: input.userId,
        executionContext,
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
    return { client, route, resolved, scopes, executionContext };
  }

  async function previewAuthorization(input: {
    query: OAuthAuthorizationQuery;
    route?: ScopedConnectRoute;
    userId: string;
    executionContext: GatewayExecutionContext;
    allowBrowserOrgResourceContext?: boolean;
    redirectErrors?: boolean;
  }) {
    const prepared = await prepareAuthorization(input);
    const organization =
      prepared.resolved.config.owner_scope === 'organization'
        ? await params.repository.findOrganization(prepared.resolved.config.owner_id)
        : null;
    return {
      clientId: prepared.client.client_id,
      clientName: prepared.client.client_name,
      redirectUri: input.query.redirect_uri,
      resource: prepared.resolved.route.canonical_url,
      configId: prepared.resolved.config.config_id,
      connectResourceId: prepared.resolved.route.connect_resource_id,
      connectionName: prepared.resolved.config.name,
      endpointHost: new URL(prepared.resolved.config.remote_url).host,
      ownerScope: prepared.resolved.config.owner_scope,
      ownerId: prepared.resolved.config.owner_id,
      contextName:
        prepared.resolved.config.owner_scope === 'organization'
          ? (organization?.name ?? 'Organization')
          : 'Personal',
      scopes: prepared.scopes,
      executionContext: prepared.executionContext,
    };
  }

  async function authorize(input: {
    query: OAuthAuthorizationQuery;
    route?: ScopedConnectRoute;
    userId: string;
    executionContext: GatewayExecutionContext;
    allowBrowserOrgResourceContext?: boolean;
  }) {
    const { client, route, resolved, scopes, executionContext } = await prepareAuthorization({
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
      const requiresProvider =
        resolved.config.auth_mode === GatewayAuthMode.OAuthDynamic ||
        resolved.config.auth_mode === GatewayAuthMode.OAuthStatic;
      const providerGrant = requiresProvider
        ? await params.repository.findActiveGrant(instance.instance_id)
        : null;
      const needsProviderAuthorization =
        requiresProvider &&
        (!providerGrant || instance.instance_status !== GatewayInstanceStatus.Active);
      const oauthGrant = await params.oauthGrantService.createOrReuseGrant({
        oauthClientId: client.oauth_client_id,
        kiloUserId: input.userId,
        ownerScope: resolved.config.owner_scope,
        ownerId: resolved.config.owner_id,
        configId: resolved.config.config_id,
        connectResourceId: resolved.route.connect_resource_id,
        instanceId: instance.instance_id,
        redirectUri: input.query.redirect_uri,
        grantedScopes: scopes,
        executionContext,
        grantStatus: needsProviderAuthorization
          ? MCPGatewayOAuthGrantStatus.Pending
          : MCPGatewayOAuthGrantStatus.Active,
        configVersion: resolved.config.config_version,
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
        executionContext,
        instanceId: instance.instance_id,
        oauthGrantId: oauthGrant.oauth_grant_id,
      });
      if (needsProviderAuthorization) {
        const provider = await params.providerOAuthService.initiateProviderAuthorization({
          authorizationRequest: request,
          resolved,
          instanceId: instance.instance_id,
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
      await createAuditService(params.repository).record({
        actorUserId: input.userId,
        ownerScope: resolved.config.owner_scope,
        ownerId: resolved.config.owner_id,
        configId: resolved.config.config_id,
        connectResourceId: resolved.route.connect_resource_id,
        instanceId: instance.instance_id,
        oauthGrantId: oauthGrant.oauth_grant_id,
        eventType: 'oauth_grant_approved',
        outcome: 'success',
      });
      const finalized = await finalizeAuthorizationRequest(request);
      await createAuditService(params.repository).record({
        actorUserId: input.userId,
        ownerScope: resolved.config.owner_scope,
        ownerId: resolved.config.owner_id,
        configId: resolved.config.config_id,
        connectResourceId: resolved.route.connect_resource_id,
        instanceId: instance.instance_id,
        oauthGrantId: oauthGrant.oauth_grant_id,
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
    const { resolved } = await params.routeService.resolveResource(
      paramsInput.authorizationRequest.canonical_resource_url
    );
    const executionContext = GatewayExecutionContextSchema.parse(
      paramsInput.authorizationRequest.execution_context
    );
    let oauthGrantId = paramsInput.authorizationRequest.oauth_grant_id;
    let boundRequest = paramsInput.authorizationRequest;
    if (!oauthGrantId) {
      const oauthGrant = await params.oauthGrantService.createOrReuseGrant({
        oauthClientId: paramsInput.authorizationRequest.oauth_client_id,
        kiloUserId: paramsInput.authorizationRequest.kilo_user_id,
        ownerScope: resolved.config.owner_scope,
        ownerId: resolved.config.owner_id,
        configId: resolved.config.config_id,
        connectResourceId: resolved.route.connect_resource_id,
        instanceId: paramsInput.authorizationRequest.instance_id,
        redirectUri: paramsInput.authorizationRequest.redirect_uri,
        grantedScopes: paramsInput.authorizationRequest.granted_scopes,
        executionContext,
        grantStatus: MCPGatewayOAuthGrantStatus.Pending,
        configVersion: resolved.config.config_version,
      });
      oauthGrantId = oauthGrant.oauth_grant_id;
      const [updatedRequest] = await params.repository.database
        .update(mcp_gateway_authorization_requests)
        .set({ oauth_grant_id: oauthGrant.oauth_grant_id })
        .where(
          and(
            eq(
              mcp_gateway_authorization_requests.authorization_request_id,
              paramsInput.authorizationRequest.authorization_request_id
            ),
            eq(
              mcp_gateway_authorization_requests.request_status,
              GatewayAuthorizationRequestStatus.Pending
            ),
            gt(mcp_gateway_authorization_requests.expires_at, sql`NOW()`)
          )
        )
        .returning();
      if (!updatedRequest) {
        await params.oauthGrantService.revokeGrantIds(
          [oauthGrant.oauth_grant_id],
          'authorization_request_unavailable'
        );
        throw createGatewayError(
          GatewayErrorCode.InvalidGrant,
          'Authorization request is unavailable',
          400
        );
      }
      boundRequest = updatedRequest;
    }
    if (!oauthGrantId) {
      throw createGatewayError(GatewayErrorCode.InvalidGrant, 'OAuth grant is unavailable', 400);
    }
    await createAuditService(params.repository).record({
      actorUserId: boundRequest.kilo_user_id,
      ownerScope: boundRequest.owner_scope,
      ownerId: boundRequest.owner_id,
      configId: boundRequest.config_id,
      connectResourceId: resolved.route.connect_resource_id,
      instanceId: boundRequest.instance_id,
      oauthGrantId,
      eventType: 'oauth_grant_approved',
      outcome: 'success',
    });
    return await finalizeAuthorizationRequest(boundRequest, { allowPendingGrant: true });
  }

  return {
    previewAuthorization,
    authorize,
    finalizeAuthorizationRequest,
    completeProviderAuthorization,
  };
}

export type GatewayAuthorizationService = ReturnType<typeof createAuthorizationService>;
