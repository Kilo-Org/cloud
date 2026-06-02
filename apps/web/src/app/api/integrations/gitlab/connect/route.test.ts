import { beforeEach, describe, expect, test } from '@jest/globals';
import { NextRequest } from 'next/server';
import { getUserFromAuth } from '@/lib/user/server';
import { buildGitLabOAuthUrl } from '@/lib/integrations/platforms/gitlab/adapter';
import { createGitLabOAuthState } from '@/lib/integrations/platforms/gitlab/oauth-state';
import { storeGitLabOAuthCredentials } from '@/lib/integrations/platforms/gitlab/oauth-credentials';

jest.mock('@/lib/user/server');
jest.mock('@/routers/organizations/utils', () => ({
  ensureOrganizationAccess: jest.fn(),
}));
jest.mock('@/lib/integrations/platforms/gitlab/adapter', () => ({
  buildGitLabOAuthUrl: jest.fn(),
}));
jest.mock('@/lib/integrations/platforms/gitlab/oauth-state', () => ({
  DEFAULT_GITLAB_OAUTH_INSTANCE_URL: 'https://gitlab.com',
  createGitLabOAuthState: jest.fn(),
}));
jest.mock('@/lib/integrations/platforms/gitlab/oauth-credentials', () => ({
  storeGitLabOAuthCredentials: jest.fn(),
}));
jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
}));

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedBuildGitLabOAuthUrl = jest.mocked(buildGitLabOAuthUrl);
const mockedCreateGitLabOAuthState = jest.mocked(createGitLabOAuthState);
const mockedStoreGitLabOAuthCredentials = jest.mocked(storeGitLabOAuthCredentials);

const USER_ID = '034489e8-19e0-4479-9d69-2edad719e847';

function makeRequest(pathWithQuery: string) {
  return new NextRequest(`http://localhost:3000${pathWithQuery}`);
}

function makeJsonRequest(pathWithQuery: string, body: unknown) {
  return new NextRequest(`http://localhost:3000${pathWithQuery}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function expectRedirectLocation(response: Response, expectedPathWithQuery: string) {
  const location = response.headers.get('location');
  expect(location).toBeTruthy();
  const url = new URL(location ?? '');
  expect(`${url.pathname}${url.search}`).toBe(expectedPathWithQuery);
}

async function callGitLabConnect(request: NextRequest) {
  const { GET } = await import('../../[platform]/connect/route');
  return GET(request, { params: Promise.resolve({ platform: 'gitlab' }) });
}

async function callGitLabConnectPost(request: NextRequest) {
  const { POST } = await import('../../[platform]/connect/route');
  return POST(request, { params: Promise.resolve({ platform: 'gitlab' }) });
}

describe('GET /api/integrations/gitlab/connect', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetUserFromAuth.mockResolvedValue({
      user: { id: USER_ID },
      authFailedResponse: null,
    } as never);
    mockedCreateGitLabOAuthState.mockReturnValue('signed-gitlab-state');
    mockedStoreGitLabOAuthCredentials.mockResolvedValue('cached-credentials-ref');
    mockedBuildGitLabOAuthUrl.mockReturnValue('https://gitlab.com/oauth/authorize?state=signed');
  });

  test('creates signed personal OAuth state before redirecting to GitLab', async () => {
    const response = await callGitLabConnect(makeRequest('/api/integrations/gitlab/connect'));

    expect(response.headers.get('location')).toBe(
      'https://gitlab.com/oauth/authorize?state=signed'
    );
    expect(mockedCreateGitLabOAuthState).toHaveBeenCalledWith(
      {
        owner: { type: 'user', id: USER_ID },
      },
      USER_ID
    );
    expect(mockedBuildGitLabOAuthUrl).toHaveBeenCalledWith(
      'signed-gitlab-state',
      undefined,
      undefined
    );
  });

  test('redirects unauthenticated first-party users to sign in with the connect URL as the callback', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      user: null,
      authFailedResponse: new Response(null, { status: 401 }),
    } as never);

    const response = await callGitLabConnect(
      makeRequest('/api/integrations/gitlab/connect?organizationId=org-gitlab-123')
    );

    const location = response.headers.get('location');
    expect(location).toBeTruthy();
    const url = new URL(location ?? '');
    expect(url.pathname).toBe('/users/sign_in');
    expect(url.searchParams.get('callbackPath')).toBe(
      '/api/integrations/gitlab/connect?organizationId=org-gitlab-123'
    );
    expect(mockedCreateGitLabOAuthState).not.toHaveBeenCalled();
    expect(mockedStoreGitLabOAuthCredentials).not.toHaveBeenCalled();
    expect(mockedBuildGitLabOAuthUrl).not.toHaveBeenCalled();
  });

  test('does not preserve self-hosted client secrets through sign-in callback URLs', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      user: null,
      authFailedResponse: new Response(null, { status: 401 }),
    } as never);

    const response = await callGitLabConnect(
      makeRequest(
        '/api/integrations/gitlab/connect?organizationId=org-gitlab-123&instanceUrl=https%3A%2F%2Fgitlab.example.com&clientId=client-id&clientSecret=client-secret'
      )
    );

    const location = response.headers.get('location');
    expect(location).toBeTruthy();
    const url = new URL(location ?? '');
    expect(url.pathname).toBe('/users/sign_in');
    expect(url.searchParams.get('callbackPath')).toBe(
      '/organizations/org-gitlab-123/integrations/gitlab'
    );
    expect(location).not.toContain('clientSecret');
    expect(location).not.toContain('client-secret');
    expect(mockedCreateGitLabOAuthState).not.toHaveBeenCalled();
    expect(mockedStoreGitLabOAuthCredentials).not.toHaveBeenCalled();
    expect(mockedBuildGitLabOAuthUrl).not.toHaveBeenCalled();
  });

  test('does not initialize a self-hosted flow without custom OAuth credentials', async () => {
    const response = await callGitLabConnect(
      makeRequest('/api/integrations/gitlab/connect?instanceUrl=https%3A%2F%2Fattacker.example')
    );

    expectRedirectLocation(response, '/integrations/gitlab?error=oauth_init_failed');
    expect(mockedCreateGitLabOAuthState).not.toHaveBeenCalled();
    expect(mockedBuildGitLabOAuthUrl).not.toHaveBeenCalled();
  });

  test('stores self-hosted credentials and binds only their Redis reference into signed state', async () => {
    const response = await callGitLabConnectPost(
      makeJsonRequest('/api/integrations/gitlab/connect', {
        instanceUrl: 'https://GitLab.Example.com/gitlab/',
        clientId: 'client-id',
        clientSecret: 'client-secret',
      })
    );
    const responseBody = (await response.json()) as { url?: string };

    expect(mockedStoreGitLabOAuthCredentials).toHaveBeenCalledWith({
      clientId: 'client-id',
      clientSecret: 'client-secret',
    });
    expect(mockedCreateGitLabOAuthState).toHaveBeenCalledWith(
      {
        owner: { type: 'user', id: USER_ID },
        instanceUrl: 'https://gitlab.example.com/gitlab',
        customCredentialsRef: 'cached-credentials-ref',
      },
      USER_ID
    );
    expect(mockedBuildGitLabOAuthUrl).toHaveBeenCalledWith(
      'signed-gitlab-state',
      'https://gitlab.example.com/gitlab',
      {
        clientId: 'client-id',
        clientSecret: 'client-secret',
      }
    );
    expect(responseBody.url).toBe('https://gitlab.com/oauth/authorize?state=signed');
  });

  test('does not initialize self-hosted OAuth for unsafe instance URLs', async () => {
    const response = await callGitLabConnectPost(
      makeJsonRequest('/api/integrations/gitlab/connect', {
        instanceUrl: 'http://127.0.0.1:8080',
        clientId: 'client-id',
        clientSecret: 'client-secret',
      })
    );
    const responseBody = (await response.json()) as { error?: string };

    expect(response.status).toBe(500);
    expect(responseBody.error).toBe('oauth_init_failed');
    expect(mockedStoreGitLabOAuthCredentials).not.toHaveBeenCalled();
    expect(mockedCreateGitLabOAuthState).not.toHaveBeenCalled();
    expect(mockedBuildGitLabOAuthUrl).not.toHaveBeenCalled();
  });

  test('supports authenticated legacy GET self-hosted credentials during rollout', async () => {
    const response = await callGitLabConnect(
      makeRequest(
        '/api/integrations/gitlab/connect?instanceUrl=https%3A%2F%2Fgitlab.example.com&clientId=client-id&clientSecret=client-secret'
      )
    );

    expect(response.headers.get('location')).toBe(
      'https://gitlab.com/oauth/authorize?state=signed'
    );
    expect(mockedStoreGitLabOAuthCredentials).toHaveBeenCalledWith({
      clientId: 'client-id',
      clientSecret: 'client-secret',
    });
    expect(mockedCreateGitLabOAuthState).toHaveBeenCalledWith(
      {
        owner: { type: 'user', id: USER_ID },
        instanceUrl: 'https://gitlab.example.com',
        customCredentialsRef: 'cached-credentials-ref',
      },
      USER_ID
    );
    expect(mockedBuildGitLabOAuthUrl).toHaveBeenCalledWith(
      'signed-gitlab-state',
      'https://gitlab.example.com',
      {
        clientId: 'client-id',
        clientSecret: 'client-secret',
      }
    );
  });

  test('preserves a valid returnTo in signed OAuth state', async () => {
    await callGitLabConnect(
      makeRequest('/api/integrations/gitlab/connect?returnTo=%2Fclaw%2Fnew%3Fstep%3Dgitlab')
    );

    expect(mockedCreateGitLabOAuthState).toHaveBeenCalledWith(
      {
        owner: { type: 'user', id: USER_ID },
        returnTo: '/claw/new?step=gitlab',
      },
      USER_ID
    );
  });

  test('drops invalid returnTo values from signed OAuth state', async () => {
    await callGitLabConnect(
      makeRequest('/api/integrations/gitlab/connect?returnTo=https%3A%2F%2Fevil.example.com%2Fpath')
    );

    expect(mockedCreateGitLabOAuthState).toHaveBeenCalledWith(
      {
        owner: { type: 'user', id: USER_ID },
      },
      USER_ID
    );
  });

  test('does not create OAuth state when credential caching is unavailable', async () => {
    mockedStoreGitLabOAuthCredentials.mockResolvedValue(null);

    const response = await callGitLabConnectPost(
      makeJsonRequest('/api/integrations/gitlab/connect', {
        instanceUrl: 'https://gitlab.example.com',
        clientId: 'client-id',
        clientSecret: 'client-secret',
      })
    );

    expect(response.status).toBe(500);
    expect(mockedCreateGitLabOAuthState).not.toHaveBeenCalled();
    expect(mockedBuildGitLabOAuthUrl).not.toHaveBeenCalled();
  });
});
