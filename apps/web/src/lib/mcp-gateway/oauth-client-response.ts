import type { GatewayOAuthClientRegistration } from './oauth-client-service';

export function serializeRegistrationResponse(
  registration: GatewayOAuthClientRegistration,
  appBaseUrl: string
) {
  return {
    client_id: registration.clientId,
    client_name: registration.metadata.client_name,
    redirect_uris: registration.metadata.redirect_uris,
    token_endpoint_auth_method: registration.metadata.token_endpoint_auth_method,
    grant_types: registration.metadata.grant_types,
    response_types: registration.metadata.response_types,
    scope: registration.declaredScopes.join(' '),
    registration_access_token: registration.registrationAccessToken,
    registration_access_token_expires_at: registration.registrationAccessTokenExpiresAt,
    registration_client_uri: new URL(
      `/api/mcp-gateway/oauth/register/${registration.clientId}`,
      appBaseUrl
    ).toString(),
    ...(registration.clientSecret ? { client_secret: registration.clientSecret } : {}),
  };
}
