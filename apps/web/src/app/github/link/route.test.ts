import { beforeEach, describe, expect, test } from '@jest/globals';
import { NextRequest, NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { createGitHubBotLinkState } from '@/lib/bot/github-link-state';
import { getGitHubAppCredentials } from '@/lib/integrations/platforms/github/app-selector';
import { failureResult } from '@/lib/maybe-result';

jest.mock('@/lib/user.server');
jest.mock('@/lib/bot/github-link-state');
jest.mock('@/lib/integrations/platforms/github/app-selector');

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedCreateGitHubBotLinkState = jest.mocked(createGitHubBotLinkState);
const mockedGetGitHubAppCredentials = jest.mocked(getGitHubAppCredentials);

const USER_ID = '034489e8-19e0-4479-9d69-2edad719e847';

function makeRequest(path: string) {
  return new NextRequest(`http://localhost:3000${path}`);
}

function expectRedirectLocation(response: Response, expectedPathWithQuery: string) {
  const location = response.headers.get('location');
  expect(location).toBeTruthy();
  const url = new URL(location ?? '');
  expect(`${url.pathname}${url.search}`).toBe(expectedPathWithQuery);
}

describe('GET /github/link', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    mockedGetUserFromAuth.mockResolvedValue({
      user: { id: USER_ID },
      authFailedResponse: null,
    } as never);
    mockedCreateGitHubBotLinkState.mockReturnValue('signed-state');
    mockedGetGitHubAppCredentials.mockReturnValue({
      appId: 'app-id',
      privateKey: 'private-key',
      clientId: 'github-client-id',
      clientSecret: 'github-client-secret',
      appName: 'KiloConnect',
      webhookSecret: 'webhook-secret',
    });
  });

  test('redirects unauthenticated users to sign-in with callbackPath', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      user: null,
      authFailedResponse: NextResponse.json(failureResult('Unauthorized'), { status: 401 }),
    } as never);

    const { GET } = await import('./route');
    const response = await GET(makeRequest('/github/link') as never);

    expect(response.status).toBe(307);
    expectRedirectLocation(response, '/users/sign_in?callbackPath=%2Fgithub%2Flink');
  });

  test('redirects authenticated users to GitHub OAuth with signed state', async () => {
    const { GET } = await import('./route');
    const response = await GET(makeRequest('/github/link') as never);

    expect(response.status).toBe(307);
    const location = response.headers.get('location');
    expect(location).toBeTruthy();
    const redirectUrl = new URL(location ?? '');

    expect(redirectUrl.origin + redirectUrl.pathname).toBe(
      'https://github.com/login/oauth/authorize'
    );
    expect(redirectUrl.searchParams.get('client_id')).toBe('github-client-id');
    expect(redirectUrl.searchParams.get('redirect_uri')).toBe(
      'http://localhost:3000/api/integrations/github/callback'
    );
    expect(redirectUrl.searchParams.get('state')).toBe('signed-state');
    expect(redirectUrl.searchParams.get('scope')).toBe('read:user');
    expect(mockedCreateGitHubBotLinkState).toHaveBeenCalledWith(USER_ID);
  });
});
