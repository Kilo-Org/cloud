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
const mockGetSlackInstallation = jest.fn();
const mockRevokeSlackBotToken = jest.fn();
const mockExchangeDiscordCode = jest.fn();
const mockUpsertDiscordInstallation = jest.fn();
const mockUpsertLinearInstallation = jest.fn();
const mockGetLinearInstallation = jest.fn();
const mockUnlinkTeamKiloUsers = jest.fn();
const mockCleanupProviderInstallationIfUnclaimed = jest.fn();

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
  getInstallation: (...args: unknown[]) => mockGetSlackInstallation(...args),
  revokeSlackBotToken: (...args: unknown[]) => mockRevokeSlackBotToken(...args),
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
jest.mock('@/lib/integrations/provider-installation-lock', () => ({
  cleanupProviderInstallationIfUnclaimed: (...args: unknown[]) =>
    mockCleanupProviderInstallationIfUnclaimed(...args),
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
    mockGetSlackInstallation.mockReset();
    mockUpsertSlackInstallation.mockReset();
    mockUpsertSlackInstallation.mockImplementation(async input => input.persistInstallation?.());
    mockUpsertLinearInstallation.mockReset();
    mockUpsertLinearInstallation.mockImplementation(async (_input, options) =>
      options?.persistInstallation?.()
    );
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
    mockCleanupProviderInstallationIfUnclaimed.mockResolvedValue(true);
    mockSlackGetInstallation.mockResolvedValue(null);
    mockLinearGetInstallation.mockResolvedValue(null);
    mockGetLinearInstallation.mockResolvedValue(null);
    mockGetSlackInstallation.mockResolvedValue(null);
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

  it('does not persist Slack state when the transactional backstop rejects admission', async () => {
    mockUpsertSlackInstallation.mockRejectedValue({ code: 'PRECONDITION_FAILED' });
    await handleSlackOAuthCallback(request('slack'));
    expect(mockSlackSetInstallation).not.toHaveBeenCalled();
  });

  it('does not remove guild-global Discord bot membership on a rejected callback', async () => {
    mockUpsertDiscordInstallation.mockRejectedValue({ code: 'PRECONDITION_FAILED' });
    await handleDiscordOAuthCallback(request('discord'));
  });

  it('does not persist Linear state when the backstop loses the race', async () => {
    mockUpsertLinearInstallation.mockRejectedValue({ code: 'PRECONDITION_FAILED' });
    await handleLinearOAuthCallback(request('linear'));
    expect(mockLinearSetInstallation).not.toHaveBeenCalled();
  });

  it('passes Slack state persistence into the serialized database admission', async () => {
    await handleSlackOAuthCallback(request('slack'));
    expect(mockSlackSetInstallation).toHaveBeenCalledWith('T1', { botToken: 'token' });
  });

  it('does not clean an old Linear workspace concurrently restored in the database', async () => {
    mockGetLinearInstallation.mockResolvedValueOnce({ platform_installation_id: 'OLD' });
    mockCleanupProviderInstallationIfUnclaimed.mockResolvedValue(false);

    await handleLinearOAuthCallback(request('linear'));

    expect(mockCleanupProviderInstallationIfUnclaimed).toHaveBeenCalledWith(
      expect.objectContaining({ platform: 'linear', installationId: 'OLD' })
    );
    expect(mockLinearDeleteInstallation).not.toHaveBeenCalledWith('OLD');
  });

  it('does not clean an old Slack team claimed by another owner', async () => {
    mockGetSlackInstallation.mockResolvedValueOnce({ platform_installation_id: 'OLD' });
    mockCleanupProviderInstallationIfUnclaimed.mockResolvedValue(false);

    await handleSlackOAuthCallback(request('slack'));

    expect(mockCleanupProviderInstallationIfUnclaimed).toHaveBeenCalledWith(
      expect.objectContaining({ platform: 'slack', installationId: 'OLD' })
    );
    expect(mockRevokeSlackBotToken).not.toHaveBeenCalled();
    expect(mockSlackDeleteInstallation).not.toHaveBeenCalledWith('OLD');
  });
});
