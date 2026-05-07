import { beforeEach, describe, expect, test } from '@jest/globals';
import { NextRequest, NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { verifyGitHubBotLinkState } from '@/lib/bot/github-link-state';
import { exchangeGitHubOAuthCode } from '@/lib/integrations/platforms/github/adapter';
import {
  consumeLinkAccountContext,
  linkKiloUser,
  readLinkAccountContext,
} from '@/lib/bot-identity';
import { bot } from '@/lib/bot';
import { reprocessLinkedMessage } from '@/lib/bot/run';
import { failureResult } from '@/lib/maybe-result';
import { findIntegrationByInstallationId } from '@/lib/integrations/db/platform-integrations';
import { isOrganizationMember } from '@/lib/organizations/organizations';
import type { SerializedMessage, SerializedThread, StateAdapter } from 'chat';

const mockState = { kind: 'state' } as unknown as StateAdapter;
const mockIsEnabledForBot = jest.fn();
const mockedAfter = jest.fn();

jest.mock('next/server', () => {
  const actual = jest.requireActual('next/server');
  return {
    ...actual,
    after: (fn: () => Promise<void> | void) => mockedAfter(fn),
  };
});
jest.mock('@/lib/user.server');
jest.mock('@/lib/bot/github-link-state');
jest.mock('@/lib/bot-identity');
jest.mock('@/lib/bot/run', () => ({
  reprocessLinkedMessage: jest.fn(async () => undefined),
}));
jest.mock('@/lib/integrations/platforms/github/adapter');
jest.mock('@/lib/bot', () => ({
  bot: {
    initialize: jest.fn(async () => undefined),
    getState: jest.fn(() => mockState),
  },
}));
jest.mock('@/lib/bot/platforms', () => ({
  botPlatforms: {
    require: jest.fn(() => ({ isEnabledForBot: mockIsEnabledForBot })),
  },
}));
jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation(() => ({
    apps: {
      getInstallation: jest.fn(),
      listReposAccessibleToInstallation: jest.fn(),
    },
  })),
}));
jest.mock('@octokit/auth-app', () => ({
  createAppAuth: jest.fn(),
}));
jest.mock('@/lib/integrations/platforms/github/app-selector', () => ({
  getGitHubAppTypeForOrganization: jest.fn(async () => 'standard'),
  getGitHubAppCredentials: jest.fn(() => ({
    appId: 'app-id',
    privateKey: 'private-key',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    appName: 'KiloConnect',
    webhookSecret: 'webhook-secret',
  })),
}));
jest.mock('@/routers/organizations/utils', () => ({
  ensureOrganizationAccess: jest.fn(),
}));
jest.mock('@/lib/integrations/db/platform-integrations', () => ({
  createPendingIntegration: jest.fn(),
  findIntegrationByInstallationId: jest.fn(),
  findPendingInstallationByRequesterId: jest.fn(),
  upsertPlatformIntegrationForOwner: jest.fn(),
}));
jest.mock('@/lib/organizations/organizations', () => ({
  isOrganizationMember: jest.fn(),
}));
jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));
jest.mock(
  'chat',
  () => ({
    Message: { fromJSON: jest.fn(value => value) },
    ThreadImpl: { fromJSON: jest.fn(value => value) },
  }),
  { virtual: true }
);

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedVerifyGitHubBotLinkState = jest.mocked(verifyGitHubBotLinkState);
const mockedExchangeGitHubOAuthCode = jest.mocked(exchangeGitHubOAuthCode);
const mockedLinkKiloUser = jest.mocked(linkKiloUser);
const mockedReadLinkAccountContext = jest.mocked(readLinkAccountContext);
const mockedConsumeLinkAccountContext = jest.mocked(consumeLinkAccountContext);
const mockedReprocessLinkedMessage = jest.mocked(reprocessLinkedMessage);
const mockedBot = jest.mocked(bot);
const mockedFindIntegrationByInstallationId = jest.mocked(findIntegrationByInstallationId);
const mockedIsOrganizationMember = jest.mocked(isOrganizationMember);

const USER_ID = '034489e8-19e0-4479-9d69-2edad719e847';
const OTHER_USER_ID = 'c00b91a1-6959-4b04-9ef8-e8d37b340f4a';
const GITHUB_USER_ID = '12345';
const INSTALLATION_ID = '98765';

function makeRequest(pathWithQuery: string) {
  return new NextRequest(`http://localhost:3000${pathWithQuery}`);
}

function expectRedirectLocation(response: Response, expectedPathWithQuery: string) {
  const location = response.headers.get('location');
  expect(location).toBeTruthy();
  const url = new URL(location ?? '');
  expect(`${url.pathname}${url.search}`).toBe(expectedPathWithQuery);
}

describe('GET /api/integrations/github/callback bot link flow', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    mockedGetUserFromAuth.mockResolvedValue({
      user: { id: USER_ID },
      authFailedResponse: null,
    } as never);
    mockedVerifyGitHubBotLinkState.mockReturnValue({
      userId: USER_ID,
      installationId: INSTALLATION_ID,
      callbackPath: '/github/link',
      contextKey: null,
    });
    mockedExchangeGitHubOAuthCode.mockResolvedValue({ id: GITHUB_USER_ID, login: 'octocat' });
    mockedFindIntegrationByInstallationId.mockResolvedValue({
      owned_by_organization_id: 'org_1',
      owned_by_user_id: null,
      github_app_type: 'standard',
      metadata: { bot_enabled: true },
    } as never);
    mockedIsOrganizationMember.mockResolvedValue(true);
    mockIsEnabledForBot.mockReturnValue(true);
    mockedReadLinkAccountContext.mockResolvedValue(null);
    mockedConsumeLinkAccountContext.mockResolvedValue(true);
  });

  test('redirects unauthenticated bot-link callbacks to existing callback auth fallback', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      user: null,
      authFailedResponse: NextResponse.json(failureResult('Unauthorized'), { status: 401 }),
    } as never);

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest('/api/integrations/github/callback?code=abc&state=signed') as never
    );

    expect(response.status).toBe(307);
    expectRedirectLocation(response, '/');
    expect(mockedLinkKiloUser).not.toHaveBeenCalled();
  });

  test('rejects invalid bot-link state without running installation callback logic', async () => {
    mockedVerifyGitHubBotLinkState.mockReturnValue(null);

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest('/api/integrations/github/callback?code=abc&state=bad') as never
    );

    expect(response.status).toBe(307);
    expectRedirectLocation(response, '/');
    expect(mockedExchangeGitHubOAuthCode).not.toHaveBeenCalled();
    expect(mockedLinkKiloUser).not.toHaveBeenCalled();
  });

  test('rejects bot-link state user mismatches', async () => {
    mockedVerifyGitHubBotLinkState.mockReturnValue({
      userId: OTHER_USER_ID,
      installationId: INSTALLATION_ID,
      callbackPath: '/github/link',
      contextKey: null,
    });

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest('/api/integrations/github/callback?code=abc&state=signed') as never
    );

    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toContain('started by another Kilo user');
    expect(mockedExchangeGitHubOAuthCode).not.toHaveBeenCalled();
    expect(mockedLinkKiloUser).not.toHaveBeenCalled();
  });

  test('rejects bot-link callbacks when the Kilo user cannot access the integration owner', async () => {
    mockedIsOrganizationMember.mockResolvedValue(false);

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest('/api/integrations/github/callback?code=abc&state=signed') as never
    );

    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toContain(
      'not a member of the organization that owns this GitHub integration'
    );
    expect(mockedFindIntegrationByInstallationId).toHaveBeenCalledWith('github', INSTALLATION_ID);
    expect(mockedExchangeGitHubOAuthCode).not.toHaveBeenCalled();
    expect(mockedLinkKiloUser).not.toHaveBeenCalled();
  });

  test('links the OAuth-verified GitHub user per installation', async () => {
    const { GET } = await import('./route');
    const response = await GET(
      makeRequest('/api/integrations/github/callback?code=abc&state=signed') as never
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain('GitHub account octocat has been linked');
    expect(mockedExchangeGitHubOAuthCode).toHaveBeenCalledWith('abc', 'standard');
    expect(mockedFindIntegrationByInstallationId).toHaveBeenCalledWith('github', INSTALLATION_ID);
    expect(mockedIsOrganizationMember).toHaveBeenCalledWith('org_1', USER_ID);
    expect(mockedBot.initialize).toHaveBeenCalled();
    expect(mockedLinkKiloUser).toHaveBeenCalledWith(
      mockState,
      { platform: 'github', teamId: INSTALLATION_ID, userId: GITHUB_USER_ID },
      USER_ID
    );
  });

  test("exchanges the OAuth code against the integration's github_app_type", async () => {
    mockedFindIntegrationByInstallationId.mockResolvedValue({
      owned_by_organization_id: 'org_1',
      owned_by_user_id: null,
      github_app_type: 'lite',
      metadata: { bot_enabled: true },
    } as never);

    const { GET } = await import('./route');
    await GET(makeRequest('/api/integrations/github/callback?code=abc&state=signed') as never);

    expect(mockedExchangeGitHubOAuthCode).toHaveBeenCalledWith('abc', 'lite');
  });

  test('replays the original mention when the link state carries a context key', async () => {
    const integration = {
      owned_by_organization_id: 'org_1',
      owned_by_user_id: null,
      github_app_type: 'standard',
      metadata: { bot_enabled: true },
    };
    const thread: SerializedThread = {
      _type: 'chat:Thread',
      adapterName: 'github',
      channelId: 'github:acme/widgets',
      id: 'github:acme/widgets:issue:42',
      isDM: false,
    };
    const message: SerializedMessage = {
      _type: 'chat:Message',
      attachments: [],
      author: {
        fullName: 'octocat',
        isBot: false,
        isMe: false,
        userId: '12345',
        userName: 'octocat',
      },
      formatted: { type: 'root', children: [] },
      id: 'm_1',
      metadata: { dateSent: '2026-05-05T07:32:52.000Z', edited: false },
      raw: {},
      text: '@kilocode fix this',
      threadId: 'github:acme/widgets:issue:42',
    };

    mockedFindIntegrationByInstallationId.mockResolvedValue(integration as never);
    mockedVerifyGitHubBotLinkState.mockReturnValue({
      userId: USER_ID,
      installationId: INSTALLATION_ID,
      callbackPath: '/github/link',
      contextKey: 'link-account-context:abc',
    });
    mockedReadLinkAccountContext.mockResolvedValue({ thread, message });
    mockedConsumeLinkAccountContext.mockResolvedValue(true);

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest('/api/integrations/github/callback?code=abc&state=signed') as never
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain('Kilo is already processing your message');
    expect(mockedLinkKiloUser).toHaveBeenCalled();
    expect(mockedReadLinkAccountContext).toHaveBeenCalledWith(
      mockState,
      'link-account-context:abc'
    );
    expect(mockedConsumeLinkAccountContext).toHaveBeenCalledWith(
      mockState,
      'link-account-context:abc'
    );
    expect(mockedAfter).toHaveBeenCalledTimes(1);
    const scheduled = mockedAfter.mock.calls[0][0] as () => Promise<void>;
    await scheduled();
    expect(mockedReprocessLinkedMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        platformIntegration: integration,
        thread,
        message,
        user: expect.objectContaining({ id: USER_ID }),
      })
    );
  });

  test('skips replay when the context was already consumed (duplicate OAuth callback)', async () => {
    mockedVerifyGitHubBotLinkState.mockReturnValue({
      userId: USER_ID,
      installationId: INSTALLATION_ID,
      callbackPath: '/github/link',
      contextKey: 'link-account-context:abc',
    });
    mockedReadLinkAccountContext.mockResolvedValue({
      thread: {
        _type: 'chat:Thread',
        adapterName: 'github',
        channelId: 'github:acme/widgets',
        id: 'github:acme/widgets:issue:42',
        isDM: false,
      },
      message: {
        _type: 'chat:Message',
        attachments: [],
        author: {
          fullName: 'octocat',
          isBot: false,
          isMe: false,
          userId: '12345',
          userName: 'octocat',
        },
        formatted: { type: 'root', children: [] },
        id: 'm_1',
        metadata: { dateSent: '2026-05-05T07:32:52.000Z', edited: false },
        raw: {},
        text: '@kilocode fix this',
        threadId: 'github:acme/widgets:issue:42',
      },
    });
    mockedConsumeLinkAccountContext.mockResolvedValue(false);

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest('/api/integrations/github/callback?code=abc&state=signed') as never
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain('mention Kilo again');
    expect(mockedAfter).not.toHaveBeenCalled();
  });

  test('rejects bot-link callbacks for integrations without bot_enabled metadata', async () => {
    mockedFindIntegrationByInstallationId.mockResolvedValue({
      owned_by_organization_id: 'org_1',
      owned_by_user_id: null,
      github_app_type: 'standard',
      metadata: null,
    } as never);
    mockIsEnabledForBot.mockReturnValue(false);

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest('/api/integrations/github/callback?code=abc&state=signed') as never
    );

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toContain(
      'GitHub linking is not enabled for this integration'
    );
    expect(mockedExchangeGitHubOAuthCode).not.toHaveBeenCalled();
    expect(mockedLinkKiloUser).not.toHaveBeenCalled();
  });
});
