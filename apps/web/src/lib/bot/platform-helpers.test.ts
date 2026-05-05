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
  getPlatformIdentity,
  getPlatformIntegration,
  getPlatformIntegrationByBotUserId,
  getPlatformIntegrationById,
  getPlatformUserIdentity,
} from './platform-helpers';
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

  it('converts GitHub installation identities to user-level identities for user lookup', () => {
    expect(
      getPlatformUserIdentity({ platform: PLATFORM.GITHUB, teamId: '98765', userId: '12345' })
    ).toEqual({
      platform: PLATFORM.GITHUB,
      teamId: 'user',
      userId: '12345',
    });
  });

  it('keeps Slack identities installation-scoped for user lookup', () => {
    const identity = { platform: PLATFORM.SLACK, teamId: 'T123', userId: 'U123' };

    expect(getPlatformUserIdentity(identity)).toBe(identity);
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
