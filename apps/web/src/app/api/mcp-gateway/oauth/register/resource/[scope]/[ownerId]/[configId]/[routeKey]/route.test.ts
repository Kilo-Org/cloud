import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { NextRequest } from 'next/server';
import type { GatewayOAuthClientRegistration } from '@/lib/mcp-gateway/oauth-client-service';

const calls: string[] = [];
const mockConsumeRegistrationRateLimit = jest.fn<(headers: Headers) => Promise<void>>();
const mockResolveRouteParams = jest.fn<(route: unknown) => Promise<unknown>>();
const mockRegisterClient =
  jest.fn<
    (input: {
      metadata: unknown;
      headers: Headers;
      rateLimitConsumed?: boolean;
    }) => Promise<GatewayOAuthClientRegistration>
  >();

jest.mock('@/lib/mcp-gateway/services', () => ({
  createGatewayServices: () => ({
    config: { appBaseUrl: 'http://localhost:3000' },
    clientService: {
      consumeRegistrationRateLimit: mockConsumeRegistrationRateLimit,
      registerClient: mockRegisterClient,
    },
    routeService: {
      resolveRouteParams: mockResolveRouteParams,
    },
  }),
}));

beforeEach(() => {
  calls.length = 0;
  jest.clearAllMocks();
  mockConsumeRegistrationRateLimit.mockImplementation(async () => {
    calls.push('rate-limit');
  });
  mockResolveRouteParams.mockImplementation(async () => {
    calls.push('resolve-route');
    return {};
  });
  mockRegisterClient.mockImplementation(async () => {
    calls.push('register-client');
    return {
      clientId: 'mcp:public-client',
      clientSecret: null,
      registrationAccessToken: 'registration-token',
      registrationAccessTokenExpiresAt: '2026-06-04T20:00:00.000Z',
      metadata: {
        redirect_uris: ['http://localhost:3000/callback'],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code'],
        response_types: ['code'],
        scope: 'mcp:access',
      },
      declaredScopes: ['mcp:access'],
    };
  });
});

describe('POST /api/mcp-gateway/oauth/register/resource/...', () => {
  test('consumes the public rate limit before resolving the route', async () => {
    const { POST } = await import('./route');
    const response = await POST(
      new NextRequest(
        'http://localhost:3000/api/mcp-gateway/oauth/register/resource/user/user-1/316e173c-1007-4f8a-b805-18fe4d95c203/abcdefghijklmnopqrstuvwxyzABCDEF',
        {
          method: 'POST',
          body: JSON.stringify({ token_endpoint_auth_method: 'none' }),
          headers: { 'Content-Type': 'application/json' },
        }
      ),
      {
        params: Promise.resolve({
          scope: 'user',
          ownerId: 'user-1',
          configId: '316e173c-1007-4f8a-b805-18fe4d95c203',
          routeKey: 'abcdefghijklmnopqrstuvwxyzABCDEF',
        }),
      }
    );

    expect(response.status).toBe(201);
    expect(calls).toEqual(['rate-limit', 'resolve-route', 'register-client']);
  });

  test('consumes the public rate limit before validating route params', async () => {
    const { POST } = await import('./route');
    const response = await POST(
      new NextRequest(
        'http://localhost:3000/api/mcp-gateway/oauth/register/resource/user/user-1/not-a-uuid/short',
        {
          method: 'POST',
          body: JSON.stringify({ token_endpoint_auth_method: 'none' }),
          headers: { 'Content-Type': 'application/json' },
        }
      ),
      {
        params: Promise.resolve({
          scope: 'user',
          ownerId: 'user-1',
          configId: 'not-a-uuid',
          routeKey: 'short',
        }),
      }
    );

    expect(response.status).toBe(400);
    expect(calls).toEqual(['rate-limit']);
    expect(mockResolveRouteParams).not.toHaveBeenCalled();
    expect(mockRegisterClient).not.toHaveBeenCalled();
  });
});
