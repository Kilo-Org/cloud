import 'server-only';
import {
  GatewayOAuthClientAuthMethod,
  GatewayMcpAccessScope,
  GatewayInstanceStatus,
  GatewayTokenClaimsSchema,
  GatewayExecutionContextSchema,
  GatewayErrorCode,
  createGatewayError,
  buildMCPID,
  parseScopeString,
  type GatewayExecutionContext,
  type GatewayTokenMintInput,
  type OAuthTokenRequest,
  type ScopedConnectRoute,
} from '@kilocode/mcp-gateway';
import {
  mcp_gateway_authorization_codes,
  mcp_gateway_oauth_grants,
  mcp_gateway_refresh_tokens,
} from '@kilocode/db/schema';
import { MCPGatewayOAuthGrantStatus } from '@kilocode/db/schema-types';
import { createPublicKey } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { timingSafeEqual } from '@kilocode/encryption';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { GatewayAppConfig, GatewayJWTKey } from './config';
import type { GatewayRepository } from './repository';
import type { GatewayRouteService } from './route-service';
import type { GatewayOAuthClientService } from './oauth-client-service';
import type { GatewayOAuthGrantService } from './oauth-grant-service';
import { hashToken, pkceChallenge, randomToken } from './crypto';
import { createAuditService } from './audit-service';

function publicJwks(config: GatewayAppConfig): { keys: Array<JsonWebKey & { kid: string }> } {
  return {
    keys: config.jwtKeyset.keys.map(key => ({ ...key.publicJwk, kid: key.keyId })),
  };
}

function activeSigningKey(config: GatewayAppConfig): GatewayJWTKey & { privateKeyPem: string } {
  const key = config.jwtKeyset.keys.find(
    candidate => candidate.keyId === config.jwtKeyset.activeKeyId
  );
  if (!key || !key.privateKeyPem) {
    throw createGatewayError(
      GatewayErrorCode.ServerError,
      'Gateway signing key is unavailable',
      500
    );
  }
  return { ...key, privateKeyPem: key.privateKeyPem };
}

function verificationKey(key: GatewayJWTKey) {
  return key.publicKeyPem ?? createPublicKey({ key: key.publicJwk, format: 'jwk' });
}

function requireMcpAccessGrant(scopes: string[]) {
  if (!scopes.includes(GatewayMcpAccessScope)) {
    throw createGatewayError(
      GatewayErrorCode.InvalidGrant,
      `${GatewayMcpAccessScope} scope is required`,
      400
    );
  }
}

function decodeBasicComponent(value: string): string | null {
  try {
    return decodeURIComponent(value.replaceAll('+', ' '));
  } catch {
    return null;
  }
}

function parseBasicAuthorization(
  header: string | null
): { clientId: string; clientSecret: string } | null {
  if (!header?.startsWith('Basic ')) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  } catch {
    return null;
  }
  const separator = decoded.indexOf(':');
  if (separator < 0) return null;
  const clientId = decodeBasicComponent(decoded.slice(0, separator));
  const clientSecret = decodeBasicComponent(decoded.slice(separator + 1));
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export function createTokenService(params: {
  repository: GatewayRepository;
  routeService: GatewayRouteService;
  clientService: GatewayOAuthClientService;
  oauthGrantService: GatewayOAuthGrantService;
  config: GatewayAppConfig;
}) {
  async function mintAccessToken(
    input: GatewayTokenMintInput & { route: ScopedConnectRoute; scopes: string[] }
  ) {
    const signingKey = activeSigningKey(params.config);
    const now = Math.floor(Date.now() / 1000);
    const exp = now + params.config.accessTokenTtlSeconds;
    const canonicalAudience = params.routeService.canonicalUrl(input.route);
    const sourceClaims =
      input.token_source === 'oauth_client'
        ? {
            token_source: input.token_source,
            oauth_grant_id: input.oauth_grant_id,
            client_id: input.client_id,
          }
        : { token_source: input.token_source };
    const claims = GatewayTokenClaimsSchema.parse({
      ...sourceClaims,
      iss: params.config.issuer,
      sub: input.sub,
      aud: canonicalAudience,
      exp,
      iat: now,
      scope: input.scopes.join(' '),
      MCPID: buildMCPID({
        ownerScope: input.owner_scope,
        ownerId: input.owner_id,
        configId: input.config_id,
        routeKey: input.route_key,
      }),
      owner_scope: input.owner_scope,
      owner_id: input.owner_id,
      config_id: input.config_id,
      route_key: input.route_key,
      instance_id: input.instance_id,
      execution_context: input.execution_context,
      config_version: input.config_version,
    });
    const token = jwt.sign(claims, signingKey.privateKeyPem, {
      algorithm: 'RS256',
      keyid: signingKey.keyId,
    });
    return { token, expiresAt: new Date(exp * 1000).toISOString() };
  }

  async function verifyUserInfoToken(token: string) {
    const decoded = jwt.decode(token, { complete: true });
    const kid = decoded && typeof decoded === 'object' ? decoded.header.kid : undefined;
    if (!kid) {
      throw createGatewayError(GatewayErrorCode.InvalidGrant, 'Token key ID is missing', 401);
    }
    const key = params.config.jwtKeyset.keys.find(candidate => candidate.keyId === kid);
    if (!key) {
      throw createGatewayError(GatewayErrorCode.InvalidGrant, 'Token key is unknown', 401);
    }
    const payload = jwt.verify(token, verificationKey(key), {
      algorithms: ['RS256'],
      issuer: params.config.issuer,
    });
    if (typeof payload === 'string') {
      throw createGatewayError(GatewayErrorCode.InvalidGrant, 'Token payload is malformed', 401);
    }
    return GatewayTokenClaimsSchema.parse(payload);
  }

  async function authenticateClient(request: OAuthTokenRequest, headers: Headers) {
    const basic = parseBasicAuthorization(headers.get('authorization'));
    const clientId = basic?.clientId ?? request.client_id;
    if (!clientId) {
      throw createGatewayError(GatewayErrorCode.InvalidClient, 'Client ID is required', 401);
    }
    if (basic?.clientId && request.client_id && basic.clientId !== request.client_id) {
      throw createGatewayError(GatewayErrorCode.InvalidClient, 'Client credentials conflict', 401);
    }
    const client = await params.clientService.findClientById(clientId);
    if (!client) {
      throw createGatewayError(GatewayErrorCode.InvalidClient, 'Unknown client', 401);
    }
    if (client.token_endpoint_auth_method === GatewayOAuthClientAuthMethod.None) {
      if (basic || request.client_secret) {
        throw createGatewayError(
          GatewayErrorCode.InvalidClient,
          'Public clients cannot use secrets',
          401
        );
      }
      return client;
    }
    if (client.token_endpoint_auth_method === GatewayOAuthClientAuthMethod.ClientSecretBasic) {
      if (!basic || request.client_secret) {
        throw createGatewayError(
          GatewayErrorCode.InvalidClient,
          'Client secret basic is required',
          401
        );
      }
      if (
        !client.client_secret_hash ||
        !timingSafeEqual(hashToken(basic.clientSecret), client.client_secret_hash)
      ) {
        throw createGatewayError(GatewayErrorCode.InvalidClient, 'Invalid client credentials', 401);
      }
      return client;
    }
    if (basic || !request.client_secret) {
      throw createGatewayError(
        GatewayErrorCode.InvalidClient,
        'Client secret post is required',
        401
      );
    }
    if (
      !client.client_secret_hash ||
      !timingSafeEqual(hashToken(request.client_secret), client.client_secret_hash)
    ) {
      throw createGatewayError(GatewayErrorCode.InvalidClient, 'Invalid client credentials', 401);
    }
    return client;
  }

  async function exchangeAuthorizationCode(paramsInput: {
    request: OAuthTokenRequest;
    headers: Headers;
    route?: ScopedConnectRoute;
  }) {
    if (paramsInput.request.grant_type !== 'authorization_code' || !paramsInput.request.code) {
      throw createGatewayError(
        GatewayErrorCode.InvalidGrant,
        'Authorization code is required',
        400
      );
    }
    const client = await authenticateClient(paramsInput.request, paramsInput.headers);
    if (!client.grant_types.includes('authorization_code')) {
      throw createGatewayError(
        GatewayErrorCode.UnauthorizedClient,
        'Client cannot redeem codes',
        400
      );
    }
    const [code] = await params.repository.database
      .select()
      .from(mcp_gateway_authorization_codes)
      .where(
        and(
          eq(mcp_gateway_authorization_codes.code_hash, hashToken(paramsInput.request.code)),
          isNull(mcp_gateway_authorization_codes.consumed_at),
          gt(mcp_gateway_authorization_codes.expires_at, sql`NOW()`)
        )
      )
      .limit(1);
    if (!code || code.client_id !== client.client_id) {
      throw createGatewayError(GatewayErrorCode.InvalidGrant, 'Authorization code is invalid', 400);
    }
    requireMcpAccessGrant(code.granted_scopes);
    if (!code.oauth_grant_id) {
      throw createGatewayError(GatewayErrorCode.InvalidGrant, 'OAuth grant is unavailable', 400);
    }
    const oauthGrant = await params.oauthGrantService.findActiveGrant(code.oauth_grant_id);
    if (
      !oauthGrant ||
      oauthGrant.oauth_client_id !== client.oauth_client_id ||
      oauthGrant.kilo_user_id !== code.kilo_user_id ||
      oauthGrant.instance_id !== code.instance_id ||
      oauthGrant.redirect_uri !== code.redirect_uri
    ) {
      throw createGatewayError(GatewayErrorCode.InvalidGrant, 'OAuth grant is unavailable', 400);
    }
    if (paramsInput.request.redirect_uri !== code.redirect_uri) {
      throw createGatewayError(GatewayErrorCode.InvalidGrant, 'Redirect URI mismatch', 400);
    }
    if (code.code_challenge) {
      if (
        !paramsInput.request.code_verifier ||
        pkceChallenge(paramsInput.request.code_verifier) !== code.code_challenge
      ) {
        throw createGatewayError(GatewayErrorCode.InvalidGrant, 'PKCE verification failed', 400);
      }
    }
    const route = params.routeService.parseResource(code.canonical_resource_url);
    if (paramsInput.request.resource) {
      const requestedRoute = params.routeService.parseResource(paramsInput.request.resource);
      if (requestedRoute.rootPath !== route.rootPath) {
        throw createGatewayError(
          GatewayErrorCode.InvalidGrant,
          'Token resource does not match code',
          400
        );
      }
    }
    if (paramsInput.route && paramsInput.route.rootPath !== route.rootPath) {
      throw createGatewayError(
        GatewayErrorCode.InvalidGrant,
        'Token route does not match code',
        400
      );
    }
    const resolved = await params.routeService.resolveRouteParams(route);
    await params.routeService.authorize({
      resolved,
      route,
      userId: code.kilo_user_id,
      executionContext: GatewayExecutionContextSchema.parse(code.execution_context),
    });
    const instance = await params.repository.findActiveInstance({
      ownerScope: resolved.config.owner_scope,
      ownerId: resolved.config.owner_id,
      configId: resolved.config.config_id,
      userId: code.kilo_user_id,
    });
    if (!instance || instance.instance_id !== code.instance_id) {
      throw createGatewayError(
        GatewayErrorCode.InvalidGrant,
        'Connection instance is unavailable',
        400
      );
    }
    if (
      oauthGrant.connect_resource_id !== resolved.route.connect_resource_id ||
      oauthGrant.config_version !== resolved.config.config_version
    ) {
      throw createGatewayError(GatewayErrorCode.InvalidGrant, 'OAuth grant is unavailable', 400);
    }
    const issueRefreshToken = client.grant_types.includes('refresh_token');
    const refreshToken = issueRefreshToken ? randomToken(32) : null;
    const [consumed] = await params.repository.database.transaction(async tx => {
      const [activeGrant] = await tx
        .select({ grantId: mcp_gateway_oauth_grants.oauth_grant_id })
        .from(mcp_gateway_oauth_grants)
        .where(
          and(
            eq(mcp_gateway_oauth_grants.oauth_grant_id, oauthGrant.oauth_grant_id),
            eq(mcp_gateway_oauth_grants.oauth_client_id, client.oauth_client_id),
            eq(mcp_gateway_oauth_grants.kilo_user_id, code.kilo_user_id),
            eq(mcp_gateway_oauth_grants.instance_id, code.instance_id),
            eq(mcp_gateway_oauth_grants.connect_resource_id, resolved.route.connect_resource_id),
            eq(mcp_gateway_oauth_grants.grant_status, MCPGatewayOAuthGrantStatus.Active),
            isNull(mcp_gateway_oauth_grants.revoked_at)
          )
        )
        .limit(1)
        .for('update');
      if (!activeGrant) return [];
      const consumedRows = await tx
        .update(mcp_gateway_authorization_codes)
        .set({ consumed_at: new Date().toISOString() })
        .where(
          and(
            eq(mcp_gateway_authorization_codes.authorization_code_id, code.authorization_code_id),
            eq(mcp_gateway_authorization_codes.oauth_grant_id, oauthGrant.oauth_grant_id),
            isNull(mcp_gateway_authorization_codes.consumed_at),
            gt(mcp_gateway_authorization_codes.expires_at, sql`NOW()`)
          )
        )
        .returning();
      const consumedCode = consumedRows[0];
      if (!consumedCode) return [];
      if (issueRefreshToken && refreshToken) {
        await tx.insert(mcp_gateway_refresh_tokens).values({
          token_hash: hashToken(refreshToken),
          oauth_client_id: client.oauth_client_id,
          oauth_grant_id: oauthGrant.oauth_grant_id,
          client_id: client.client_id,
          owner_scope: resolved.config.owner_scope,
          owner_id: resolved.config.owner_id,
          config_id: resolved.config.config_id,
          route_key: route.routeKey,
          canonical_resource_url: params.routeService.canonicalUrl(route),
          granted_scopes: code.granted_scopes,
          execution_context: GatewayExecutionContextSchema.parse(code.execution_context),
          kilo_user_id: code.kilo_user_id,
          instance_id: instance.instance_id,
        });
      }
      return [consumedCode];
    });
    if (!consumed) {
      throw createGatewayError(
        GatewayErrorCode.InvalidGrant,
        'Authorization code was already consumed',
        400
      );
    }
    const accessToken = await mintAccessToken({
      route,
      token_source: 'oauth_client',
      oauth_grant_id: oauthGrant.oauth_grant_id,
      client_id: client.client_id,
      sub: code.kilo_user_id,
      owner_scope: resolved.config.owner_scope,
      owner_id: resolved.config.owner_id,
      config_id: resolved.config.config_id,
      route_key: resolved.route.route_key,
      instance_id: instance.instance_id,
      execution_context: GatewayExecutionContextSchema.parse(code.execution_context),
      config_version: resolved.config.config_version,
      scopes: code.granted_scopes,
    });
    await params.oauthGrantService.touchGrant(oauthGrant.oauth_grant_id);
    await createAuditService(params.repository).record({
      actorUserId: code.kilo_user_id,
      ownerScope: resolved.config.owner_scope,
      ownerId: resolved.config.owner_id,
      configId: resolved.config.config_id,
      connectResourceId: resolved.route.connect_resource_id,
      instanceId: instance.instance_id,
      oauthGrantId: oauthGrant.oauth_grant_id,
      eventType: 'token_issued',
      outcome: 'success',
    });
    return {
      access_token: accessToken.token,
      token_type: 'bearer',
      expires_in: params.config.accessTokenTtlSeconds,
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
      scope: code.granted_scopes.join(' '),
    };
  }

  async function exchangeRefreshToken(paramsInput: {
    request: OAuthTokenRequest;
    headers: Headers;
    route?: ScopedConnectRoute;
  }) {
    if (paramsInput.request.grant_type !== 'refresh_token' || !paramsInput.request.refresh_token) {
      throw createGatewayError(GatewayErrorCode.InvalidGrant, 'Refresh token is required', 400);
    }
    const client = await authenticateClient(paramsInput.request, paramsInput.headers);
    if (!client.grant_types.includes('refresh_token')) {
      throw createGatewayError(
        GatewayErrorCode.UnauthorizedClient,
        'Client cannot refresh tokens',
        400
      );
    }
    const [refreshToken] = await params.repository.database
      .select()
      .from(mcp_gateway_refresh_tokens)
      .where(
        and(
          eq(mcp_gateway_refresh_tokens.token_hash, hashToken(paramsInput.request.refresh_token)),
          isNull(mcp_gateway_refresh_tokens.consumed_at),
          isNull(mcp_gateway_refresh_tokens.revoked_at)
        )
      )
      .limit(1);
    if (!refreshToken || refreshToken.client_id !== client.client_id) {
      throw createGatewayError(GatewayErrorCode.InvalidGrant, 'Refresh token is invalid', 400);
    }
    requireMcpAccessGrant(refreshToken.granted_scopes);
    if (!refreshToken.oauth_grant_id) {
      throw createGatewayError(GatewayErrorCode.InvalidGrant, 'OAuth grant is unavailable', 400);
    }
    const oauthGrant = await params.oauthGrantService.findActiveGrant(refreshToken.oauth_grant_id);
    if (
      !oauthGrant ||
      oauthGrant.oauth_client_id !== client.oauth_client_id ||
      oauthGrant.kilo_user_id !== refreshToken.kilo_user_id ||
      oauthGrant.instance_id !== refreshToken.instance_id
    ) {
      throw createGatewayError(GatewayErrorCode.InvalidGrant, 'OAuth grant is unavailable', 400);
    }
    const route = params.routeService.parseResource(refreshToken.canonical_resource_url);
    if (paramsInput.request.resource) {
      const requestedRoute = params.routeService.parseResource(paramsInput.request.resource);
      if (requestedRoute.rootPath !== route.rootPath) {
        throw createGatewayError(
          GatewayErrorCode.InvalidGrant,
          'Token resource does not match refresh token',
          400
        );
      }
    }
    if (paramsInput.route && paramsInput.route.rootPath !== route.rootPath) {
      throw createGatewayError(
        GatewayErrorCode.InvalidGrant,
        'Token route does not match refresh token',
        400
      );
    }
    const resolved = await params.routeService.resolveRouteParams(route);
    const executionContext = GatewayExecutionContextSchema.parse(refreshToken.execution_context);
    await params.routeService.authorize({
      resolved,
      route,
      userId: refreshToken.kilo_user_id,
      executionContext,
    });
    const instance = await params.repository.findActiveInstance({
      ownerScope: resolved.config.owner_scope,
      ownerId: resolved.config.owner_id,
      configId: resolved.config.config_id,
      userId: refreshToken.kilo_user_id,
    });
    if (!instance || instance.instance_id !== refreshToken.instance_id) {
      throw createGatewayError(
        GatewayErrorCode.InvalidGrant,
        'Connection instance is unavailable',
        400
      );
    }
    if (
      oauthGrant.connect_resource_id !== resolved.route.connect_resource_id ||
      oauthGrant.config_version !== resolved.config.config_version
    ) {
      throw createGatewayError(GatewayErrorCode.InvalidGrant, 'OAuth grant is unavailable', 400);
    }
    const nextRefreshToken = randomToken(32);
    const rotated = await params.repository.database.transaction(async tx => {
      const [activeGrant] = await tx
        .select({ grantId: mcp_gateway_oauth_grants.oauth_grant_id })
        .from(mcp_gateway_oauth_grants)
        .where(
          and(
            eq(mcp_gateway_oauth_grants.oauth_grant_id, oauthGrant.oauth_grant_id),
            eq(mcp_gateway_oauth_grants.oauth_client_id, client.oauth_client_id),
            eq(mcp_gateway_oauth_grants.kilo_user_id, refreshToken.kilo_user_id),
            eq(mcp_gateway_oauth_grants.instance_id, refreshToken.instance_id),
            eq(mcp_gateway_oauth_grants.connect_resource_id, resolved.route.connect_resource_id),
            eq(mcp_gateway_oauth_grants.grant_status, MCPGatewayOAuthGrantStatus.Active),
            isNull(mcp_gateway_oauth_grants.revoked_at)
          )
        )
        .limit(1)
        .for('update');
      if (!activeGrant) return null;
      const [consumed] = await tx
        .update(mcp_gateway_refresh_tokens)
        .set({ consumed_at: new Date().toISOString() })
        .where(
          and(
            eq(mcp_gateway_refresh_tokens.refresh_token_id, refreshToken.refresh_token_id),
            isNull(mcp_gateway_refresh_tokens.consumed_at),
            isNull(mcp_gateway_refresh_tokens.revoked_at)
          )
        )
        .returning();
      if (!consumed) return null;
      await tx.insert(mcp_gateway_refresh_tokens).values({
        token_hash: hashToken(nextRefreshToken),
        rotated_from_refresh_token_id: refreshToken.refresh_token_id,
        oauth_client_id: client.oauth_client_id,
        oauth_grant_id: oauthGrant.oauth_grant_id,
        client_id: client.client_id,
        owner_scope: resolved.config.owner_scope,
        owner_id: resolved.config.owner_id,
        config_id: resolved.config.config_id,
        route_key: resolved.route.route_key,
        canonical_resource_url: resolved.route.canonical_url,
        granted_scopes: refreshToken.granted_scopes,
        execution_context: executionContext,
        kilo_user_id: refreshToken.kilo_user_id,
        instance_id: instance.instance_id,
      });
      return consumed;
    });
    if (!rotated) {
      throw createGatewayError(
        GatewayErrorCode.InvalidGrant,
        'Refresh token was already consumed',
        400
      );
    }
    await params.oauthGrantService.touchGrant(oauthGrant.oauth_grant_id);
    const accessToken = await mintAccessToken({
      route,
      token_source: 'oauth_client',
      oauth_grant_id: oauthGrant.oauth_grant_id,
      client_id: client.client_id,
      sub: refreshToken.kilo_user_id,
      owner_scope: resolved.config.owner_scope,
      owner_id: resolved.config.owner_id,
      config_id: resolved.config.config_id,
      route_key: resolved.route.route_key,
      instance_id: instance.instance_id,
      execution_context: executionContext,
      config_version: resolved.config.config_version,
      scopes: refreshToken.granted_scopes,
    });
    await createAuditService(params.repository).record({
      actorUserId: refreshToken.kilo_user_id,
      ownerScope: resolved.config.owner_scope,
      ownerId: resolved.config.owner_id,
      configId: resolved.config.config_id,
      connectResourceId: resolved.route.connect_resource_id,
      instanceId: instance.instance_id,
      oauthGrantId: oauthGrant.oauth_grant_id,
      eventType: 'token_refreshed',
      outcome: 'success',
    });
    return {
      access_token: accessToken.token,
      token_type: 'bearer',
      expires_in: params.config.accessTokenTtlSeconds,
      refresh_token: nextRefreshToken,
      scope: refreshToken.granted_scopes.join(' '),
    };
  }

  async function exchangeToken(paramsInput: {
    request: OAuthTokenRequest;
    headers: Headers;
    route?: ScopedConnectRoute;
  }) {
    if (paramsInput.request.grant_type === 'authorization_code') {
      return await exchangeAuthorizationCode(paramsInput);
    }
    return await exchangeRefreshToken(paramsInput);
  }

  async function mintDerivedConnectToken(paramsInput: {
    route: ScopedConnectRoute;
    userId: string;
    executionContext: GatewayExecutionContext;
  }) {
    const resolved = await params.routeService.resolveRouteParams(paramsInput.route);
    await params.routeService.authorize({
      resolved,
      route: paramsInput.route,
      userId: paramsInput.userId,
      executionContext: paramsInput.executionContext,
    });
    const instance = await params.repository.ensureConnectionInstance({
      ownerScope: resolved.config.owner_scope,
      ownerId: resolved.config.owner_id,
      configId: resolved.config.config_id,
      userId: paramsInput.userId,
    });
    if (
      (resolved.config.auth_mode === 'oauth_dynamic' ||
        resolved.config.auth_mode === 'oauth_static') &&
      (instance.instance_status !== GatewayInstanceStatus.Active ||
        !(await params.repository.findActiveGrant(instance.instance_id)))
    ) {
      throw createGatewayError(
        GatewayErrorCode.Forbidden,
        'Provider authorization is required',
        403
      );
    }
    return await mintAccessToken({
      route: paramsInput.route,
      token_source: 'derived_connect',
      sub: paramsInput.userId,
      owner_scope: resolved.config.owner_scope,
      owner_id: resolved.config.owner_id,
      config_id: resolved.config.config_id,
      route_key: resolved.route.route_key,
      instance_id: instance.instance_id,
      execution_context: paramsInput.executionContext,
      config_version: resolved.config.config_version,
      scopes: [GatewayMcpAccessScope],
    });
  }

  async function userInfo(token: string) {
    const claims = await verifyUserInfoToken(token);
    if (!parseScopeString(claims.scope).includes('profile')) {
      throw createGatewayError(GatewayErrorCode.InvalidScope, 'profile scope is required', 401);
    }
    if (claims.token_source !== 'oauth_client') {
      throw createGatewayError(GatewayErrorCode.InvalidGrant, 'OAuth grant is unavailable', 401);
    }
    const expectedAudiencePrefix = new URL(
      '/mcp-connect/',
      params.config.gatewayBaseUrl
    ).toString();
    if (!claims.aud || !claims.aud.startsWith(expectedAudiencePrefix)) {
      throw createGatewayError(GatewayErrorCode.InvalidGrant, 'Token audience is invalid', 401);
    }
    const oauthGrant = await params.oauthGrantService.findActiveGrant(claims.oauth_grant_id);
    if (!oauthGrant || !oauthGrant.granted_scopes.includes('profile')) {
      throw createGatewayError(GatewayErrorCode.InvalidGrant, 'OAuth grant is unavailable', 401);
    }
    const user = await params.repository.findUser(claims.sub);
    if (!user) {
      throw createGatewayError(GatewayErrorCode.InvalidGrant, 'User is unavailable', 403);
    }
    const updatedAt = new Date(user.updated_at);
    return {
      sub: user.id,
      name: user.google_user_name,
      preferred_username: user.google_user_email,
      picture: user.google_user_image_url,
      updated_at: Number.isNaN(updatedAt.getTime()) ? undefined : updatedAt.toISOString(),
      email: user.google_user_email,
    };
  }

  return {
    mintAccessToken,
    verifyUserInfoToken,
    exchangeToken,
    mintDerivedConnectToken,
    userInfo,
    publicJwks,
  };
}

export type GatewayTokenService = ReturnType<typeof createTokenService>;
