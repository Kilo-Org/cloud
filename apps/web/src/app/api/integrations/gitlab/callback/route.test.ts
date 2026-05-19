import { beforeEach, describe, expect, test } from '@jest/globals';
import { NextRequest } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { createGitLabOAuthState } from '@/lib/integrations/platforms/gitlab/oauth-state';
import { exchangeGitLabOAuthCode } from '@/lib/integrations/platforms/gitlab/adapter';

jest.mock('@/lib/user.server');
jest.mock('@/lib/drizzle', () => ({ db: {} }));
jest.mock('@/lib/integrations/gitlab-service', () => ({
  normalizeInstanceUrl: jest.fn(),
}));
jest.mock('@/routers/organizations/utils', () => ({
  ensureOrganizationAccess: jest.fn(),
}));
jest.mock('@/lib/agent-config/db/agent-configs', () => ({
  resetCodeReviewConfigForOwner: jest.fn(),
}));
jest.mock('@/lib/integrations/platforms/gitlab/adapter', () => ({
  exchangeGitLabOAuthCode: jest.fn(),
  fetchGitLabUser: jest.fn(),
  fetchGitLabProjects: jest.fn(),
  calculateTokenExpiry: jest.fn(),
}));
jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedExchangeGitLabOAuthCode = jest.mocked(exchangeGitLabOAuthCode);

const USER_ID = '034489e8-19e0-4479-9d69-2edad719e847';
const OTHER_USER_ID = 'c00b91a1-6959-4b04-9ef8-e8d37b340f4a';

function makeRequest(pathWithQuery: string) {
  return new NextRequest(`http://localhost:3000${pathWithQuery}`);
}

function expectRedirectLocation(response: Response, expectedPathWithQuery: string) {
  const location = response.headers.get('location');
  expect(location).toBeTruthy();
  const url = new URL(location ?? '');
  expect(`${url.pathname}${url.search}`).toBe(expectedPathWithQuery);
}

describe('GET /api/integrations/gitlab/callback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetUserFromAuth.mockResolvedValue({
      user: { id: USER_ID },
      authFailedResponse: null,
    } as never);
  });

  test('rejects attacker-controlled raw state before exchanging an OAuth code', async () => {
    const forgedState = `user_${USER_ID}|https://attacker.example`;
    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(
        `/api/integrations/gitlab/callback?code=anything&state=${encodeURIComponent(forgedState)}`
      )
    );

    expectRedirectLocation(response, '/integrations?error=invalid_state');
    expect(mockedExchangeGitLabOAuthCode).not.toHaveBeenCalled();
  });

  test('rejects a signed state created for a different user', async () => {
    const state = createGitLabOAuthState(
      {
        owner: { type: 'user', id: OTHER_USER_ID },
      },
      OTHER_USER_ID
    );
    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(
        `/api/integrations/gitlab/callback?code=anything&state=${encodeURIComponent(state)}`
      )
    );

    expectRedirectLocation(response, '/integrations?error=unauthorized');
    expect(mockedExchangeGitLabOAuthCode).not.toHaveBeenCalled();
  });

  test('uses verified GitLab state for missing-code redirects', async () => {
    const state = createGitLabOAuthState(
      {
        owner: { type: 'user', id: USER_ID },
        instanceUrl: 'https://gitlab.example.com',
        customCredentials: {
          clientId: 'self-hosted-client',
          clientSecret: 'self-hosted-secret',
        },
      },
      USER_ID
    );
    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(`/api/integrations/gitlab/callback?state=${encodeURIComponent(state)}`)
    );

    expectRedirectLocation(response, '/integrations/gitlab?error=missing_code');
    expect(mockedExchangeGitLabOAuthCode).not.toHaveBeenCalled();
  });
});
