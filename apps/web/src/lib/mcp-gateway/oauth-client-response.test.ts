import { describe, expect, test } from '@jest/globals';
import { serializeRegistrationResponse } from './oauth-client-response';
import type { GatewayOAuthClientRegistration } from './oauth-client-service';

const publicRegistration: GatewayOAuthClientRegistration = {
  clientId: 'mcp:public-client',
  clientSecret: null,
  registrationAccessToken: 'registration-token',
  registrationAccessTokenExpiresAt: '2026-06-04T20:00:00.000Z',
  metadata: {
    client_name: 'Codex',
    redirect_uris: ['http://localhost:3000/callback'],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    scope: 'profile',
  },
  declaredScopes: ['profile'],
};

describe('serializeRegistrationResponse', () => {
  test('omits client_secret for a public client', () => {
    const response = serializeRegistrationResponse(publicRegistration, 'http://localhost:3000');

    expect(response).toEqual({
      client_id: 'mcp:public-client',
      client_name: 'Codex',
      redirect_uris: ['http://localhost:3000/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: 'profile',
      registration_access_token: 'registration-token',
      registration_access_token_expires_at: '2026-06-04T20:00:00.000Z',
      registration_client_uri:
        'http://localhost:3000/api/mcp-gateway/oauth/register/mcp:public-client',
    });
    expect(response).not.toHaveProperty('client_secret');
  });

  test.each([
    ['client_secret_post', 'post-secret'],
    ['client_secret_basic', 'basic-secret'],
  ] as const)('includes client_secret for %s', (tokenEndpointAuthMethod, clientSecret) => {
    const response = serializeRegistrationResponse(
      {
        ...publicRegistration,
        clientSecret,
        metadata: {
          ...publicRegistration.metadata,
          token_endpoint_auth_method: tokenEndpointAuthMethod,
        },
      },
      'http://localhost:3000'
    );

    expect(response.client_secret).toBe(clientSecret);
    expect(response.token_endpoint_auth_method).toBe(tokenEndpointAuthMethod);
  });
});
