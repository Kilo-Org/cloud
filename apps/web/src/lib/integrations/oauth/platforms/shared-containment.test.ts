import { NextRequest } from 'next/server';

const mockAssertGitHubAutomationCanBeEnabled = jest.fn();
const mockVerifyOAuthState = jest.fn();
const mockSlackHandleOAuthCallback = jest.fn();
const mockSlackDeleteInstallation = jest.fn();
const mockSlackGetInstallation = jest.fn();
const mockLinearHandleOAuthCallback = jest.fn();
const mockLinearDeleteInstallation = jest.fn();
const mockLinearGetInstallation = jest.fn();
const mockUpsertSlackInstallation = jest.fn();
const mockExchangeDiscordCode = jest.fn();
const mockUpsertDiscordInstallation = jest.fn();
const mockCleanupRejectedDiscordGuild = jest.fn();
const mockUpsertLinearInstallation = jest.fn();
const mockUnlinkTeamKiloUsers = jest.fn();

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
  upsertSlackInstallation: (...args: unknown[]) => mockUpsertSlackInstallation(...args),
}));
jest.mock('@/lib/integrations/discord-service', () => ({
  exchangeDiscordCode: (...args: unknown[]) => mockExchangeDiscordCode(...args),
  upsertDiscordInstallation: (...args: unknown[]) => mockUpsertDiscordInstallation(...args),
  cleanupRejectedDiscordGuild: (...args: unknown[]) => mockCleanupRejectedDiscordGuild(...args),
}));
jest.mock('@/lib/integrations/linear-service', () => ({
  LINEAR_REDIRECT_URI: 'https://app.example.com/linear/callback',
  LinearWorkspaceAlreadyConnectedError: class LinearWorkspaceAlreadyConnectedError extends Error {},
  exchangeLinearOAuthCode: jest.fn(),
  fetchLinearOAuthIdentity: jest.fn(),
  revokeLinearToken: jest.fn(),
  upsertLinearInstallation: (...args: unknown[]) => mockUpsertLinearInstallation(...args),
}));
jest.mock('@/lib/bot-identity', () => ({
  linkKiloUser: jest.fn(),
  unlinkTeamKiloUsers: (...args: unknown[]) => mockUnlinkTeamKiloUsers(...args),
}));
jest.mock('@linear/sdk', () => ({
  LinearClient: class LinearClient {
    organization = Promise.resolve({ name: 'Workspace' });
  },
}));
jest.mock('@/lib/bot', () => ({
  bot: {
    initialize: jest.fn(),
    getState: jest.fn(() => ({})),
    getAdapter: (platform: string) =>
      platform === 'slack'
        ? {
            handleOAuthCallback: mockSlackHandleOAuthCallback,
            getInstallation: mockSlackGetInstallation,
            deleteInstallation: mockSlackDeleteInstallation,
          }
        : {
            handleOAuthCallback: mockLinearHandleOAuthCallback,
            getInstallation: mockLinearGetInstallation,
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
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockVerifyOAuthState.mockReturnValue({ userId: 'user-1', owner: 'user_user-1' });
    mockAssertGitHubAutomationCanBeEnabled.mockResolvedValue(undefined);
    mockSlackHandleOAuthCallback.mockResolvedValue({
      teamId: 'T1',
      installation: { botToken: 'token' },
    });
    mockExchangeDiscordCode.mockResolvedValue({ guild: { id: '123', name: 'Guild' } });
    mockLinearHandleOAuthCallback.mockResolvedValue({
      organizationId: 'L1',
      installation: { accessToken: 'token', botUserId: 'bot' },
    });
    mockSlackGetInstallation.mockResolvedValue({ botToken: 'token' });
    mockLinearGetInstallation.mockResolvedValue({ accessToken: 'token' });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test.each([
    ['slack', handleSlackOAuthCallback, mockSlackHandleOAuthCallback],
    ['discord', handleDiscordOAuthCallback, mockExchangeDiscordCode],
    ['linear', handleLinearOAuthCallback, mockLinearHandleOAuthCallback],
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

  it('removes the Discord bot when the transactional backstop loses the race', async () => {
    mockUpsertDiscordInstallation.mockRejectedValue({ code: 'PRECONDITION_FAILED' });
    await handleDiscordOAuthCallback(request('discord'));
    expect(mockCleanupRejectedDiscordGuild).toHaveBeenCalledWith('123');
  });

  it('removes Linear Chat SDK and identity state when the backstop loses the race', async () => {
    mockUpsertLinearInstallation.mockRejectedValue({ code: 'PRECONDITION_FAILED' });
    await handleLinearOAuthCallback(request('linear'));
    expect(mockLinearDeleteInstallation).toHaveBeenCalledWith('L1');
    expect(mockUnlinkTeamKiloUsers).toHaveBeenCalled();
  });

  it('does not delete Chat SDK state replaced by a concurrent successful callback', async () => {
    mockUpsertSlackInstallation.mockRejectedValue({ code: 'PRECONDITION_FAILED' });
    mockSlackGetInstallation.mockResolvedValue({ botToken: 'newer-token' });
    await handleSlackOAuthCallback(request('slack'));
    expect(mockSlackDeleteInstallation).not.toHaveBeenCalled();

    mockUpsertLinearInstallation.mockRejectedValue({ code: 'PRECONDITION_FAILED' });
    mockLinearGetInstallation.mockResolvedValue({ accessToken: 'newer-token' });
    await handleLinearOAuthCallback(request('linear'));
    expect(mockLinearDeleteInstallation).not.toHaveBeenCalled();
  });
});
