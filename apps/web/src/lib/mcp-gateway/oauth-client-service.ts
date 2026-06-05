import 'server-only';
import {
  GatewayOAuthClientAuthMethod,
  OAuthClientMetadataSchema,
  filterSupportedScopes,
  parseScopeString,
  createGatewayError,
  GatewayErrorCode,
} from '@kilocode/mcp-gateway';
import type { OAuthClientMetadata } from '@kilocode/mcp-gateway';
import { mcp_gateway_oauth_clients, mcp_gateway_rate_limit_windows } from '@kilocode/db/schema';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { GatewayRepository } from './repository';
import { expiresAtIso, floorToMinuteIso, hashToken, hmacValue, randomToken } from './crypto';
import type { GatewayAppConfig } from './config';

const PUBLIC_REGISTRATION_LIMIT_PER_MINUTE = 10;

export type GatewayOAuthClientRegistration = {
  clientId: string;
  clientSecret: string | null;
  registrationAccessToken: string;
  registrationAccessTokenExpiresAt: string;
  metadata: OAuthClientMetadata;
  declaredScopes: string[];
};

function clientIp(headers: Headers): string {
  // apps/web is deployed behind Vercel, which overwrites this header at the edge.
  // Do not trust generic forwarded headers for an unauthenticated public rate limit.
  const forwarded = headers.get('x-vercel-forwarded-for');
  if (!forwarded) return 'unknown';
  return forwarded.split(',')[0]?.trim() || 'unknown';
}

export function createOAuthClientService(params: {
  repository: GatewayRepository;
  config: GatewayAppConfig;
}) {
  async function consumeRegistrationRateLimit(headers: Headers): Promise<void> {
    const ipHash = hmacValue(clientIp(headers), params.config.rateLimitSecret);
    const windowStartedAt = floorToMinuteIso();
    const [window] = await params.repository.database
      .insert(mcp_gateway_rate_limit_windows)
      .values({ ip_hash: ipHash, window_started_at: windowStartedAt, attempt_count: 1 })
      .onConflictDoUpdate({
        target: [
          mcp_gateway_rate_limit_windows.ip_hash,
          mcp_gateway_rate_limit_windows.window_started_at,
        ],
        set: {
          attempt_count: sql`${mcp_gateway_rate_limit_windows.attempt_count} + 1`,
        },
      })
      .returning();

    if (window.attempt_count > PUBLIC_REGISTRATION_LIMIT_PER_MINUTE) {
      throw createGatewayError(
        GatewayErrorCode.AccessDenied,
        'Registration rate limit exceeded',
        429
      );
    }
  }

  function validateDeclaredScopes(scope: string): string[] {
    const requestedScopes = parseScopeString(scope);
    if (requestedScopes.length === 0) {
      throw createGatewayError(
        GatewayErrorCode.InvalidClientMetadata,
        'At least one scope is required',
        400
      );
    }
    const declaredScopes = filterSupportedScopes(requestedScopes);
    if (declaredScopes.length !== requestedScopes.length) {
      throw createGatewayError(GatewayErrorCode.InvalidClientMetadata, 'Unsupported scopes', 400);
    }
    return declaredScopes;
  }

  async function registerClient(input: {
    metadata: unknown;
    headers: Headers;
    rateLimitConsumed?: boolean;
  }): Promise<GatewayOAuthClientRegistration> {
    if (!input.rateLimitConsumed) {
      await consumeRegistrationRateLimit(input.headers);
    }
    const metadata = OAuthClientMetadataSchema.safeParse(input.metadata);
    if (!metadata.success) {
      throw createGatewayError(
        GatewayErrorCode.InvalidClientMetadata,
        'Invalid client metadata',
        400
      );
    }

    const declaredScopes = validateDeclaredScopes(metadata.data.scope);
    const clientId = `mcp:${randomToken(18)}`;
    const registrationAccessToken = randomToken(32);
    const registrationAccessTokenExpiresAt = expiresAtIso(
      params.config.registrationCredentialTtlSeconds
    );
    const clientSecret =
      metadata.data.token_endpoint_auth_method === GatewayOAuthClientAuthMethod.None
        ? null
        : randomToken(32);

    await params.repository.database.insert(mcp_gateway_oauth_clients).values({
      client_id: clientId,
      client_name: metadata.data.client_name ?? null,
      registration_token_hash: hashToken(registrationAccessToken),
      client_secret_hash: clientSecret ? hashToken(clientSecret) : null,
      token_endpoint_auth_method: metadata.data.token_endpoint_auth_method,
      redirect_uris: metadata.data.redirect_uris,
      grant_types: metadata.data.grant_types,
      response_types: metadata.data.response_types,
      declared_scopes: declaredScopes,
      registration_access_token_expires_at: registrationAccessTokenExpiresAt,
    });

    return {
      clientId,
      clientSecret,
      registrationAccessToken,
      registrationAccessTokenExpiresAt,
      metadata: metadata.data,
      declaredScopes,
    };
  }

  async function findClientById(clientId: string) {
    const rows = await params.repository.database
      .select()
      .from(mcp_gateway_oauth_clients)
      .where(
        and(
          eq(mcp_gateway_oauth_clients.client_id, clientId),
          isNull(mcp_gateway_oauth_clients.deleted_at)
        )
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async function findClientByRegistrationToken(token: string) {
    const rows = await params.repository.database
      .select()
      .from(mcp_gateway_oauth_clients)
      .where(
        and(
          eq(mcp_gateway_oauth_clients.registration_token_hash, hashToken(token)),
          isNull(mcp_gateway_oauth_clients.deleted_at)
        )
      )
      .limit(1);
    const client = rows[0] ?? null;
    if (!client) return null;
    if (
      client.registration_access_token_expires_at &&
      new Date(client.registration_access_token_expires_at) <= new Date()
    ) {
      return null;
    }
    return client;
  }

  async function updateClient(input: { clientId: string; metadata: unknown }) {
    const metadata = OAuthClientMetadataSchema.safeParse(input.metadata);
    if (!metadata.success) {
      throw createGatewayError(
        GatewayErrorCode.InvalidClientMetadata,
        'Invalid client metadata',
        400
      );
    }
    const rows = await params.repository.database
      .update(mcp_gateway_oauth_clients)
      .set({
        client_name: metadata.data.client_name ?? null,
        token_endpoint_auth_method: metadata.data.token_endpoint_auth_method,
        redirect_uris: metadata.data.redirect_uris,
        grant_types: metadata.data.grant_types,
        response_types: metadata.data.response_types,
        declared_scopes: validateDeclaredScopes(metadata.data.scope),
      })
      .where(eq(mcp_gateway_oauth_clients.client_id, input.clientId))
      .returning();
    return rows[0] ?? null;
  }

  async function deleteClient(clientId: string) {
    const rows = await params.repository.database
      .update(mcp_gateway_oauth_clients)
      .set({ deleted_at: new Date().toISOString() })
      .where(eq(mcp_gateway_oauth_clients.client_id, clientId))
      .returning();
    return rows[0] ?? null;
  }

  return {
    consumeRegistrationRateLimit,
    registerClient,
    findClientById,
    findClientByRegistrationToken,
    updateClient,
    deleteClient,
  };
}

export type GatewayOAuthClientService = ReturnType<typeof createOAuthClientService>;
