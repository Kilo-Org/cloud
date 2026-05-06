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

import { PLATFORM } from '@/lib/integrations/core/constants';
import {
  getBotDocumentationUrl,
  getGitHubRepositoryReference,
  getPlatformIdentity,
  getPlatformIntegration,
  getPlatformIntegrationByBotUserId,
  isGitHubRepositoryLinked,
  getPlatformIntegrationById,
  isGitHubBotEnabled,
} from './platform-helpers';
import type { PlatformIntegration } from '@kilocode/db';
import type { Thread, Message } from 'chat';

const mockGetInstallationId = jest.fn();

describe('platform helpers', () => {
  beforeEach(() => {
    mockLimit.mockReset();
    mockGetInstallationId.mockReset();
  });

  it('returns the platform integration for a given identity', async () => {
    const integration = {
      id: 'pi_slack',
      platform: PLATFORM.SLACK,
      platform_installation_id: 'T123',
    };
    mockLimit.mockResolvedValue([integration]);

    const result = await getPlatformIntegration({
      platform: 'slack',
      teamId: 'T123',
      userId: 'U123',
    });

    expect(result).toBe(integration);
  });

  it('returns null when no platform integration exists', async () => {
    mockLimit.mockResolvedValue([]);

    const result = await getPlatformIntegration({
      platform: 'slack',
      teamId: 'T404',
      userId: 'U123',
    });

    expect(result).toBeNull();
  });

  it('returns the platform integration for a given id', async () => {
    const integration = {
      id: 'pi_slack',
      platform: PLATFORM.SLACK,
      platform_installation_id: 'T123',
    };
    mockLimit.mockResolvedValue([integration]);

    const result = await getPlatformIntegrationById('pi_slack');

    expect(result).toBe(integration);
  });

  it('throws when no platform integration exists for an id', async () => {
    mockLimit.mockResolvedValue([]);

    await expect(getPlatformIntegrationById('pi_missing')).rejects.toThrow(
      'Could not find platform integration pi_missing'
    );
  });

  it('returns the platform integration for a bot user id', async () => {
    const integration = {
      id: 'pi_slack',
      platform: PLATFORM.SLACK,
      metadata: { bot_user_id: 'U_BOT' },
    };
    mockLimit.mockResolvedValue([integration]);

    const result = await getPlatformIntegrationByBotUserId('slack', 'U_BOT');

    expect(result).toBe(integration);
  });

  it('returns null when no bot user id is available', async () => {
    const result = await getPlatformIntegrationByBotUserId('slack', undefined);

    expect(result).toBeNull();
    expect(mockLimit).not.toHaveBeenCalled();
  });

  it('extracts GitHub identity from chat adapter messages', async () => {
    const message = {
      author: { userId: '12345' },
      raw: {
        type: 'issue_comment',
      },
    };
    mockGetInstallationId.mockResolvedValue(98765);

    const identity = await getPlatformIdentity(
      { adapter: { name: PLATFORM.GITHUB }, id: 'github:acme/widgets:42' } as Thread,
      message as Message,
      mockGetInstallationId
    );

    expect(mockGetInstallationId).toHaveBeenCalledWith({
      adapter: { name: PLATFORM.GITHUB },
      id: 'github:acme/widgets:42',
    });
    expect(identity).toEqual({
      platform: PLATFORM.GITHUB,
      teamId: '98765',
      userId: '12345',
    });
  });

  it('throws when the GitHub adapter cannot resolve the installation id', async () => {
    const message = {
      author: { userId: '12345' },
      raw: {
        type: 'issue_comment',
      },
    } as Message;
    mockGetInstallationId.mockResolvedValue(null);

    await expect(
      getPlatformIdentity(
        { adapter: { name: PLATFORM.GITHUB }, id: 'github:acme/widgets:42' } as Thread,
        message,
        mockGetInstallationId
      )
    ).rejects.toThrow('Could not find GitHub installation ID for thread github:acme/widgets:42');
  });

  describe('isGitHubBotEnabled', () => {
    function integrationWithMetadata(
      metadata: PlatformIntegration['metadata']
    ): PlatformIntegration {
      return { metadata } as PlatformIntegration;
    }

    it('returns true only when metadata.bot_enabled is the boolean true', () => {
      expect(isGitHubBotEnabled(integrationWithMetadata({ bot_enabled: true }))).toBe(true);
    });

    it('returns false when metadata is missing the flag', () => {
      expect(isGitHubBotEnabled(integrationWithMetadata({}))).toBe(false);
      expect(isGitHubBotEnabled(integrationWithMetadata(null))).toBe(false);
    });

    it('returns false for truthy non-boolean values to avoid accidental enables', () => {
      expect(isGitHubBotEnabled(integrationWithMetadata({ bot_enabled: 'true' }))).toBe(false);
      expect(isGitHubBotEnabled(integrationWithMetadata({ bot_enabled: 1 }))).toBe(false);
    });

    it('returns false when explicitly disabled', () => {
      expect(isGitHubBotEnabled(integrationWithMetadata({ bot_enabled: false }))).toBe(false);
    });
  });

  describe('getGitHubRepositoryReference', () => {
    it('uses GitHub webhook repository metadata when available', () => {
      const reference = getGitHubRepositoryReference(
        {
          adapter: { name: PLATFORM.GITHUB },
          channelId: 'github:acme/fallback',
          id: 'github:acme/fallback:42',
        } as Thread,
        {
          raw: {
            repository: {
              id: 123,
              full_name: 'acme/widgets',
            },
          },
        } as Message
      );

      expect(reference).toEqual({ id: 123, fullName: 'acme/widgets' });
    });

    it('falls back to the repository encoded in the GitHub thread id', () => {
      const reference = getGitHubRepositoryReference(
        {
          adapter: { name: PLATFORM.GITHUB },
          channelId: 'github:acme/widgets',
          id: 'github:acme/widgets:issue:42',
        } as Thread,
        { raw: {} } as Message
      );

      expect(reference).toEqual({ id: null, fullName: 'acme/widgets' });
    });

    it('falls back to the repository encoded in the GitHub channel id', () => {
      const reference = getGitHubRepositoryReference(
        {
          adapter: { name: PLATFORM.GITHUB },
          channelId: 'github:acme/widgets',
          id: 'github:malformed',
        } as Thread,
        { raw: {} } as Message
      );

      expect(reference).toEqual({ id: null, fullName: 'acme/widgets' });
    });
  });

  describe('isGitHubRepositoryLinked', () => {
    function integrationWithRepositoryAccess(
      repositoryAccess: PlatformIntegration['repository_access'],
      repositories: PlatformIntegration['repositories']
    ): PlatformIntegration {
      return { repository_access: repositoryAccess, repositories } as PlatformIntegration;
    }

    const selectedIntegration = integrationWithRepositoryAccess('selected', [
      { id: 123, name: 'widgets', full_name: 'acme/widgets', private: true },
    ]);

    it('allows all repositories when the integration has all repository access', () => {
      const integration = integrationWithRepositoryAccess('all', null);

      expect(isGitHubRepositoryLinked(integration, { id: null, fullName: 'acme/widgets' })).toBe(
        true
      );
    });

    it('allows selected repositories by id', () => {
      expect(isGitHubRepositoryLinked(selectedIntegration, { id: 123, fullName: null })).toBe(true);
    });

    it('allows selected repositories by case-insensitive full name', () => {
      expect(
        isGitHubRepositoryLinked(selectedIntegration, { id: null, fullName: 'ACME/Widgets' })
      ).toBe(true);
    });

    it('blocks repositories not selected for the installation', () => {
      expect(
        isGitHubRepositoryLinked(selectedIntegration, { id: 456, fullName: 'acme/other' })
      ).toBe(false);
    });

    it('blocks when repository access has not been synced yet', () => {
      const integration = integrationWithRepositoryAccess(null, null);

      expect(isGitHubRepositoryLinked(integration, { id: 123, fullName: 'acme/widgets' })).toBe(
        false
      );
    });

    it('blocks when the repository cannot be identified', () => {
      const integration = integrationWithRepositoryAccess('all', null);

      expect(isGitHubRepositoryLinked(integration, { id: null, fullName: null })).toBe(false);
    });
  });

  it('returns platform-specific bot documentation URLs', () => {
    expect(getBotDocumentationUrl(PLATFORM.SLACK)).toBe(
      'https://kilo.ai/docs/code-with-ai/platforms/slack'
    );
    expect(getBotDocumentationUrl(PLATFORM.GITHUB)).toBe(
      'https://kilo.ai/docs/code-with-ai/platforms/slack'
    );
    expect(getBotDocumentationUrl(PLATFORM.DISCORD)).toBe(
      'https://kilo.ai/docs/code-with-ai/platforms/slack'
    );
  });
});
