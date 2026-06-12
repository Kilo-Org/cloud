import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { NextRequest } from 'next/server';
import type * as authorizationRoute from './route';

const mockGetUserFromAuth =
  jest.fn<
    (params: { adminOnly: boolean }) => Promise<{ user: { id: string }; organizationId?: string }>
  >();
const mockPreviewAuthorization = jest.fn<
  (params: unknown) => Promise<{
    clientId: string;
    clientName: string;
    resource: string;
    scopes: string[];
    executionContext: { type: string; organizationId?: string };
  }>
>();
const mockAuthorize =
  jest.fn<(params: unknown) => Promise<{ kind: 'provider_redirect'; authorizationUrl: string }>>();
const mockRouteAuthorize = jest.fn();

jest.mock('@/lib/user/server', () => ({
  getUserFromAuth: mockGetUserFromAuth,
}));

jest.mock('@/lib/mcp-gateway/services', () => ({
  createGatewayServices: () => ({
    config: { rateLimitSecret: 'test-rate-limit-secret' },
    routeService: {
      parseResource: () => ({
        ownerScope: 'organization',
        ownerId: '2ea138dc-8680-4edf-bfb7-3979329b5a7f',
        rootPath:
          '/mcp-connect/org/2ea138dc-8680-4edf-bfb7-3979329b5a7f/316e173c-1007-4f8a-b805-18fe4d95c203/HdEEQpx1wuG9q_iiHQRVTDQX4jB50UhF483SQuuDRVc',
      }),
      resolveResource: async () => ({
        route: {
          ownerScope: 'organization',
          ownerId: '2ea138dc-8680-4edf-bfb7-3979329b5a7f',
          rootPath:
            '/mcp-connect/org/2ea138dc-8680-4edf-bfb7-3979329b5a7f/316e173c-1007-4f8a-b805-18fe4d95c203/HdEEQpx1wuG9q_iiHQRVTDQX4jB50UhF483SQuuDRVc',
        },
        resolved: {},
      }),
      resolveRouteParams: async () => ({}),
      authorize: mockRouteAuthorize,
    },
    authorizationService: {
      previewAuthorization: mockPreviewAuthorization,
      authorize: mockAuthorize,
    },
  }),
}));

let route: typeof authorizationRoute | undefined;

beforeAll(async () => {
  route = await import('./route');
});

beforeEach(() => {
  jest.clearAllMocks();
});

function loadedRoute(): typeof authorizationRoute {
  if (!route) throw new Error('Route was not loaded');
  return route;
}

function authorizationUrl() {
  const query = new URLSearchParams({
    client_id: 'mcp:client',
    redirect_uri: 'http://127.0.0.1:60424/callback',
    response_type: 'code',
    resource:
      'http://localhost:8806/mcp-connect/org/2ea138dc-8680-4edf-bfb7-3979329b5a7f/316e173c-1007-4f8a-b805-18fe4d95c203/HdEEQpx1wuG9q_iiHQRVTDQX4jB50UhF483SQuuDRVc',
    scope: 'profile',
    state: 'client-state',
  });
  return `http://localhost:3000/api/mcp-gateway/oauth/authorize?${query}`;
}

function approvalRequest(approvalState: string, cookie: string) {
  const form = new URLSearchParams({
    client_id: 'mcp:client',
    redirect_uri: 'http://127.0.0.1:60424/callback',
    response_type: 'code',
    resource:
      'http://localhost:8806/mcp-connect/org/2ea138dc-8680-4edf-bfb7-3979329b5a7f/316e173c-1007-4f8a-b805-18fe4d95c203/HdEEQpx1wuG9q_iiHQRVTDQX4jB50UhF483SQuuDRVc',
    scope: 'profile',
    state: 'client-state',
    approval_state: approvalState,
  });
  return new NextRequest('http://localhost:3000/api/mcp-gateway/oauth/authorize', {
    method: 'POST',
    body: form,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: cookie,
    },
  });
}

describe('POST /api/mcp-gateway/oauth/authorize', () => {
  test('uses a see-other redirect for a browser org provider authorization after approval', async () => {
    mockGetUserFromAuth.mockResolvedValue({
      user: { id: 'user-1' },
      organizationId: undefined,
    });
    mockPreviewAuthorization.mockResolvedValue({
      clientId: 'mcp:client',
      clientName: 'Codex',
      resource:
        'http://localhost:8806/mcp-connect/org/2ea138dc-8680-4edf-bfb7-3979329b5a7f/316e173c-1007-4f8a-b805-18fe4d95c203/HdEEQpx1wuG9q_iiHQRVTDQX4jB50UhF483SQuuDRVc',
      scopes: ['profile'],
      executionContext: {
        type: 'organization',
        organizationId: '2ea138dc-8680-4edf-bfb7-3979329b5a7f',
      },
    });
    mockAuthorize.mockResolvedValue({
      kind: 'provider_redirect',
      authorizationUrl: 'https://mcp.linear.app/authorize?state=provider-state',
    });

    const getResponse = await loadedRoute().GET(new NextRequest(authorizationUrl()));
    if (!getResponse) throw new Error('Expected authorization response');
    const document = await getResponse.text();
    expect(mockGetUserFromAuth).toHaveBeenCalledTimes(1);
    expect(mockPreviewAuthorization).toHaveBeenCalledTimes(1);
    expect(getResponse.status).toBe(200);
    const approvalState = document.match(/name="approval_state" value="([^"]+)"/)?.[1];
    const cookie = getResponse.headers.get('set-cookie')?.split(';')[0];
    expect(approvalState).toBeTruthy();
    expect(cookie).toBeTruthy();
    if (!approvalState || !cookie) return;

    const response = await loadedRoute().POST(approvalRequest(approvalState, cookie));
    if (!response) throw new Error('Expected approval response');

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(
      'https://mcp.linear.app/authorize?state=provider-state'
    );
    expect(mockPreviewAuthorization).toHaveBeenCalledTimes(2);
    expect(mockPreviewAuthorization).toHaveBeenLastCalledWith(
      expect.objectContaining({
        allowBrowserOrgResourceContext: true,
        executionContext: { type: 'personal' },
      })
    );
    expect(mockAuthorize).toHaveBeenCalledWith(
      expect.objectContaining({
        allowBrowserOrgResourceContext: true,
        executionContext: {
          type: 'organization',
          organizationId: '2ea138dc-8680-4edf-bfb7-3979329b5a7f',
        },
      })
    );
  });
});

describe('GET /api/mcp-gateway/oauth/authorize', () => {
  test('derives org execution context from an authorized browser resource', async () => {
    mockGetUserFromAuth.mockResolvedValue({ user: { id: 'user-1' }, organizationId: undefined });
    mockPreviewAuthorization.mockResolvedValue({
      clientId: 'mcp:client',
      clientName: 'Codex',
      resource:
        'http://localhost:8806/mcp-connect/org/2ea138dc-8680-4edf-bfb7-3979329b5a7f/316e173c-1007-4f8a-b805-18fe4d95c203/HdEEQpx1wuG9q_iiHQRVTDQX4jB50UhF483SQuuDRVc',
      scopes: ['profile'],
      executionContext: {
        type: 'organization',
        organizationId: '2ea138dc-8680-4edf-bfb7-3979329b5a7f',
      },
    });

    const response = await loadedRoute().GET(new NextRequest(authorizationUrl()));
    if (!response) throw new Error('Expected authorization response');

    expect(response.status).toBe(200);
    expect(mockPreviewAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({
        allowBrowserOrgResourceContext: true,
        executionContext: { type: 'personal' },
      })
    );
  });

  test('keeps explicit API execution context unchanged', async () => {
    mockGetUserFromAuth.mockResolvedValue({ user: { id: 'user-1' }, organizationId: undefined });
    mockPreviewAuthorization.mockResolvedValue({
      clientId: 'mcp:client',
      clientName: 'Codex',
      resource:
        'http://localhost:8806/mcp-connect/org/2ea138dc-8680-4edf-bfb7-3979329b5a7f/316e173c-1007-4f8a-b805-18fe4d95c203/HdEEQpx1wuG9q_iiHQRVTDQX4jB50UhF483SQuuDRVc',
      scopes: ['profile'],
      executionContext: {
        type: 'organization',
        organizationId: '2ea138dc-8680-4edf-bfb7-3979329b5a7f',
      },
    });
    const request = new NextRequest(authorizationUrl(), {
      headers: { Authorization: 'Bearer api-token' },
    });

    const response = await loadedRoute().GET(request);
    if (!response) throw new Error('Expected authorization response');

    expect(response.status).toBe(200);
    expect(mockPreviewAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({ executionContext: { type: 'personal' } })
    );
    expect(mockRouteAuthorize).not.toHaveBeenCalled();
  });

  test('rejects duplicate OAuth singleton query parameters', async () => {
    mockGetUserFromAuth.mockResolvedValue({ user: { id: 'user-1' }, organizationId: undefined });
    const url = new URL(authorizationUrl());
    url.searchParams.append('client_id', 'mcp:other-client');

    const response = await loadedRoute().GET(new NextRequest(url));
    if (!response) throw new Error('Expected authorization response');

    expect(response.status).toBe(400);
    expect(mockPreviewAuthorization).not.toHaveBeenCalled();
  });
});

describe('POST /api/mcp-gateway/oauth/authorize validation', () => {
  test('rejects duplicate approval state values', async () => {
    mockGetUserFromAuth.mockResolvedValue({ user: { id: 'user-1' }, organizationId: undefined });
    const form = new URLSearchParams({
      client_id: 'mcp:client',
      redirect_uri: 'http://127.0.0.1:60424/callback',
      response_type: 'code',
      resource:
        'http://localhost:8806/mcp-connect/org/2ea138dc-8680-4edf-bfb7-3979329b5a7f/316e173c-1007-4f8a-b805-18fe4d95c203/HdEEQpx1wuG9q_iiHQRVTDQX4jB50UhF483SQuuDRVc',
      scope: 'profile',
      state: 'client-state',
      approval_state: 'first-state',
    });
    form.append('approval_state', 'second-state');
    const response = await loadedRoute().POST(
      new NextRequest('http://localhost:3000/api/mcp-gateway/oauth/authorize', {
        method: 'POST',
        body: form,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      })
    );
    if (!response) throw new Error('Expected authorization response');

    expect(response.status).toBe(400);
    expect(mockPreviewAuthorization).not.toHaveBeenCalled();
  });
});
