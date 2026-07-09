import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { NextRequest } from 'next/server';
import type * as authorizationRoute from './route';
import type * as scopedAuthorizationRoute from './[scope]/[ownerId]/[configId]/[routeKey]/route';
import { OAuthAuthorizationRedirectError } from '@/lib/mcp-gateway/authorization-service';

const mockGetUserFromAuth = jest.fn<
  (params: { adminOnly: boolean }) => Promise<{
    user: { id: string; google_user_name: string; google_user_email: string };
    organizationId?: string;
  }>
>();
const mockPreviewAuthorization = jest.fn<
  (params: unknown) => Promise<{
    clientId: string;
    clientName: string;
    redirectUri: string;
    resource: string;
    connectionName: string;
    endpointHost: string;
    contextName: string;
    ownerScope: 'personal' | 'organization';
    ownerId: string;
    configId: string;
    connectResourceId: string;
    scopes: string[];
    executionContext: { type: string; organizationId?: string };
  }>
>();
const mockAuthorize =
  jest.fn<(params: unknown) => Promise<{ kind: 'provider_redirect'; authorizationUrl: string }>>();
const mockRouteAuthorize = jest.fn();
const mockAuditRecord = jest.fn();

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
      resolveRouteParams: async () => ({
        config: {
          owner_scope: 'organization',
          owner_id: '2ea138dc-8680-4edf-bfb7-3979329b5a7f',
          config_id: '316e173c-1007-4f8a-b805-18fe4d95c203',
        },
        route: {
          connect_resource_id: 'c8e51d69-e76f-4f3f-89fd-95d2980f7c9c',
        },
      }),
      authorize: mockRouteAuthorize,
    },
    auditService: { record: mockAuditRecord },
    authorizationService: {
      previewAuthorization: mockPreviewAuthorization,
      authorize: mockAuthorize,
    },
  }),
}));

let route: typeof authorizationRoute | undefined;
let scopedRoute: typeof scopedAuthorizationRoute | undefined;

beforeAll(async () => {
  route = await import('./route');
  scopedRoute = await import('./[scope]/[ownerId]/[configId]/[routeKey]/route');
});

beforeEach(() => {
  jest.clearAllMocks();
});

const mockUser = {
  id: 'user-1',
  google_user_name: 'Alice Developer',
  google_user_email: 'alice@example.com',
};

function organizationPreview() {
  return {
    clientId: 'mcp:client',
    clientName: 'Codex',
    redirectUri: 'http://127.0.0.1:60424/callback',
    resource:
      'http://localhost:8806/mcp-connect/org/2ea138dc-8680-4edf-bfb7-3979329b5a7f/316e173c-1007-4f8a-b805-18fe4d95c203/HdEEQpx1wuG9q_iiHQRVTDQX4jB50UhF483SQuuDRVc',
    connectionName: 'Production GitHub',
    endpointHost: 'mcp.github.example',
    contextName: 'Acme Engineering',
    ownerScope: 'organization' as const,
    ownerId: '2ea138dc-8680-4edf-bfb7-3979329b5a7f',
    configId: '316e173c-1007-4f8a-b805-18fe4d95c203',
    connectResourceId: 'c8e51d69-e76f-4f3f-89fd-95d2980f7c9c',
    scopes: ['mcp:access'],
    executionContext: {
      type: 'organization',
      organizationId: '2ea138dc-8680-4edf-bfb7-3979329b5a7f',
    },
  };
}

function loadedRoute(): typeof authorizationRoute {
  if (!route) throw new Error('Route was not loaded');
  return route;
}

function loadedScopedRoute(): typeof scopedAuthorizationRoute {
  if (!scopedRoute) throw new Error('Scoped route was not loaded');
  return scopedRoute;
}

function authorizationUrl(redirectUri = 'http://127.0.0.1:60424/callback') {
  const query = new URLSearchParams({
    client_id: 'mcp:client',
    redirect_uri: redirectUri,
    response_type: 'code',
    resource:
      'http://localhost:8806/mcp-connect/org/2ea138dc-8680-4edf-bfb7-3979329b5a7f/316e173c-1007-4f8a-b805-18fe4d95c203/HdEEQpx1wuG9q_iiHQRVTDQX4jB50UhF483SQuuDRVc',
    scope: 'mcp:access',
    state: 'client-state',
  });
  return `http://localhost:3000/api/mcp-gateway/oauth/authorize?${query}`;
}

function approvalRequest(
  approvalState: string,
  cookie: string,
  decision: 'allow' | 'deny' = 'allow',
  redirectUri = 'http://127.0.0.1:60424/callback'
) {
  const form = new URLSearchParams({
    client_id: 'mcp:client',
    redirect_uri: redirectUri,
    response_type: 'code',
    resource:
      'http://localhost:8806/mcp-connect/org/2ea138dc-8680-4edf-bfb7-3979329b5a7f/316e173c-1007-4f8a-b805-18fe4d95c203/HdEEQpx1wuG9q_iiHQRVTDQX4jB50UhF483SQuuDRVc',
    scope: 'mcp:access',
    state: 'client-state',
    approval_state: approvalState,
    decision,
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
      user: mockUser,
      organizationId: undefined,
    });
    mockPreviewAuthorization.mockResolvedValue(organizationPreview());
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
    expect(getResponse.headers.get('content-security-policy')).toContain(
      "form-action 'self' https:"
    );
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

  test('returns access_denied to the validated callback without authorizing', async () => {
    mockGetUserFromAuth.mockResolvedValue({ user: mockUser, organizationId: undefined });
    mockPreviewAuthorization.mockResolvedValue(organizationPreview());

    const getResponse = await loadedRoute().GET(new NextRequest(authorizationUrl()));
    if (!getResponse) throw new Error('Expected authorization response');
    const document = await getResponse.text();
    const approvalState = document.match(/name="approval_state" value="([^"]+)"/)?.[1];
    const cookie = getResponse.headers.get('set-cookie')?.split(';')[0];
    if (!approvalState || !cookie) throw new Error('Expected consent approval state');

    const response = await loadedRoute().POST(approvalRequest(approvalState, cookie, 'deny'));
    if (!response) throw new Error('Expected denial response');
    const location = response.headers.get('location');
    if (!location) throw new Error('Expected denial redirect');
    const redirect = new URL(location);

    expect(response.status).toBe(303);
    expect(redirect.origin + redirect.pathname).toBe('http://127.0.0.1:60424/callback');
    expect(redirect.searchParams.get('error')).toBe('access_denied');
    expect(redirect.searchParams.get('state')).toBe('client-state');
    expect(mockAuthorize).not.toHaveBeenCalled();
    expect(mockAuditRecord).toHaveBeenCalledWith({
      actorUserId: mockUser.id,
      ownerScope: 'organization',
      ownerId: '2ea138dc-8680-4edf-bfb7-3979329b5a7f',
      configId: '316e173c-1007-4f8a-b805-18fe4d95c203',
      connectResourceId: 'c8e51d69-e76f-4f3f-89fd-95d2980f7c9c',
      instanceId: null,
      oauthGrantId: null,
      eventType: 'authorization_denied',
      outcome: 'blocked',
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });
});

describe('GET /api/mcp-gateway/oauth/authorize', () => {
  test('shows unverified identity, effective access, callback, connection, context, and account', async () => {
    const redirectUri = 'https://client.example/callback?source=mcp&mode=desktop';
    mockGetUserFromAuth.mockResolvedValue({ user: mockUser, organizationId: undefined });
    mockPreviewAuthorization.mockResolvedValue({
      ...organizationPreview(),
      clientName: 'Codex <script>alert(1)</script>',
      redirectUri,
    });

    const response = await loadedRoute().GET(new NextRequest(authorizationUrl(redirectUri)));
    if (!response) throw new Error('Expected authorization response');
    const document = await response.text();

    expect(response.status).toBe(200);
    expect(document).toContain('Unverified app');
    expect(document).toContain(
      'An app is requesting access. Kilo has not verified who operates it.'
    );
    expect(document).toContain('mcp:client');
    expect(document).toContain('Production GitHub');
    expect(document).toContain('mcp.github.example');
    expect(document).toContain('Acme Engineering');
    expect(document).toContain('Alice Developer');
    expect(document).toContain('alice@example.com');
    expect(document).toContain('This grants broad MCP access');
    expect(document).toContain('all tools and data exposed by this MCP connection');
    expect(document).toContain('Permissions');
    expect(document).toContain('Use this MCP connection');
    expect(document).not.toContain('<span class="scope">mcp:access</span>');
    expect(document).toContain('credentials configured for the connection');
    expect(document).toContain('https://client.example/callback?source=mcp&amp;mode=desktop');
    expect(document).toContain('Deny access');
    expect(document).toContain('Allow access');
    expect(document).not.toContain('<script>alert(1)</script>');
    expect(document).not.toContain('Codex');
    expect(document).not.toContain('These scope labels do not currently limit');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(response.headers.get('content-security-policy')).toContain("form-action 'self' https:");
    expect(response.headers.get('content-security-policy')).not.toContain('https://client.example');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });

  test('allows a validated loopback callback origin in form redirects', async () => {
    mockGetUserFromAuth.mockResolvedValue({ user: mockUser, organizationId: undefined });
    mockPreviewAuthorization.mockResolvedValue(organizationPreview());

    const response = await loadedRoute().GET(new NextRequest(authorizationUrl()));
    if (!response) throw new Error('Expected authorization response');

    expect(response.headers.get('content-security-policy')).toContain(
      "form-action 'self' https: http://127.0.0.1:60424"
    );
  });

  test('uses independent cookies for simultaneous consent flows', async () => {
    mockGetUserFromAuth.mockResolvedValue({ user: mockUser, organizationId: undefined });
    mockPreviewAuthorization.mockResolvedValue(organizationPreview());

    const firstResponse = await loadedRoute().GET(new NextRequest(authorizationUrl()));
    const secondResponse = await loadedRoute().GET(new NextRequest(authorizationUrl()));
    if (!firstResponse || !secondResponse) throw new Error('Expected authorization responses');
    const firstCookieName = firstResponse.headers.get('set-cookie')?.split('=')[0];
    const secondCookieName = secondResponse.headers.get('set-cookie')?.split('=')[0];

    expect(firstCookieName).toMatch(/^mcp_gateway_authorization_approval_/);
    expect(secondCookieName).toMatch(/^mcp_gateway_authorization_approval_/);
    expect(firstCookieName).not.toBe(secondCookieName);
  });

  test('derives org execution context from an authorized browser resource', async () => {
    mockGetUserFromAuth.mockResolvedValue({ user: mockUser, organizationId: undefined });
    mockPreviewAuthorization.mockResolvedValue(organizationPreview());

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
    mockGetUserFromAuth.mockResolvedValue({ user: mockUser, organizationId: undefined });
    mockPreviewAuthorization.mockResolvedValue(organizationPreview());
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
    mockGetUserFromAuth.mockResolvedValue({ user: mockUser, organizationId: undefined });
    const url = new URL(authorizationUrl());
    url.searchParams.append('client_id', 'mcp:other-client');

    const response = await loadedRoute().GET(new NextRequest(url));
    if (!response) throw new Error('Expected authorization response');

    expect(response.status).toBe(400);
    expect(mockPreviewAuthorization).not.toHaveBeenCalled();
  });
});

describe('POST /api/mcp-gateway/oauth/authorize validation', () => {
  test('rejects approval after the authenticated account changes', async () => {
    mockGetUserFromAuth.mockResolvedValueOnce({ user: mockUser, organizationId: undefined });
    mockPreviewAuthorization.mockResolvedValue(organizationPreview());
    const getResponse = await loadedRoute().GET(new NextRequest(authorizationUrl()));
    if (!getResponse) throw new Error('Expected authorization response');
    const document = await getResponse.text();
    const approvalState = document.match(/name="approval_state" value="([^"]+)"/)?.[1];
    const cookie = getResponse.headers.get('set-cookie')?.split(';')[0];
    if (!approvalState || !cookie) throw new Error('Expected consent approval state');

    mockGetUserFromAuth.mockResolvedValueOnce({
      user: {
        id: 'user-2',
        google_user_name: 'Mallory Developer',
        google_user_email: 'mallory@example.com',
      },
      organizationId: undefined,
    });
    const response = await loadedRoute().POST(approvalRequest(approvalState, cookie));
    if (!response) throw new Error('Expected approval response');

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toContain('error=access_denied');
    expect(mockAuthorize).not.toHaveBeenCalled();
  });

  test('rejects approval when the callback changes after consent is rendered', async () => {
    mockGetUserFromAuth.mockResolvedValue({ user: mockUser, organizationId: undefined });
    mockPreviewAuthorization.mockImplementation(async input => {
      const query = (input as { query: { redirect_uri: string } }).query;
      return { ...organizationPreview(), redirectUri: query.redirect_uri };
    });
    const getResponse = await loadedRoute().GET(new NextRequest(authorizationUrl()));
    if (!getResponse) throw new Error('Expected authorization response');
    const document = await getResponse.text();
    const approvalState = document.match(/name="approval_state" value="([^"]+)"/)?.[1];
    const cookie = getResponse.headers.get('set-cookie')?.split(';')[0];
    if (!approvalState || !cookie) throw new Error('Expected consent approval state');

    const response = await loadedRoute().POST(
      approvalRequest(approvalState, cookie, 'allow', 'http://127.0.0.1:60424/alternate-callback')
    );
    if (!response) throw new Error('Expected approval response');

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toContain('error=access_denied');
    expect(mockAuthorize).not.toHaveBeenCalled();
  });

  test('rejects approval after the server-enforced consent lifetime', async () => {
    const now = Date.now();
    const dateNow = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      mockGetUserFromAuth.mockResolvedValue({ user: mockUser, organizationId: undefined });
      mockPreviewAuthorization.mockResolvedValue(organizationPreview());
      const getResponse = await loadedRoute().GET(new NextRequest(authorizationUrl()));
      if (!getResponse) throw new Error('Expected authorization response');
      const document = await getResponse.text();
      const approvalState = document.match(/name="approval_state" value="([^"]+)"/)?.[1];
      const cookie = getResponse.headers.get('set-cookie')?.split(';')[0];
      if (!approvalState || !cookie) throw new Error('Expected consent approval state');

      dateNow.mockReturnValue(now + 301_000);
      const response = await loadedRoute().POST(approvalRequest(approvalState, cookie));
      if (!response) throw new Error('Expected approval response');

      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toContain('error=access_denied');
      expect(mockAuthorize).not.toHaveBeenCalled();
    } finally {
      dateNow.mockRestore();
    }
  });

  test('rejects malformed approval state without constructing an invalid cookie name', async () => {
    mockGetUserFromAuth.mockResolvedValue({ user: mockUser, organizationId: undefined });
    mockPreviewAuthorization.mockResolvedValue(organizationPreview());

    const response = await loadedRoute().POST(
      approvalRequest('invalid; Path=/', 'unrelated=value')
    );
    if (!response) throw new Error('Expected approval response');

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toContain('error=access_denied');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(mockAuthorize).not.toHaveBeenCalled();
  });

  test('rejects duplicate approval state values', async () => {
    mockGetUserFromAuth.mockResolvedValue({ user: mockUser, organizationId: undefined });
    const form = new URLSearchParams({
      client_id: 'mcp:client',
      redirect_uri: 'http://127.0.0.1:60424/callback',
      response_type: 'code',
      resource:
        'http://localhost:8806/mcp-connect/org/2ea138dc-8680-4edf-bfb7-3979329b5a7f/316e173c-1007-4f8a-b805-18fe4d95c203/HdEEQpx1wuG9q_iiHQRVTDQX4jB50UhF483SQuuDRVc',
      scope: 'mcp:access',
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

describe('scoped POST /api/mcp-gateway/oauth/authorize/...', () => {
  test('uses a see-other redirect for OAuth errors after form submission', async () => {
    mockGetUserFromAuth.mockResolvedValue({ user: mockUser, organizationId: undefined });
    mockPreviewAuthorization.mockRejectedValue(
      new OAuthAuthorizationRedirectError(
        'access_denied',
        'Authorization failed',
        'http://127.0.0.1:60424/callback',
        'client-state'
      )
    );
    const form = new URLSearchParams({
      client_id: 'mcp:client',
      redirect_uri: 'http://127.0.0.1:60424/callback',
      response_type: 'code',
      scope: 'mcp:access',
      state: 'client-state',
      approval_state: 'approval-state',
      decision: 'allow',
    });
    const response = await loadedScopedRoute().POST(
      new NextRequest(
        'http://localhost:3000/api/mcp-gateway/oauth/authorize/org/2ea138dc-8680-4edf-bfb7-3979329b5a7f/316e173c-1007-4f8a-b805-18fe4d95c203/HdEEQpx1wuG9q_iiHQRVTDQX4jB50UhF483SQuuDRVc',
        {
          method: 'POST',
          body: form,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        }
      ),
      {
        params: Promise.resolve({
          scope: 'org',
          ownerId: '2ea138dc-8680-4edf-bfb7-3979329b5a7f',
          configId: '316e173c-1007-4f8a-b805-18fe4d95c203',
          routeKey: 'HdEEQpx1wuG9q_iiHQRVTDQX4jB50UhF483SQuuDRVc',
        }),
      }
    );
    if (!response) throw new Error('Expected scoped authorization response');

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toContain('error=access_denied');
  });
});
