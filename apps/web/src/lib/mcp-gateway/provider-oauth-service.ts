import 'server-only';
import {
  GatewayAuthMode,
  GatewayPendingProviderAuthorizationStatus,
  GatewaySecretKind,
  ProviderAuthorizationServerMetadataSchema,
  ProviderTokenResponseSchema,
  GatewayExecutionContextSchema,
  createGatewayError,
  GatewayErrorCode,
} from '@kilocode/mcp-gateway';
import { decryptKeyedEnvelope, encryptKeyedEnvelope } from '@kilocode/encryption';
import {
  mcp_gateway_authorization_requests,
  mcp_gateway_config_secrets,
  mcp_gateway_pending_provider_authorizations,
} from '@kilocode/db/schema';
import { and, eq, gt, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { GatewayAppConfig } from './config';
import type { GatewayRepository, ResolvedGatewayRoute } from './repository';
import type { GatewayRouteService } from './route-service';
import type { GatewayGrantService } from './grant-service';
import { configSecretAad, expiresAtIso, hashToken, pkceChallenge, randomToken } from './crypto';
import { validatePublicHttpsDestination } from './discovery-service';
import { createAuditService } from './audit-service';

const secretScheme = 'mcp-gateway-credential-rsa-aes-256-gcm';
const pendingStateScheme = 'mcp-gateway-provider-pending-state-rsa-aes-256-gcm';

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
  scopes: z.array(z.string()),
});

const maxProviderResponseBytes = 128 * 1024;

type ProviderCredentials = {
  metadata: z.infer<typeof ProviderAuthorizationServerMetadataSchema>;
  clientId: string;
  clientSecret?: string;
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

function requireBearerTokenType(tokenResponse: z.infer<typeof ProviderTokenResponseSchema>) {
  if (!tokenResponse.token_type || tokenResponse.token_type.toLowerCase() !== 'bearer') {
    throw createGatewayError(
      GatewayErrorCode.InvalidGrant,
      'Provider token type is not supported',
      400
    );
  }
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

  async function initiateProviderAuthorization(paramsInput: {
    authorizationRequest: typeof mcp_gateway_authorization_requests.$inferSelect;
    resolved: NonNullable<Awaited<ReturnType<GatewayRepository['findActiveRouteByRoute']>>>;
    instanceId: string;
    scopes: string[];
  }) {
    const credentials = await getProviderCredentials(paramsInput.resolved);
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
    const codeVerifier = randomToken(48);
    const state = randomToken(32);
    const redirectUri = new URL(
      '/api/mcp-gateway/oauth/mcp/callback',
      params.config.appBaseUrl
    ).toString();
    const encryptedState = encryptKeyedEnvelope(
      JSON.stringify({
        codeVerifier,
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        tokenEndpoint: tokenEndpoint.toString(),
        redirectUri,
        scopes: paramsInput.scopes,
      }),
      pendingStateScheme,
      params.config.credentialKeyset.active,
      pendingStateAad(state)
    );
    const [pending] = await params.repository.database
      .insert(mcp_gateway_pending_provider_authorizations)
      .values({
        state_hash: hashToken(state),
        authorization_request_id: paramsInput.authorizationRequest.authorization_request_id,
        config_id: paramsInput.resolved.config.config_id,
        instance_id: paramsInput.instanceId,
        owner_scope: paramsInput.resolved.config.owner_scope,
        owner_id: paramsInput.resolved.config.owner_id,
        kilo_user_id: paramsInput.authorizationRequest.kilo_user_id,
        route_key: paramsInput.resolved.route.route_key,
        canonical_resource_url: paramsInput.resolved.route.canonical_url,
        remote_url: paramsInput.resolved.config.remote_url,
        auth_mode: paramsInput.resolved.config.auth_mode,
        provider_authorization_endpoint: authorizationEndpoint.toString(),
        provider_token_endpoint: tokenEndpoint.toString(),
        encrypted_state: encryptedState,
        execution_context: paramsInput.authorizationRequest.execution_context,
        config_version: paramsInput.resolved.config.config_version,
        pending_status: GatewayPendingProviderAuthorizationStatus.Pending,
        expires_at: expiresAtIso(30 * 60),
      })
      .returning();

    const url = new URL(authorizationEndpoint.toString());
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', credentials.clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', pkceChallenge(codeVerifier));
    url.searchParams.set('code_challenge_method', 'S256');
    if (paramsInput.scopes.length > 0) {
      url.searchParams.set('scope', paramsInput.scopes.join(' '));
    }

    return { pending, authorizationUrl: url.toString() };
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
  }) {
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
    if (!pending.authorization_request_id) {
      throw createGatewayError(
        GatewayErrorCode.InvalidRequest,
        'Authorization request is unavailable',
        400
      );
    }
    const [authorizationRequest] = await params.repository.database
      .select()
      .from(mcp_gateway_authorization_requests)
      .where(
        eq(
          mcp_gateway_authorization_requests.authorization_request_id,
          pending.authorization_request_id
        )
      )
      .limit(1);
    if (!authorizationRequest) {
      throw createGatewayError(
        GatewayErrorCode.InvalidRequest,
        'Authorization request is unavailable',
        400
      );
    }
    if (authorizationRequest.granted_scopes.join(' ') !== state.scopes.join(' ')) {
      throw createGatewayError(
        GatewayErrorCode.AccessDenied,
        'Provider authorization scope mismatch',
        403
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
    requireBearerTokenType(tokenResponse);
    const tokenType = tokenResponse.token_type;
    if (!tokenType) {
      throw createGatewayError(
        GatewayErrorCode.InvalidGrant,
        'Provider token type is not supported',
        400
      );
    }
    const expiresAt = tokenResponse.expires_in
      ? new Date(Date.now() + tokenResponse.expires_in * 1000).toISOString()
      : null;
    const grant = await params.grantService.replaceGrant({
      instanceId: instance.instance_id,
      bundle: {
        accessToken: tokenResponse.access_token,
        refreshToken: tokenResponse.refresh_token,
        expiresAt,
        scope: tokenResponse.scope,
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
    return { pending, authorizationRequest, grant, instance, resolved, route };
  }

  return {
    getProviderCredentials,
    initiateProviderAuthorization,
    consumeProviderError,
    handleProviderCallback,
  };
}

export type GatewayProviderOAuthService = ReturnType<typeof createProviderOAuthService>;
