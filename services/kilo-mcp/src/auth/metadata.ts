/**
 * OAuth 2.1 / MCP discovery metadata (requirement 16):
 *
 * - `/.well-known/oauth-authorization-server` (+ the `/mcp`-scoped variant MCP
 *   clients probe first) — this worker is the authorization server for THIS
 *   MCP: PKCE S256 mandatory, `response_types: ['code']`, DCR + authorization
 *   code + refresh_token grants, public clients only (`token_endpoint_auth_method: none`).
 * - `/.well-known/oauth-protected-resource` (+ scoped variant) — RFC 9728:
 *   the resource name and the list of authorization servers that can mint
 *   tokens for it.
 *
 * The issuer is always the URL this worker is reached at, so dev and prod
 * advertise themselves without extra configuration.
 */
import { AUTH_PATHS, authJsonResponse, MCP_SCOPE, oauthErrorResponse } from './http';

export type MetadataDeps = {
  /** Origin of this worker for this request, e.g. `https://kilo-mcp.users.workers.dev`. */
  issuer: string;
};

/** The canonical RFC 8707 resource indicator for the MCP endpoint at `/mcp`. */
export function mcpResourceUrl(issuer: string): string {
  return `${issuer}/mcp`;
}

/** RFC 9728: the protected-resource metadata URL a 401 challenge points at. */
export function protectedResourceMetadataUrl(issuer: string): string {
  return `${issuer}${AUTH_PATHS.protectedResourceMetadata}`;
}

export function authorizationServerMetadata(issuer: string): Record<string, unknown> {
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    scopes_supported: [MCP_SCOPE],
    // PKCE is mandatory and S256 is the only accepted method.
    code_challenge_methods_supported: ['S256'],
    // Dynamic clients are public: no client secret is ever issued.
    token_endpoint_auth_methods_supported: ['none'],
  };
}

export function protectedResourceMetadata(
  issuer: string,
  resource: string
): Record<string, unknown> {
  return {
    resource,
    resource_name: 'Kilo MCP',
    authorization_servers: [issuer],
    scopes_supported: [MCP_SCOPE],
    bearer_methods_supported: ['header'],
  };
}

/** GET handler for both authorization-server metadata URLs. */
export function handleAuthorizationServerMetadata(request: Request, deps: MetadataDeps): Response {
  if (request.method !== 'GET') {
    return oauthErrorResponse(405, 'invalid_request', 'Use GET for discovery metadata.');
  }
  return authJsonResponse(authorizationServerMetadata(deps.issuer));
}

/** GET handler for both protected-resource metadata URLs (RFC 9728). */
export function handleProtectedResourceMetadata(request: Request, deps: MetadataDeps): Response {
  if (request.method !== 'GET') {
    return oauthErrorResponse(405, 'invalid_request', 'Use GET for discovery metadata.');
  }
  return authJsonResponse(protectedResourceMetadata(deps.issuer, mcpResourceUrl(deps.issuer)));
}
