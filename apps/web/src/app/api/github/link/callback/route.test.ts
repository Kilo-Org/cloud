import { beforeEach, describe, expect, test } from '@jest/globals';
import { NextRequest, NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { verifyGitHubBotLinkState } from '@/lib/bot/github-link-state';
import { exchangeGitHubOAuthCode } from '@/lib/integrations/platforms/github/adapter';
import { githubUserIdentity, linkKiloUser } from '@/lib/bot-identity';
import { bot } from '@/lib/bot';
import { failureResult } from '@/lib/maybe-result';
import type { StateAdapter } from 'chat';

const mockState = { kind: 'state' } as unknown as StateAdapter;

jest.mock('@/lib/user.server');
jest.mock('@/lib/bot/github-link-state');
jest.mock('@/lib/bot-identity');
jest.mock('@/lib/integrations/platforms/github/adapter');
jest.mock('@/lib/bot', () => ({
  bot: {
    initialize: jest.fn(async () => undefined),
    getState: jest.fn(() => mockState),
  },
}));

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedVerifyGitHubBotLinkState = jest.mocked(verifyGitHubBotLinkState);
const mockedExchangeGitHubOAuthCode = jest.mocked(exchangeGitHubOAuthCode);
const mockedGithubUserIdentity = jest.mocked(githubUserIdentity);
const mockedLinkKiloUser = jest.mocked(linkKiloUser);
const mockedBot = jest.mocked(bot);

const USER_ID = '034489e8-19e0-4479-9d69-2edad719e847';
const OTHER_USER_ID = 'c00b91a1-6959-4b04-9ef8-e8d37b340f4a';
const GITHUB_USER_ID = '12345';

function makeRequest(pathWithQuery: string) {
  return new NextRequest(`http://localhost:3000${pathWithQuery}`);
}

function expectRedirectLocation(response: Response, expectedPathWithQuery: string) {
  const location = response.headers.get('location');
  expect(location).toBeTruthy();
  const url = new URL(location ?? '');
  expect(`${url.pathname}${url.search}`).toBe(expectedPathWithQuery);
}

describe('GET /api/github/link/callback', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    mockedGetUserFromAuth.mockResolvedValue({
      user: { id: USER_ID },
      authFailedResponse: null,
    } as never);
    mockedVerifyGitHubBotLinkState.mockReturnValue({
      userId: USER_ID,
      callbackPath: '/github/link',
    });
    mockedExchangeGitHubOAuthCode.mockResolvedValue({ id: GITHUB_USER_ID, login: 'octocat' });
    mockedGithubUserIdentity.mockReturnValue({
      platform: 'github',
      teamId: 'user',
      userId: GITHUB_USER_ID,
    });
  });

  test('redirects unauthenticated users to sign-in with callbackPath', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      user: null,
      authFailedResponse: NextResponse.json(failureResult('Unauthorized'), { status: 401 }),
    } as never);

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest('/api/github/link/callback?code=abc&state=signed') as never
    );

    expect(response.status).toBe(302);
    expectRedirectLocation(response, '/users/sign_in?callbackPath=%2Fgithub%2Flink');
    expect(mockedLinkKiloUser).not.toHaveBeenCalled();
  });

  test('rejects missing code', async () => {
    const { GET } = await import('./route');
    const response = await GET(makeRequest('/api/github/link/callback?state=signed') as never);

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain('Invalid or expired GitHub link request');
    expect(mockedExchangeGitHubOAuthCode).not.toHaveBeenCalled();
    expect(mockedLinkKiloUser).not.toHaveBeenCalled();
  });

  test('rejects invalid state', async () => {
    mockedVerifyGitHubBotLinkState.mockReturnValue(null);

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest('/api/github/link/callback?code=abc&state=bad') as never
    );

    expect(response.status).toBe(400);
    expect(mockedExchangeGitHubOAuthCode).not.toHaveBeenCalled();
    expect(mockedLinkKiloUser).not.toHaveBeenCalled();
  });

  test('rejects state user mismatches', async () => {
    mockedVerifyGitHubBotLinkState.mockReturnValue({
      userId: OTHER_USER_ID,
      callbackPath: '/github/link',
    });

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest('/api/github/link/callback?code=abc&state=signed') as never
    );

    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toContain('started by another Kilo user');
    expect(mockedExchangeGitHubOAuthCode).not.toHaveBeenCalled();
    expect(mockedLinkKiloUser).not.toHaveBeenCalled();
  });

  test('links the OAuth-verified GitHub user to the current Kilo user', async () => {
    const { GET } = await import('./route');
    const response = await GET(
      makeRequest('/api/github/link/callback?code=abc&state=signed') as never
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain('GitHub account octocat has been linked');
    expect(mockedExchangeGitHubOAuthCode).toHaveBeenCalledWith('abc', 'standard');
    expect(mockedGithubUserIdentity).toHaveBeenCalledWith(GITHUB_USER_ID);
    expect(mockedBot.initialize).toHaveBeenCalled();
    expect(mockedLinkKiloUser).toHaveBeenCalledWith(
      mockState,
      { platform: 'github', teamId: 'user', userId: GITHUB_USER_ID },
      USER_ID
    );
  });
});
