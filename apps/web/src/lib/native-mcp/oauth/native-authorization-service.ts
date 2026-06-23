import 'server-only';
import {
  GatewayErrorCode,
  GatewayMcpAccessScope,
  GatewayOAuthClientAuthMethod,
  createGatewayError,
  isNativeMcpResource,
  nativeMcpResourceUrl,
  parseScopeString,
  type OAuthAuthorizationQuery,
} from '@kilocode/mcp-gateway';
import { mcp_native_authorization_codes } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import type { GatewayAppConfig } from '@/lib/mcp-gateway/config';
import type { GatewayOAuthClientService } from '@/lib/mcp-gateway/oauth-client-service';
import { OAuthAuthorizationRedirectError } from '@/lib/mcp-gateway/authorization-service';
import { expiresAtIso, hashToken, randomToken } from '@/lib/mcp-gateway/crypto';
import { findEligibleNativeMcpUser } from './native-token-verifier';

type OAuthErrorCode = (typeof GatewayErrorCode)[keyof typeof GatewayErrorCode];

function nativeRedirectError(params: {
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

export function createNativeMcpAuthorizationService(params: {
  database?: typeof db;
  clientService: GatewayOAuthClientService;
  config: GatewayAppConfig;
}) {
  const database = params.database ?? db;
  const resourceUrl = nativeMcpResourceUrl(params.config.appBaseUrl);

  function redirectOrThrow(input: {
    query: OAuthAuthorizationQuery;
    redirectErrors?: boolean;
    code: OAuthErrorCode;
    message: string;
  }): never {
    if (input.redirectErrors) {
      throw nativeRedirectError({
        code: input.code,
        message: input.message,
        redirectUri: input.query.redirect_uri,
        state: input.query.state,
      });
    }
    throw createGatewayError(input.code, input.message, 400);
  }

  async function prepareAuthorization(input: {
    query: OAuthAuthorizationQuery;
    userId: string;
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
    if (!isNativeMcpResource(input.query.resource, params.config.appBaseUrl)) {
      redirectOrThrow({
        query: input.query,
        redirectErrors: input.redirectErrors,
        code: GatewayErrorCode.InvalidRequest,
        message: 'Native MCP resource is required',
      });
    }
    if (
      !client.response_types.includes('code') ||
      !client.grant_types.includes('authorization_code')
    ) {
      redirectOrThrow({
        query: input.query,
        redirectErrors: input.redirectErrors,
        code: GatewayErrorCode.UnauthorizedClient,
        message: 'Client cannot use authorization code',
      });
    }
    const codeChallenge = input.query.code_challenge;
    if (!codeChallenge || input.query.code_challenge_method !== 'S256') {
      const message =
        client.token_endpoint_auth_method === GatewayOAuthClientAuthMethod.None
          ? 'PKCE is required for public clients'
          : 'PKCE S256 is required for native MCP';
      redirectOrThrow({
        query: input.query,
        redirectErrors: input.redirectErrors,
        code: GatewayErrorCode.InvalidRequest,
        message,
      });
    }
    if (!client.declared_scopes.includes(GatewayMcpAccessScope)) {
      redirectOrThrow({
        query: input.query,
        redirectErrors: input.redirectErrors,
        code: GatewayErrorCode.UnauthorizedClient,
        message: `Client must register the ${GatewayMcpAccessScope} scope`,
      });
    }
    const scopes = parseScopeString(input.query.scope);
    if (scopes.length !== 1 || scopes[0] !== GatewayMcpAccessScope) {
      redirectOrThrow({
        query: input.query,
        redirectErrors: input.redirectErrors,
        code: GatewayErrorCode.InvalidScope,
        message: `${GatewayMcpAccessScope} scope is required`,
      });
    }
    const user = await findEligibleNativeMcpUser(input.userId, database);
    if (!user) {
      redirectOrThrow({
        query: input.query,
        redirectErrors: input.redirectErrors,
        code: GatewayErrorCode.AccessDenied,
        message: 'Native MCP access is currently limited to Kilo admins',
      });
    }
    return { client, scopes, user, codeChallenge };
  }

  async function previewAuthorization(input: {
    query: OAuthAuthorizationQuery;
    userId: string;
    redirectErrors?: boolean;
  }) {
    const prepared = await prepareAuthorization(input);
    return {
      clientId: prepared.client.client_id,
      clientName: prepared.client.client_name,
      redirectUri: input.query.redirect_uri,
      resource: resourceUrl,
      connectionName: 'Kilo usage stats',
      endpointHost: new URL(resourceUrl).host,
      ownerScope: 'personal' as const,
      contextName: 'Kilo admin preview',
      scopes: prepared.scopes,
    };
  }

  async function authorize(input: { query: OAuthAuthorizationQuery; userId: string }) {
    const prepared = await prepareAuthorization({ ...input, redirectErrors: true });
    const code = randomToken(32);
    const codeValues = {
      code_hash: hashToken(code),
      oauth_client_id: prepared.client.oauth_client_id,
      client_id: prepared.client.client_id,
      canonical_resource_url: resourceUrl,
      redirect_uri: input.query.redirect_uri,
      granted_scopes: prepared.scopes,
      code_challenge: prepared.codeChallenge,
      code_challenge_method: 'S256',
      kilo_user_id: input.userId,
      expires_at: expiresAtIso(params.config.authorizationCodeTtlSeconds),
    } satisfies typeof mcp_native_authorization_codes.$inferInsert;
    await database.insert(mcp_native_authorization_codes).values(codeValues);
    const redirect = new URL(input.query.redirect_uri);
    redirect.searchParams.set('code', code);
    if (input.query.state) {
      redirect.searchParams.set('state', input.query.state);
    }
    return { kind: 'redirect' as const, redirectUrl: redirect.toString() };
  }

  return { previewAuthorization, authorize };
}

export type NativeMcpAuthorizationService = ReturnType<typeof createNativeMcpAuthorizationService>;
