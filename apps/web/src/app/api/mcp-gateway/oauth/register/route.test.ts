import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { NextRequest } from 'next/server';
import type { GatewayOAuthClientRegistration } from '@/lib/mcp-gateway/oauth-client-service';

const mockRegisterClient =
  jest.fn<
    (input: {
      metadata: unknown;
      headers: Headers;
      rateLimitConsumed?: boolean;
    }) => Promise<GatewayOAuthClientRegistration>
  >();
const mockConsumeRegistrationRateLimit = jest.fn<(headers: Headers) => Promise<void>>();

jest.mock('@/lib/mcp-gateway/services', () => ({
  createGatewayServices: () => ({
    config: { appBaseUrl: 'http://localhost:3000' },
    clientService: {
      consumeRegistrationRateLimit: mockConsumeRegistrationRateLimit,
      registerClient: mockRegisterClient,
    },
  }),
}));

beforeEach(() => {
  jest.clearAllMocks();
});

function request(body: Record<string, unknown>) {
  return new NextRequest('http://localhost:3000/api/mcp-gateway/oauth/register', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('POST /api/mcp-gateway/oauth/register', () => {
  test('omits client_secret for a public client', async () => {
    mockRegisterClient.mockResolvedValue({
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
    });
    const { POST } = await import('./route');
    const response = await POST(request({ token_endpoint_auth_method: 'none' }));
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toEqual({
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
    expect(body).not.toHaveProperty('client_secret');
  });

  test('returns a stable invalid_request response for malformed JSON', async () => {
    const { POST } = await import('./route');
    const response = await POST(
      new NextRequest('http://localhost:3000/api/mcp-gateway/oauth/register', {
        method: 'POST',
        body: '{',
        headers: { 'Content-Type': 'application/json' },
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'invalid_request',
      error_description: 'Request body is malformed',
    });
    expect(mockConsumeRegistrationRateLimit).toHaveBeenCalledTimes(1);
    expect(mockRegisterClient).not.toHaveBeenCalled();
  });

  test.each([
    ['client_secret_post', 'post-secret'],
    ['client_secret_basic', 'basic-secret'],
  ] as const)('includes client_secret for %s', async (tokenEndpointAuthMethod, clientSecret) => {
    mockRegisterClient.mockResolvedValue({
      clientId: 'mcp:confidential-client',
      clientSecret,
      registrationAccessToken: 'registration-token',
      registrationAccessTokenExpiresAt: '2026-06-04T20:00:00.000Z',
      metadata: {
        redirect_uris: ['http://localhost:3000/callback'],
        token_endpoint_auth_method: tokenEndpointAuthMethod,
        grant_types: ['authorization_code'],
        response_types: ['code'],
        scope: 'profile',
      },
      declaredScopes: ['profile'],
    });
    const { POST } = await import('./route');
    const response = await POST(request({ token_endpoint_auth_method: tokenEndpointAuthMethod }));
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.client_secret).toBe(clientSecret);
  });
});
