jest.mock('@/lib/bot', () => ({
  bot: {
    getAdapter: jest.fn(),
    initialize: jest.fn(),
    registerSingleton: jest.fn(),
  },
}));

import { PLATFORM } from '@/lib/integrations/core/constants';
import type { PlatformIntegration } from '@kilocode/db';
import { withBotPlatformAuthContext } from './platform-auth-context';

type MockBotModule = {
  bot: {
    getAdapter: jest.Mock;
    initialize: jest.Mock;
    registerSingleton: jest.Mock;
  };
};

const mockBotModule: MockBotModule = jest.requireMock('@/lib/bot');
let mockWithBotToken: jest.Mock;
let mockGetInstallation: jest.Mock;

function createPlatformIntegration(
  overrides: Partial<PlatformIntegration> = {}
): PlatformIntegration {
  return {
    id: 'pi_slack',
    owned_by_user_id: 'user_1',
    owned_by_organization_id: null,
    created_by_user_id: null,
    platform: PLATFORM.SLACK,
    integration_type: 'oauth',
    platform_installation_id: 'T123',
    platform_account_id: 'T123',
    platform_account_login: 'Test Workspace',
    permissions: null,
    integration_status: 'active',
    scopes: null,
    repository_access: null,
    repositories: null,
    repositories_synced_at: null,
    metadata: { access_token: 'xoxb-current' },
    kilo_requester_user_id: null,
    platform_requester_account_id: null,
    suspended_at: null,
    suspended_by: null,
    github_app_type: 'standard',
    installed_at: '2026-01-01T00:00:00.000Z',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('withBotPlatformAuthContext', () => {
  beforeEach(() => {
    mockWithBotToken = jest.fn(async (_token, fn) => await fn());
    mockGetInstallation = jest.fn();

    mockBotModule.bot.getAdapter.mockReset();
    mockBotModule.bot.initialize.mockReset();
    mockBotModule.bot.registerSingleton.mockReset();

    mockBotModule.bot.getAdapter.mockReturnValue({
      getInstallation: mockGetInstallation,
      withBotToken: mockWithBotToken,
    });
  });

  it('wraps Slack callbacks with the installation bot token', async () => {
    const fn = jest.fn(async () => 'result');
    mockGetInstallation.mockResolvedValue({ botToken: 'xoxb-stored' });

    const result = await withBotPlatformAuthContext(createPlatformIntegration(), fn);

    expect(result).toBe('result');
    expect(mockBotModule.bot.initialize).toHaveBeenCalledTimes(1);
    expect(mockBotModule.bot.registerSingleton).toHaveBeenCalledTimes(1);
    expect(mockBotModule.bot.getAdapter).toHaveBeenCalledWith(PLATFORM.SLACK);
    expect(mockGetInstallation).toHaveBeenCalledWith('T123');
    expect(mockWithBotToken).toHaveBeenCalledWith('xoxb-stored', expect.any(Function));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws when Slack installation is missing', async () => {
    mockGetInstallation.mockResolvedValue(null);

    await expect(
      withBotPlatformAuthContext(createPlatformIntegration({ metadata: {} }), async () => 'result')
    ).rejects.toThrow('No Slack installation for platform integration pi_slack');
  });

  it('runs non-Slack callbacks directly', async () => {
    const fn = jest.fn(async () => 'result');

    const result = await withBotPlatformAuthContext(
      createPlatformIntegration({
        id: 'pi_discord',
        platform: PLATFORM.DISCORD,
        metadata: {},
      }),
      fn
    );

    expect(result).toBe('result');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(mockBotModule.bot.getAdapter).not.toHaveBeenCalled();
    expect(mockWithBotToken).not.toHaveBeenCalled();
  });
});
