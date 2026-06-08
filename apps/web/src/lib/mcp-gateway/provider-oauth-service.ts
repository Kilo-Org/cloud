import 'server-only';
import {
  GatewayAuthMode,
  GatewayPendingProviderAuthorizationStatus,
  GatewaySecretKind,
  ProviderAuthorizationServerMetadataSchema,
  ProviderTokenResponseSchema,
  GatewayExecutionContextSchema,
  GatewayOwnerScope,
  createGatewayError,
  GatewayErrorCode,
} from '@kilocode/mcp-gateway';
import { decryptKeyedEnvelope, encryptKeyedEnvelope } from '@kilocode/encryption';
import {
  mcp_gateway_authorization_requests,
  mcp_gateway_config_secrets,
  mcp_gateway_pending_provider_authorizations,
} from '@kilocode/db/schema';
import type {
  mcp_gateway_connection_instances,
  mcp_gateway_provider_grants,
} from '@kilocode/db/schema';
import { and, eq, gt, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { GatewayExecutionContext, ScopedConnectRoute } from '@kilocode/mcp-gateway';
import type { GatewayAppConfig } from './config';
import type { GatewayRepository, ResolvedGatewayRoute } from './repository';
import type { GatewayRouteService } from './route-service';
import type { GatewayGrantService } from './grant-service';
import { configSecretAad, expiresAtIso, hashToken, pkceChallenge, randomToken } from './crypto';
import { validatePublicHttpsDestination } from './discovery-service';
import { createAuditService } from './audit-service';

const secretScheme = 'mcp-gateway-credential-rsa-aes-256-gcm';
const pendingStateScheme = 'mcp-gateway-provider-pending-state-rsa-aes-256-gcm';
const dynamicProviderClientName = 'Kilo MCP Gateway';

const ProviderCredentialSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1).optional(),
});

const ProviderRegistrationResponseSchema = z.object({
  client_id: z.string().min(1),
  client_secret: z.string().min(1).optional(),
});

const PendingProviderStateSchema = z.object({
  codeVerifier: z.string().min(43).max(128),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1).optional(),
  tokenEndpoint: z.string().url(),
  redirectUri: z.string().url(),
  providerScopes: z.array(z.string()).nullable().optional(),
  providerResource: z.string().url().optional(),
  scopes: z.array(z.string()).optional(),
});

const maxProviderResponseBytes = 128 * 1024;

type ProviderCredentials = {
  metadata: z.infer<typeof ProviderAuthorizationServerMetadataSchema>;
  clientId: string;
  clientSecret?: string;
};

type ResolvedProviderOAuthConfig = {
  authorizationEndpoint: URL;
  tokenEndpoint: URL;
  providerResource: URL | null;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  providerScopes: string[] | null;
};

type ProviderCallbackResult = {
  pending: typeof mcp_gateway_pending_provider_authorizations.$inferSelect;
  authorizationRequest: typeof mcp_gateway_authorization_requests.$inferSelect | null;
  grant: typeof mcp_gateway_provider_grants.$inferSelect;
  instance: typeof mcp_gateway_connection_instances.$inferSelect;
  resolved: ResolvedGatewayRoute;
  route: ScopedConnectRoute;
  completionUrl: string;
};

function pendingStateAad(pendingId: string): string {
  return `mcp-gateway:pending-provider:${pendingId}`;
}

async function readCappedJson(response: Response): Promise<unknown> {
  if (!response.body) {
    throw createGatewayError(GatewayErrorCode.InvalidGrant, 'Provider response is empty', 400);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let body = '';
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    totalBytes += chunk.value.byteLength;
    if (totalBytes > maxProviderResponseBytes) {
      throw createGatewayError(
        GatewayErrorCode.InvalidGrant,
        'Provider response is too large',
        400
      );
    }
    body += decoder.decode(chunk.value, { stream: true });
  }
  body += decoder.decode();
  try {
    return JSON.parse(body);
  } catch {
    throw createGatewayError(GatewayErrorCode.InvalidGrant, 'Provider response is malformed', 400);
  }
}

function requireBearerTokenType(
  tokenResponse: z.infer<typeof ProviderTokenResponseSchema>
): string {
  if (!tokenResponse.token_type || tokenResponse.token_type.toLowerCase() !== 'bearer') {
    throw createGatewayError(
      GatewayErrorCode.InvalidGrant,
      'Provider token type is not supported',
      400
    );
  }
  return tokenResponse.token_type;
}

export function createProviderOAuthService(params: {
  repository: GatewayRepository;
  routeService: GatewayRouteService;
  grantService: GatewayGrantService;
  config: GatewayAppConfig;
  fetchImpl?: typeof fetch;
}) {
  const fetchImpl = params.fetchImpl ?? fetch;

  function decryptSecret(encryptedSecret: string, configId: string, kind: string): unknown {
    const decrypted = decryptKeyedEnvelope(
      encryptedSecret,
      secretScheme,
      params.config.credentialKeyset,
      configSecretAad(configId, kind)
    );
    try {
      return JSON.parse(decrypted);
    } catch {
      throw createGatewayError(
        GatewayErrorCode.ServerError,
        'Stored provider secret is malformed',
        500
      );
    }
  }

  async function createDynamicProviderCredentials(paramsInput: {
    resolved: ResolvedGatewayRoute;
    metadata: z.infer<typeof ProviderAuthorizationServerMetadataSchema>;
  }) {
    if (!paramsInput.metadata.registration_endpoint) {
      throw createGatewayError(
        GatewayErrorCode.InvalidRequest,
        'Provider does not support dynamic registration',
        400
      );
    }
    const registrationEndpoint = await validatePublicHttpsDestination(
      paramsInput.metadata.registration_endpoint
    );
    const redirectUri = new URL(
      '/api/mcp-gateway/oauth/mcp/callback',
      params.config.appBaseUrl
    ).toString();
    const response = await fetchImpl(registrationEndpoint.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_name: dynamicProviderClientName,
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
      }),
      redirect: 'manual',
    });
    if (!response.ok) {
      throw createGatewayError(
        GatewayErrorCode.InvalidRequest,
        'Provider registration failed',
        400
      );
    }
    const registration = ProviderRegistrationResponseSchema.parse(await readCappedJson(response));
    const encryptedSecret = encryptKeyedEnvelope(
      JSON.stringify({
        kind: GatewaySecretKind.DynamicRegistration,
        value: { clientId: registration.client_id, clientSecret: registration.client_secret },
      }),
      secretScheme,
      params.config.credentialKeyset.active,
      configSecretAad(paramsInput.resolved.config.config_id, GatewaySecretKind.DynamicRegistration)
    );
    await params.repository.database
      .insert(mcp_gateway_config_secrets)
      .values({
        config_id: paramsInput.resolved.config.config_id,
        secret_kind: GatewaySecretKind.DynamicRegistration,
        encrypted_secret: encryptedSecret,
      })
      .onConflictDoNothing();
    return await params.repository.findActiveSecret(
      paramsInput.resolved.config.config_id,
      GatewaySecretKind.DynamicRegistration
    );
  }

  async function getProviderCredentials(resolved: ResolvedGatewayRoute) {
    if (
      resolved.config.auth_mode !== GatewayAuthMode.OAuthDynamic &&
      resolved.config.auth_mode !== GatewayAuthMode.OAuthStatic
    ) {
      return null;
    }
    const metadata = ProviderAuthorizationServerMetadataSchema.safeParse(
      resolved.config.discovered_provider_metadata
    );
    if (!metadata.success) {
      throw createGatewayError(
        GatewayErrorCode.ServerError,
        'Provider metadata is unavailable',
        500
      );
    }
    const secretKind =
      resolved.config.auth_mode === GatewayAuthMode.OAuthDynamic
        ? GatewaySecretKind.DynamicRegistration
        : GatewaySecretKind.StaticProviderCredentials;
    let secret = await params.repository.findActiveSecret(resolved.config.config_id, secretKind);
    if (!secret && secretKind === GatewaySecretKind.DynamicRegistration) {
      secret = await createDynamicProviderCredentials({ resolved, metadata: metadata.data });
    }
    if (!secret) {
      throw createGatewayError(
        GatewayErrorCode.AccessDenied,
        'Provider credentials are unavailable',
        403
      );
    }
    const raw = decryptSecret(secret.encrypted_secret, resolved.config.config_id, secretKind);
    const bundle = z
      .object({ kind: z.literal(secretKind), value: ProviderCredentialSchema })
      .safeParse(raw);
    if (!bundle.success) {
      throw createGatewayError(
        GatewayErrorCode.ServerError,
        'Provider credentials are malformed',
        500
      );
    }
    return { metadata: metadata.data, ...bundle.data.value } satisfies ProviderCredentials;
  }

  async function resolveProviderOAuthConfig(
    resolved: NonNullable<Awaited<ReturnType<GatewayRepository['findActiveRouteByRoute']>>>
  ): Promise<ResolvedProviderOAuthConfig> {
    const credentials = await getProviderCredentials(resolved);
    if (!credentials) {
      throw createGatewayError(
        GatewayErrorCode.InvalidRequest,
        'Config does not require provider OAuth',
        400
      );
    }
    const authorizationEndpoint = await validatePublicHttpsDestination(
      credentials.metadata.authorization_endpoint
    );
    const tokenEndpoint = await validatePublicHttpsDestination(credentials.metadata.token_endpoint);
    const providerScopes = resolved.config.provider_scopes;
    const providerResource = resolved.config.provider_resource
      ? await validatePublicHttpsDestination(resolved.config.provider_resource)
      : null;
    return {
      authorizationEndpoint,
      tokenEndpoint,
      providerResource,
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      redirectUri: new URL(
        '/api/mcp-gateway/oauth/mcp/callback',
        params.config.appBaseUrl
      ).toString(),
      providerScopes,
    };
  }

  async function createProviderAuthorizationAttempt(paramsInput: {
    authorizationRequest: typeof mcp_gateway_authorization_requests.$inferSelect | null;
    resolved: NonNullable<Awaited<ReturnType<GatewayRepository['findActiveRouteByRoute']>>>;
    instanceId: string;
    userId: string;
    executionContext: GatewayExecutionContext;
    oauthConfig: ResolvedProviderOAuthConfig;
  }) {
    const codeVerifier = randomToken(48);
    const state = randomToken(32);
    const encryptedState = encryptKeyedEnvelope(
      JSON.stringify({
        codeVerifier,
        clientId: paramsInput.oauthConfig.clientId,
        clientSecret: paramsInput.oauthConfig.clientSecret,
        tokenEndpoint: paramsInput.oauthConfig.tokenEndpoint.toString(),
        redirectUri: paramsInput.oauthConfig.redirectUri,
        providerScopes: paramsInput.oauthConfig.providerScopes,
        providerResource: paramsInput.oauthConfig.providerResource?.toString(),
      }),
      pendingStateScheme,
      params.config.credentialKeyset.active,
      pendingStateAad(state)
    );
    const [pending] = await params.repository.database
      .insert(mcp_gateway_pending_provider_authorizations)
      .values({
        state_hash: hashToken(state),
        authorization_request_id:
          paramsInput.authorizationRequest?.authorization_request_id ?? null,
        config_id: paramsInput.resolved.config.config_id,
        instance_id: paramsInput.instanceId,
        owner_scope: paramsInput.resolved.config.owner_scope,
        owner_id: paramsInput.resolved.config.owner_id,
        kilo_user_id: paramsInput.userId,
        route_key: paramsInput.resolved.route.route_key,
        canonical_resource_url: paramsInput.resolved.route.canonical_url,
        remote_url: paramsInput.resolved.config.remote_url,
        auth_mode: paramsInput.resolved.config.auth_mode,
        provider_authorization_endpoint: paramsInput.oauthConfig.authorizationEndpoint.toString(),
        provider_token_endpoint: paramsInput.oauthConfig.tokenEndpoint.toString(),
        encrypted_state: encryptedState,
        execution_context: paramsInput.executionContext,
        config_version: paramsInput.resolved.config.config_version,
        pending_status: GatewayPendingProviderAuthorizationStatus.Pending,
        expires_at: expiresAtIso(30 * 60),
      })
      .returning();
    const url = new URL(paramsInput.oauthConfig.authorizationEndpoint.toString());
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', paramsInput.oauthConfig.clientId);
    url.searchParams.set('redirect_uri', paramsInput.oauthConfig.redirectUri);
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', pkceChallenge(codeVerifier));
    url.searchParams.set('code_challenge_method', 'S256');
    if (paramsInput.oauthConfig.providerScopes?.length) {
      url.searchParams.set('scope', paramsInput.oauthConfig.providerScopes.join(' '));
    }
    if (paramsInput.oauthConfig.providerResource) {
      url.searchParams.set('resource', paramsInput.oauthConfig.providerResource.toString());
    }
    return { pending, authorizationUrl: url.toString() };
  }

  async function initiateProviderAuthorization(paramsInput: {
    authorizationRequest: typeof mcp_gateway_authorization_requests.$inferSelect;
    resolved: NonNullable<Awaited<ReturnType<GatewayRepository['findActiveRouteByRoute']>>>;
    instanceId: string;
  }) {
    const oauthConfig = await resolveProviderOAuthConfig(paramsInput.resolved);
    return await createProviderAuthorizationAttempt({
      authorizationRequest: paramsInput.authorizationRequest,
      resolved: paramsInput.resolved,
      instanceId: paramsInput.instanceId,
      userId: paramsInput.authorizationRequest.kilo_user_id,
      executionContext: GatewayExecutionContextSchema.parse(
        paramsInput.authorizationRequest.execution_context
      ),
      oauthConfig,
    });
  }

  async function startDashboardProviderSignIn(paramsInput: {
    resolved: ResolvedGatewayRoute;
    route: ScopedConnectRoute;
    userId: string;
    executionContext: GatewayExecutionContext;
  }) {
    await params.routeService.authorize({
      resolved: paramsInput.resolved,
      route: paramsInput.route,
      userId: paramsInput.userId,
      executionContext: paramsInput.executionContext,
    });
    const instance = await params.repository.ensureConnectionInstance({
      ownerScope: paramsInput.resolved.config.owner_scope,
      ownerId: paramsInput.resolved.config.owner_id,
      configId: paramsInput.resolved.config.config_id,
      userId: paramsInput.userId,
    });
    const oauthConfig = await resolveProviderOAuthConfig(paramsInput.resolved);
    const attempt = await createProviderAuthorizationAttempt({
      authorizationRequest: null,
      resolved: paramsInput.resolved,
      instanceId: instance.instance_id,
      userId: paramsInput.userId,
      executionContext: paramsInput.executionContext,
      oauthConfig,
    });
    return { authorizationUrl: attempt.authorizationUrl };
  }

  async function consumeProviderError(paramsInput: { state: string; userId: string }) {
    const [pending] = await params.repository.database
      .update(mcp_gateway_pending_provider_authorizations)
      .set({
        pending_status: GatewayPendingProviderAuthorizationStatus.Error,
        consumed_at: new Date().toISOString(),
      })
      .where(
        and(
          eq(mcp_gateway_pending_provider_authorizations.state_hash, hashToken(paramsInput.state)),
          eq(
            mcp_gateway_pending_provider_authorizations.pending_status,
            GatewayPendingProviderAuthorizationStatus.Pending
          ),
          eq(mcp_gateway_pending_provider_authorizations.kilo_user_id, paramsInput.userId)
        )
      )
      .returning();
    if (pending) {
      const resolved = await params.repository.findActiveRouteByRoute({
        ownerScope: pending.owner_scope,
        ownerId: pending.owner_id,
        configId: pending.config_id,
        routeKey: pending.route_key,
      });
      if (resolved) {
        await createAuditService(params.repository).record({
          actorUserId: paramsInput.userId,
          ownerScope: resolved.config.owner_scope,
          ownerId: resolved.config.owner_id,
          configId: resolved.config.config_id,
          connectResourceId: resolved.route.connect_resource_id,
          instanceId: pending.instance_id,
          eventType: 'provider_authorization_failed',
          outcome: 'failure',
        });
      }
    }
    return pending ?? null;
  }

  async function handleProviderCallback(paramsInput: {
    state: string;
    code: string;
    userId: string;
  }): Promise<ProviderCallbackResult> {
    const [pending] = await params.repository.database
      .update(mcp_gateway_pending_provider_authorizations)
      .set({
        pending_status: GatewayPendingProviderAuthorizationStatus.Error,
        consumed_at: new Date().toISOString(),
      })
      .where(
        and(
          eq(mcp_gateway_pending_provider_authorizations.state_hash, hashToken(paramsInput.state)),
          eq(
            mcp_gateway_pending_provider_authorizations.pending_status,
            GatewayPendingProviderAuthorizationStatus.Pending
          ),
          eq(mcp_gateway_pending_provider_authorizations.kilo_user_id, paramsInput.userId),
          gt(mcp_gateway_pending_provider_authorizations.expires_at, sql`NOW()`)
        )
      )
      .returning();
    if (!pending) {
      throw createGatewayError(
        GatewayErrorCode.InvalidRequest,
        'Provider authorization state is invalid',
        400
      );
    }
    const resolved = await params.repository.findActiveRouteByRoute({
      ownerScope: pending.owner_scope,
      ownerId: pending.owner_id,
      configId: pending.config_id,
      routeKey: pending.route_key,
    });
    if (!resolved || resolved.config.config_version !== pending.config_version) {
      throw createGatewayError(
        GatewayErrorCode.AccessDenied,
        'Provider authorization is stale',
        403
      );
    }
    const route = params.routeService.parseResource(pending.canonical_resource_url);
    const executionContext = GatewayExecutionContextSchema.parse(pending.execution_context);
    await params.routeService.authorize({
      resolved,
      route,
      userId: paramsInput.userId,
      executionContext,
    });
    const instance = await params.repository.findNonTerminalInstance({
      ownerScope: resolved.config.owner_scope,
      ownerId: resolved.config.owner_id,
      configId: resolved.config.config_id,
      userId: paramsInput.userId,
    });
    if (!instance || instance.instance_id !== pending.instance_id) {
      throw createGatewayError(
        GatewayErrorCode.AccessDenied,
        'Provider authorization instance mismatch',
        403
      );
    }

    const decryptedState = decryptKeyedEnvelope(
      pending.encrypted_state,
      pendingStateScheme,
      params.config.credentialKeyset,
      pendingStateAad(paramsInput.state)
    );
    let rawState: unknown;
    try {
      rawState = JSON.parse(decryptedState);
    } catch {
      throw createGatewayError(
        GatewayErrorCode.ServerError,
        'Pending provider state is malformed',
        500
      );
    }
    const state = PendingProviderStateSchema.parse(rawState);
    const providerScopes = state.providerScopes ?? state.scopes ?? null;
    const authorizationRequest = pending.authorization_request_id
      ? await params.repository.database
          .select()
          .from(mcp_gateway_authorization_requests)
          .where(
            eq(
              mcp_gateway_authorization_requests.authorization_request_id,
              pending.authorization_request_id
            )
          )
          .limit(1)
          .then(rows => rows[0] ?? null)
      : null;
    if (pending.authorization_request_id && !authorizationRequest) {
      throw createGatewayError(
        GatewayErrorCode.InvalidRequest,
        'Authorization request is unavailable',
        400
      );
    }
    await validatePublicHttpsDestination(state.tokenEndpoint);
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: paramsInput.code,
      redirect_uri: state.redirectUri,
      client_id: state.clientId,
      code_verifier: state.codeVerifier,
    });
    if (state.clientSecret) {
      body.set('client_secret', state.clientSecret);
    }
    if (state.providerResource) {
      body.set('resource', state.providerResource);
    }
    const response = await fetchImpl(state.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
      redirect: 'manual',
    });
    if (!response.ok) {
      throw createGatewayError(
        GatewayErrorCode.InvalidGrant,
        'Provider token exchange failed',
        400
      );
    }
    const tokenResponse = ProviderTokenResponseSchema.parse(await readCappedJson(response));
    const tokenType = requireBearerTokenType(tokenResponse);
    const expiresAt = tokenResponse.expires_in
      ? new Date(Date.now() + tokenResponse.expires_in * 1000).toISOString()
      : null;
    const grant = await params.grantService.replaceGrant({
      instanceId: instance.instance_id,
      bundle: {
        accessToken: tokenResponse.access_token,
        refreshToken: tokenResponse.refresh_token,
        expiresAt,
        scope: tokenResponse.scope ?? providerScopes?.join(' '),
        tokenType,
      },
      providerSubject: null,
    });
    await params.repository.database
      .update(mcp_gateway_pending_provider_authorizations)
      .set({ pending_status: GatewayPendingProviderAuthorizationStatus.Completed })
      .where(
        eq(
          mcp_gateway_pending_provider_authorizations.pending_provider_authorization_id,
          pending.pending_provider_authorization_id
        )
      );

    await createAuditService(params.repository).record({
      actorUserId: paramsInput.userId,
      ownerScope: resolved.config.owner_scope,
      ownerId: resolved.config.owner_id,
      configId: resolved.config.config_id,
      connectResourceId: resolved.route.connect_resource_id,
      instanceId: instance.instance_id,
      eventType: 'provider_authorization_completed',
      outcome: 'success',
    });
    const completionUrl =
      resolved.config.owner_scope === GatewayOwnerScope.Organization
        ? new URL(
            `/organizations/${resolved.config.owner_id}/cloud/mcp-gateway/${resolved.config.config_id}`,
            params.config.appBaseUrl
          ).toString()
        : new URL(
            `/cloud/mcp-gateway/${resolved.config.config_id}`,
            params.config.appBaseUrl
          ).toString();
    return { pending, authorizationRequest, grant, instance, resolved, route, completionUrl };
  }

  return {
    getProviderCredentials,
    initiateProviderAuthorization,
    startDashboardProviderSignIn,
    consumeProviderError,
    handleProviderCallback,
  };
}

export type GatewayProviderOAuthService = ReturnType<typeof createProviderOAuthService>;
