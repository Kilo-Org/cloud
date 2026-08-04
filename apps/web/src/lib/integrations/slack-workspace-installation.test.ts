const mockLimit = jest.fn();

jest.mock('@/lib/drizzle', () => ({
  db: {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(() => ({
          limit: mockLimit,
        })),
      })),
    })),
  },
}));

import type { PlatformIntegration } from '@kilocode/db/schema';
import { getSlackBotToken, getSlackTeamIdFromInstallation } from './slack-workspace-installation';

function buildIntegration(overrides: Record<string, unknown> = {}) {
  return {
    id: 'integration-1',
    platform: 'slack',
    platform_installation_id: 'T123',
    platform_account_id: 'T123',
    metadata: null,
    ...overrides,
  } as unknown as PlatformIntegration;
}

describe('getSlackTeamIdFromInstallation', () => {
  it('prefers the platform installation id', () => {
    expect(
      getSlackTeamIdFromInstallation(
        buildIntegration({ platform_installation_id: 'T123', platform_account_id: 'T456' })
      )
    ).toBe('T123');
  });

  it('falls back to the platform account id for detached rows', () => {
    expect(
      getSlackTeamIdFromInstallation(
        buildIntegration({ platform_installation_id: null, platform_account_id: 'T456' })
      )
    ).toBe('T456');
  });

  it('returns undefined when neither identifier is set', () => {
    expect(
      getSlackTeamIdFromInstallation(
        buildIntegration({ platform_installation_id: null, platform_account_id: null })
      )
    ).toBeUndefined();
  });
});

describe('getSlackBotToken', () => {
  beforeEach(() => {
    mockLimit.mockReset();
  });

  it('returns the token from the workspace installation', async () => {
    mockLimit.mockResolvedValue([{ team_id: 'T123', bot_token: 'xoxb-workspace' }]);

    await expect(getSlackBotToken(buildIntegration())).resolves.toBe('xoxb-workspace');
  });

  it('prefers the workspace installation over the legacy metadata copy', async () => {
    mockLimit.mockResolvedValue([{ team_id: 'T123', bot_token: 'xoxb-workspace' }]);

    await expect(
      getSlackBotToken(buildIntegration({ metadata: { access_token: 'xoxb-metadata' } }))
    ).resolves.toBe('xoxb-workspace');
  });

  it('falls back to the legacy metadata copy when no workspace installation exists', async () => {
    mockLimit.mockResolvedValue([]);

    await expect(
      getSlackBotToken(buildIntegration({ metadata: { access_token: 'xoxb-metadata' } }))
    ).resolves.toBe('xoxb-metadata');
  });

  it('falls back to metadata when the integration has no team id', async () => {
    await expect(
      getSlackBotToken(
        buildIntegration({
          platform_installation_id: null,
          platform_account_id: null,
          metadata: { access_token: 'xoxb-metadata' },
        })
      )
    ).resolves.toBe('xoxb-metadata');
    expect(mockLimit).not.toHaveBeenCalled();
  });

  it('returns undefined when neither source has a token', async () => {
    mockLimit.mockResolvedValue([]);

    await expect(getSlackBotToken(buildIntegration({ metadata: {} }))).resolves.toBeUndefined();
  });
});
