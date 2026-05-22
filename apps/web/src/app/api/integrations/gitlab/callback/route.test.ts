import { beforeEach, describe, expect, test } from '@jest/globals';
import { NextRequest } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { createGitLabOAuthState } from '@/lib/integrations/platforms/gitlab/oauth-state';
import { createGitLabBotLinkState } from '@/lib/bot/gitlab-link-state';
import { linkKiloUser } from '@/lib/bot-identity';
import {
  canKiloUserAccessPlatformIntegration,
  getPlatformIntegrationById,
} from '@/lib/bot/platform-helpers';
import {
  exchangeGitLabOAuthCode,
  fetchGitLabUser,
} from '@/lib/integrations/platforms/gitlab/adapter';
import { getGitLabOAuthCredentials } from '@/lib/integrations/platforms/gitlab/oauth-credentials';
import { PLATFORM } from '@/lib/integrations/core/constants';
import type { StateAdapter } from 'chat';

const mockIsEnabledForBot = jest.fn();
const mockBotInitialize = jest.fn();
const mockState = { state: true } as unknown as StateAdapter;
const mockBotGetState = jest.fn(() => mockState);

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
jest.mock('@/lib/bot/platform-helpers', () => ({
  canKiloUserAccessPlatformIntegration: jest.fn(),
  getPlatformIntegrationById: jest.fn(),
}));
jest.mock('@/lib/bot/platforms', () => ({
  botPlatforms: {
    require: jest.fn(() => ({ isEnabledForBot: mockIsEnabledForBot })),
  },
}));
jest.mock('@/lib/bot', () => ({
  bot: {
    initialize: (...args: unknown[]) => mockBotInitialize(...args),
    getState: () => mockBotGetState(),
  },
}));
jest.mock('@/lib/bot-identity', () => ({
  linkKiloUser: jest.fn(),
}));
jest.mock('@/lib/integrations/platforms/gitlab/oauth-credentials', () => ({
  getGitLabOAuthCredentials: jest.fn(),
}));
jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedExchangeGitLabOAuthCode = jest.mocked(exchangeGitLabOAuthCode);
const mockedFetchGitLabUser = jest.mocked(fetchGitLabUser);
const mockedGetGitLabOAuthCredentials = jest.mocked(getGitLabOAuthCredentials);
const mockedGetPlatformIntegrationById = jest.mocked(getPlatformIntegrationById);
const mockedCanKiloUserAccessPlatformIntegration = jest.mocked(
  canKiloUserAccessPlatformIntegration
);
const mockedLinkKiloUser = jest.mocked(linkKiloUser);

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
    mockedGetGitLabOAuthCredentials.mockResolvedValue(null);
    mockedGetPlatformIntegrationById.mockResolvedValue({
      id: 'pi_gitlab_1',
      platform: PLATFORM.GITLAB,
      metadata: { bot_enabled: true, gitlab_instance_url: 'https://gitlab.example.com' },
    } as never);
    mockedCanKiloUserAccessPlatformIntegration.mockResolvedValue(true);
    mockIsEnabledForBot.mockReturnValue(true);
    mockedExchangeGitLabOAuthCode.mockResolvedValue({
      access_token: 'gitlab-oauth-token',
    } as never);
    mockedFetchGitLabUser.mockResolvedValue({
      id: 123,
      username: 'rso',
      name: 'RSO',
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
        customCredentialsRef: 'cached-credentials-ref',
      },
      USER_ID
    );
    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(`/api/integrations/gitlab/callback?state=${encodeURIComponent(state)}`)
    );

    expectRedirectLocation(response, '/integrations/gitlab?error=missing_code');
    expect(mockedGetGitLabOAuthCredentials).not.toHaveBeenCalled();
    expect(mockedExchangeGitLabOAuthCode).not.toHaveBeenCalled();
  });

  test('rejects callback exchange when cached custom OAuth credentials have expired', async () => {
    const state = createGitLabOAuthState(
      {
        owner: { type: 'user', id: USER_ID },
        instanceUrl: 'https://gitlab.example.com',
        customCredentialsRef: 'expired-credentials-ref',
      },
      USER_ID
    );
    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(
        `/api/integrations/gitlab/callback?code=anything&state=${encodeURIComponent(state)}`
      )
    );

    expectRedirectLocation(response, '/integrations/gitlab?error=connection_failed');
    expect(mockedGetGitLabOAuthCredentials).toHaveBeenCalledWith('expired-credentials-ref');
    expect(mockedExchangeGitLabOAuthCode).not.toHaveBeenCalled();
  });

  test('loads cached custom OAuth credentials before the code exchange', async () => {
    mockedGetGitLabOAuthCredentials.mockResolvedValue({
      clientId: 'self-hosted-client',
      clientSecret: 'self-hosted-secret',
    });
    mockedExchangeGitLabOAuthCode.mockRejectedValueOnce(new Error('stop after exchange'));

    const state = createGitLabOAuthState(
      {
        owner: { type: 'user', id: USER_ID },
        instanceUrl: 'https://gitlab.example.com',
        customCredentialsRef: 'cached-credentials-ref',
      },
      USER_ID
    );
    const { GET } = await import('./route');
    await GET(
      makeRequest(
        `/api/integrations/gitlab/callback?code=anything&state=${encodeURIComponent(state)}`
      )
    );

    expect(mockedExchangeGitLabOAuthCode).toHaveBeenCalledWith(
      'anything',
      'https://gitlab.example.com',
      {
        clientId: 'self-hosted-client',
        clientSecret: 'self-hosted-secret',
      }
    );
  });

  test('links a GitLab user for bot-link callbacks without running install flow', async () => {
    const state = createGitLabBotLinkState({
      userId: USER_ID,
      platformIntegrationId: 'pi_gitlab_1',
    });
    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(
        `/api/integrations/gitlab/callback?code=anything&state=${encodeURIComponent(state)}`
      )
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain('GitLab account linked');
    expect(mockedExchangeGitLabOAuthCode).toHaveBeenCalledWith(
      'anything',
      'https://gitlab.example.com',
      undefined
    );
    expect(mockedFetchGitLabUser).toHaveBeenCalledWith(
      'gitlab-oauth-token',
      'https://gitlab.example.com'
    );
    expect(mockedLinkKiloUser).toHaveBeenCalledWith(
      mockState,
      {
        platform: PLATFORM.GITLAB,
        teamId: 'pi_gitlab_1',
        userId: '123',
      },
      USER_ID
    );
  });
});
