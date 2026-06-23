import 'server-only';
import jwt from 'jsonwebtoken';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import {
  GatewayErrorCode,
  GatewayMcpAccessScope,
  NativeMcpTokenClaimsSchema,
  createGatewayError,
  isNativeMcpResource,
  nativeMcpResourceUrl,
  type OAuthTokenRequest,
} from '@kilocode/mcp-gateway';
import { mcp_native_authorization_codes, mcp_native_refresh_tokens } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import type { GatewayAppConfig } from '@/lib/mcp-gateway/config';
import type { GatewayOAuthClientService } from '@/lib/mcp-gateway/oauth-client-service';
import { activeSigningKey, authenticateGatewayOAuthClient } from '@/lib/mcp-gateway/token-service';
import { hashToken, pkceChallenge, randomToken } from '@/lib/mcp-gateway/crypto';
import { findEligibleNativeMcpUser } from './native-token-verifier';

export function createNativeMcpTokenService(params: {
  database?: typeof db;
  clientService: GatewayOAuthClientService;
  config: GatewayAppConfig;
}) {
  const database = params.database ?? db;
  const resourceUrl = nativeMcpResourceUrl(params.config.appBaseUrl);

  function requireNativeResource(request: OAuthTokenRequest) {
    if (!isNativeMcpResource(request.resource, params.config.appBaseUrl)) {
      throw createGatewayError(
        GatewayErrorCode.InvalidGrant,
        'Native MCP resource is required',
        400
      );
    }
  }

  function requireMcpAccess(scopes: string[]) {
    if (!scopes.includes(GatewayMcpAccessScope)) {
      throw createGatewayError(GatewayErrorCode.InvalidGrant, 'mcp:access scope is required', 400);
    }
  }

  async function mintAccessToken(input: { userId: string; clientId: string; scopes: string[] }) {
    const signingKey = activeSigningKey(params.config);
    const now = Math.floor(Date.now() / 1000);
    const exp = now + params.config.accessTokenTtlSeconds;
    const claims = NativeMcpTokenClaimsSchema.parse({
      iss: params.config.issuer,
      sub: input.userId,
      aud: resourceUrl,
      exp,
      iat: now,
      scope: input.scopes.join(' '),
      token_use: 'native_mcp',
      client_id: input.clientId,
    });
    const token = jwt.sign(claims, signingKey.privateKeyPem, {
      algorithm: 'RS256',
      keyid: signingKey.keyId,
    });
    return { token, expiresAt: new Date(exp * 1000).toISOString() };
  }

  async function issueRefreshToken(input: {
    oauthClientId: string;
    clientId: string;
    userId: string;
    scopes: string[];
    rotatedFromRefreshTokenId?: string | null;
  }) {
    const token = randomToken(32);
    await database.insert(mcp_native_refresh_tokens).values({
      token_hash: hashToken(token),
      rotated_from_refresh_token_id: input.rotatedFromRefreshTokenId ?? null,
      oauth_client_id: input.oauthClientId,
      client_id: input.clientId,
      canonical_resource_url: resourceUrl,
      granted_scopes: input.scopes,
      kilo_user_id: input.userId,
    });
    return token;
  }

  async function exchangeAuthorizationCode(input: {
    request: OAuthTokenRequest;
    headers: Headers;
  }) {
    if (input.request.grant_type !== 'authorization_code' || !input.request.code) {
      throw createGatewayError(
        GatewayErrorCode.InvalidGrant,
        'Authorization code is required',
        400
      );
    }
    requireNativeResource(input.request);
    const client = await authenticateGatewayOAuthClient({
      request: input.request,
      headers: input.headers,
      clientService: params.clientService,
    });
    if (!client.grant_types.includes('authorization_code')) {
      throw createGatewayError(
        GatewayErrorCode.UnauthorizedClient,
        'Client cannot redeem codes',
        400
      );
    }
    const [code] = await database
      .select()
      .from(mcp_native_authorization_codes)
      .where(
        and(
          eq(mcp_native_authorization_codes.code_hash, hashToken(input.request.code)),
          isNull(mcp_native_authorization_codes.consumed_at),
          gt(mcp_native_authorization_codes.expires_at, sql`NOW()`)
        )
      )
      .limit(1);
    if (!code || code.client_id !== client.client_id) {
      throw createGatewayError(GatewayErrorCode.InvalidGrant, 'Authorization code is invalid', 400);
    }
    requireMcpAccess(code.granted_scopes);
    if (code.canonical_resource_url !== resourceUrl) {
      throw createGatewayError(
        GatewayErrorCode.InvalidGrant,
        'Authorization code resource is invalid',
        400
      );
    }
    if (input.request.redirect_uri !== code.redirect_uri) {
      throw createGatewayError(GatewayErrorCode.InvalidGrant, 'Redirect URI mismatch', 400);
    }
    if (
      !input.request.code_verifier ||
      pkceChallenge(input.request.code_verifier) !== code.code_challenge
    ) {
      throw createGatewayError(GatewayErrorCode.InvalidGrant, 'PKCE verification failed', 400);
    }
    const user = await findEligibleNativeMcpUser(code.kilo_user_id, database);
    if (!user) {
      throw createGatewayError(
        GatewayErrorCode.InvalidGrant,
        'Native MCP access is unavailable',
        400
      );
    }
    const [consumed] = await database
      .update(mcp_native_authorization_codes)
      .set({ consumed_at: new Date().toISOString() })
      .where(
        and(
          eq(mcp_native_authorization_codes.authorization_code_id, code.authorization_code_id),
          isNull(mcp_native_authorization_codes.consumed_at),
          gt(mcp_native_authorization_codes.expires_at, sql`NOW()`)
        )
      )
      .returning();
    if (!consumed) {
      throw createGatewayError(
        GatewayErrorCode.InvalidGrant,
        'Authorization code was already consumed',
        400
      );
    }
    const accessToken = await mintAccessToken({
      userId: code.kilo_user_id,
      clientId: client.client_id,
      scopes: code.granted_scopes,
    });
    const refreshToken = await issueRefreshToken({
      oauthClientId: client.oauth_client_id,
      clientId: client.client_id,
      userId: code.kilo_user_id,
      scopes: code.granted_scopes,
    });
    return {
      access_token: accessToken.token,
      token_type: 'bearer',
      expires_in: params.config.accessTokenTtlSeconds,
      refresh_token: refreshToken,
      scope: code.granted_scopes.join(' '),
    };
  }

  async function exchangeRefreshToken(input: { request: OAuthTokenRequest; headers: Headers }) {
    if (input.request.grant_type !== 'refresh_token' || !input.request.refresh_token) {
      throw createGatewayError(GatewayErrorCode.InvalidGrant, 'Refresh token is required', 400);
    }
    requireNativeResource(input.request);
    const client = await authenticateGatewayOAuthClient({
      request: input.request,
      headers: input.headers,
      clientService: params.clientService,
    });
    if (!client.grant_types.includes('refresh_token')) {
      throw createGatewayError(
        GatewayErrorCode.UnauthorizedClient,
        'Client cannot refresh tokens',
        400
      );
    }
    const [refreshToken] = await database
      .select()
      .from(mcp_native_refresh_tokens)
      .where(
        and(
          eq(mcp_native_refresh_tokens.token_hash, hashToken(input.request.refresh_token)),
          isNull(mcp_native_refresh_tokens.consumed_at),
          isNull(mcp_native_refresh_tokens.revoked_at)
        )
      )
      .limit(1);
    if (!refreshToken || refreshToken.client_id !== client.client_id) {
      throw createGatewayError(GatewayErrorCode.InvalidGrant, 'Refresh token is invalid', 400);
    }
    requireMcpAccess(refreshToken.granted_scopes);
    if (refreshToken.canonical_resource_url !== resourceUrl) {
      throw createGatewayError(
        GatewayErrorCode.InvalidGrant,
        'Refresh token resource is invalid',
        400
      );
    }
    const user = await findEligibleNativeMcpUser(refreshToken.kilo_user_id, database);
    if (!user) {
      throw createGatewayError(
        GatewayErrorCode.InvalidGrant,
        'Native MCP access is unavailable',
        400
      );
    }
    const nextRefreshToken = randomToken(32);
    const rotated = await database.transaction(async tx => {
      const [consumed] = await tx
        .update(mcp_native_refresh_tokens)
        .set({ consumed_at: new Date().toISOString() })
        .where(
          and(
            eq(mcp_native_refresh_tokens.refresh_token_id, refreshToken.refresh_token_id),
            isNull(mcp_native_refresh_tokens.consumed_at),
            isNull(mcp_native_refresh_tokens.revoked_at)
          )
        )
        .returning();
      if (!consumed) return null;
      await tx.insert(mcp_native_refresh_tokens).values({
        token_hash: hashToken(nextRefreshToken),
        rotated_from_refresh_token_id: refreshToken.refresh_token_id,
        oauth_client_id: client.oauth_client_id,
        client_id: client.client_id,
        canonical_resource_url: resourceUrl,
        granted_scopes: refreshToken.granted_scopes,
        kilo_user_id: refreshToken.kilo_user_id,
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
    const accessToken = await mintAccessToken({
      userId: refreshToken.kilo_user_id,
      clientId: client.client_id,
      scopes: refreshToken.granted_scopes,
    });
    return {
      access_token: accessToken.token,
      token_type: 'bearer',
      expires_in: params.config.accessTokenTtlSeconds,
      refresh_token: nextRefreshToken,
      scope: refreshToken.granted_scopes.join(' '),
    };
  }

  async function exchangeToken(input: { request: OAuthTokenRequest; headers: Headers }) {
    if (input.request.grant_type === 'authorization_code') {
      return await exchangeAuthorizationCode(input);
    }
    return await exchangeRefreshToken(input);
  }

  return { exchangeToken, mintAccessToken };
}

export type NativeMcpTokenService = ReturnType<typeof createNativeMcpTokenService>;
