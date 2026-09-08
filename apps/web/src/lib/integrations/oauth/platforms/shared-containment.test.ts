import { NextRequest } from 'next/server';

const mockAssertGitHubAutomationCanBeEnabled = jest.fn();
const mockVerifyOAuthState = jest.fn();
const mockExchangeSlackOAuthCode = jest.fn();
const mockSlackSetInstallation = jest.fn();
const mockSlackGetInstallation = jest.fn();
const mockSlackDeleteInstallation = jest.fn();
const mockExchangeLinearOAuthCode = jest.fn();
const mockFetchLinearOAuthIdentity = jest.fn();
const mockLinearSetInstallation = jest.fn();
const mockLinearGetInstallation = jest.fn();
const mockLinearDeleteInstallation = jest.fn();
const mockUpsertSlackInstallation = jest.fn();
const mockExchangeDiscordCode = jest.fn();
const mockUpsertDiscordInstallation = jest.fn();
const mockUpsertLinearInstallation = jest.fn();
const mockGetLinearInstallation = jest.fn();
const mockUnlinkTeamKiloUsers = jest.fn();
const mockWithChatInstallationLock = jest.fn();

jest.mock('@/lib/user/server', () => ({
  getUserFromAuth: jest.fn().mockResolvedValue({ user: { id: 'user-1' } }),
}));
jest.mock('@/routers/organizations/utils', () => ({ ensureOrganizationAccess: jest.fn() }));
jest.mock('@/lib/integrations/oauth-state', () => ({
  verifyOAuthState: (...args: unknown[]) => mockVerifyOAuthState(...args),
}));
jest.mock('@/lib/integrations/github/sharing-compatibility', () => ({
  assertGitHubAutomationCanBeEnabled: (...args: unknown[]) =>
    mockAssertGitHubAutomationCanBeEnabled(...args),
}));
jest.mock('@/lib/constants', () => ({ APP_URL: 'https://app.example.com' }));
jest.mock('@/lib/integrations/oauth/urls', () => ({
  getPlatformOAuthCallbackUrl: (platform: string) => `https://app.example.com/${platform}/callback`,
}));
jest.mock('@/lib/integrations/oauth/common', () => ({
  appendIntegrationOAuthRedirectQuery: (path: string) => path,
  buildIntegrationOAuthRedirectPath: () => '/integrations',
  buildIntegrationOAuthRedirectPathFromOwner: () => '/integrations',
  buildIntegrationOAuthRedirectPathFromState: () => '/integrations',
  parseOAuthStateOwner: () => ({ type: 'user', id: 'user-1' }),
}));
jest.mock('@/lib/integrations/slack-service', () => ({
  SlackWorkspaceAlreadyConnectedError: class SlackWorkspaceAlreadyConnectedError extends Error {},
  exchangeSlackOAuthCode: (...args: unknown[]) => mockExchangeSlackOAuthCode(...args),
  upsertSlackInstallation: (...args: unknown[]) => mockUpsertSlackInstallation(...args),
}));
jest.mock('@/lib/integrations/discord-service', () => ({
  exchangeDiscordCode: (...args: unknown[]) => mockExchangeDiscordCode(...args),
  upsertDiscordInstallation: (...args: unknown[]) => mockUpsertDiscordInstallation(...args),
}));
jest.mock('@/lib/integrations/linear-service', () => ({
  LinearWorkspaceAlreadyConnectedError: class LinearWorkspaceAlreadyConnectedError extends Error {},
  exchangeLinearOAuthCode: (...args: unknown[]) => mockExchangeLinearOAuthCode(...args),
  fetchLinearOAuthIdentity: (...args: unknown[]) => mockFetchLinearOAuthIdentity(...args),
  getInstallation: (...args: unknown[]) => mockGetLinearInstallation(...args),
  revokeLinearToken: jest.fn(),
  upsertLinearInstallation: (...args: unknown[]) => mockUpsertLinearInstallation(...args),
}));
jest.mock('@/lib/bot-identity', () => ({
  linkKiloUser: jest.fn(),
  unlinkTeamKiloUsers: (...args: unknown[]) => mockUnlinkTeamKiloUsers(...args),
}));
jest.mock('@/lib/bot/installation-lock', () => ({
  withChatInstallationLock: (...args: unknown[]) => mockWithChatInstallationLock(...args),
}));
jest.mock('@/lib/bot', () => ({
  bot: {
    initialize: jest.fn(),
    getState: jest.fn(() => ({})),
    getAdapter: (platform: string) =>
      platform === 'slack'
        ? {
            getInstallation: mockSlackGetInstallation,
            setInstallation: mockSlackSetInstallation,
            deleteInstallation: mockSlackDeleteInstallation,
          }
        : {
            getInstallation: mockLinearGetInstallation,
            setInstallation: mockLinearSetInstallation,
            deleteInstallation: mockLinearDeleteInstallation,
          },
  },
}));
jest.mock('@/lib/bot/platform-helpers', () => ({
  canKiloUserAccessPlatformIntegration: jest.fn(),
  getPlatformIntegrationById: jest.fn(),
}));
jest.mock('@/lib/bot/platforms', () => ({ botPlatforms: { require: jest.fn() } }));

import { handleSlackOAuthCallback } from './slack-callback';
import { handleDiscordOAuthCallback } from './discord-callback';
import { handleLinearOAuthCallback } from './linear-callback';

const request = (platform: string) =>
  new NextRequest(`https://app.example.com/${platform}/callback?code=code&state=state`);

describe('shared GitHub chat OAuth containment', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetLinearInstallation.mockReset();
    mockUpsertSlackInstallation.mockReset();
    mockUpsertSlackInstallation.mockResolvedValue(undefined);
    mockUpsertLinearInstallation.mockReset();
    mockUpsertLinearInstallation.mockResolvedValue(undefined);
    mockUpsertDiscordInstallation.mockReset();
    mockUpsertDiscordInstallation.mockResolvedValue(undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockVerifyOAuthState.mockReturnValue({ userId: 'user-1', owner: 'user_user-1' });
    mockAssertGitHubAutomationCanBeEnabled.mockResolvedValue(undefined);
    mockExchangeSlackOAuthCode.mockResolvedValue({
      teamId: 'T1',
      installation: { botToken: 'token' },
    });
    mockExchangeDiscordCode.mockResolvedValue({ guild: { id: '123', name: 'Guild' } });
    mockExchangeLinearOAuthCode.mockResolvedValue({
      accessToken: 'token',
      refreshToken: null,
      expiresIn: null,
    });
    mockFetchLinearOAuthIdentity.mockResolvedValue({
      organizationId: 'L1',
      organizationName: 'Workspace',
      viewerId: 'bot',
    });
    mockWithChatInstallationLock.mockImplementation(
      async (_state: unknown, _platform: string, _id: string, callback: () => Promise<unknown>) =>
        callback()
    );
    mockSlackGetInstallation.mockResolvedValue(null);
    mockLinearGetInstallation.mockResolvedValue(null);
    mockGetLinearInstallation.mockResolvedValue(null);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test.each([
    ['slack', handleSlackOAuthCallback, mockExchangeSlackOAuthCode],
    ['discord', handleDiscordOAuthCallback, mockExchangeDiscordCode],
    ['linear', handleLinearOAuthCallback, mockExchangeLinearOAuthCode],
  ] as const)('rejects %s before exchanging OAuth state', async (platform, handler, exchange) => {
    mockAssertGitHubAutomationCanBeEnabled.mockRejectedValue({ code: 'PRECONDITION_FAILED' });

    await handler(request(platform));

    expect(mockAssertGitHubAutomationCanBeEnabled).toHaveBeenCalledWith({
      type: 'user',
      id: 'user-1',
    });
    expect(exchange).not.toHaveBeenCalled();
  });

  it('removes Slack Chat SDK state when the transactional backstop loses the race', async () => {
    mockUpsertSlackInstallation.mockRejectedValue({ code: 'PRECONDITION_FAILED' });
    await handleSlackOAuthCallback(request('slack'));
    expect(mockSlackDeleteInstallation).toHaveBeenCalledWith('T1');
  });

  it('does not remove guild-global Discord bot membership on a rejected callback', async () => {
    mockUpsertDiscordInstallation.mockRejectedValue({ code: 'PRECONDITION_FAILED' });
    await handleDiscordOAuthCallback(request('discord'));
  });

  it('removes Linear Chat SDK and identity state when the backstop loses the race', async () => {
    mockUpsertLinearInstallation.mockRejectedValue({ code: 'PRECONDITION_FAILED' });
    await handleLinearOAuthCallback(request('linear'));
    expect(mockLinearDeleteInstallation).toHaveBeenCalledWith('L1');
    expect(mockUnlinkTeamKiloUsers).toHaveBeenCalled();
  });

  it('serializes state replacement and rejected cleanup inside one provider installation lock', async () => {
    const events: string[] = [];
    mockWithChatInstallationLock.mockImplementation(
      async (_state: unknown, platform: string, _id: string, callback: () => Promise<unknown>) => {
        events.push(`${platform}:enter`);
        const result = await callback();
        events.push(`${platform}:exit`);
        return result;
      }
    );
    mockSlackSetInstallation.mockImplementation(async () => {
      events.push('slack:set');
    });
    mockSlackDeleteInstallation.mockImplementation(async () => {
      events.push('slack:delete');
    });
    mockUpsertSlackInstallation.mockRejectedValue({ code: 'PRECONDITION_FAILED' });
    await handleSlackOAuthCallback(request('slack'));
    expect(events).toEqual(['slack:enter', 'slack:set', 'slack:delete', 'slack:exit']);
  });

  it('restores incumbent credentials before releasing the provider lock', async () => {
    const incumbent = { botToken: 'incumbent-token' };
    mockSlackGetInstallation.mockResolvedValue(incumbent);
    mockUpsertSlackInstallation.mockRejectedValue({ code: 'PRECONDITION_FAILED' });

    await handleSlackOAuthCallback(request('slack'));

    expect(mockSlackSetInstallation).toHaveBeenNthCalledWith(1, 'T1', { botToken: 'token' });
    expect(mockSlackSetInstallation).toHaveBeenNthCalledWith(2, 'T1', incumbent);
    expect(mockSlackDeleteInstallation).not.toHaveBeenCalled();
  });

  it('does not clean an old Linear workspace concurrently restored in the database', async () => {
    mockGetLinearInstallation
      .mockResolvedValueOnce({ platform_installation_id: 'OLD' })
      .mockResolvedValueOnce({ platform_installation_id: 'OLD' });

    await handleLinearOAuthCallback(request('linear'));

    expect(mockWithChatInstallationLock).toHaveBeenCalledWith(
      expect.anything(),
      'linear',
      'OLD',
      expect.any(Function)
    );
    expect(mockLinearDeleteInstallation).not.toHaveBeenCalledWith('OLD');
  });
});
