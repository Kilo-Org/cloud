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
import { getPlatformIntegration, getPlatformIntegrationByBotUserId } from './platform-helpers';

describe('platform helpers', () => {
  beforeEach(() => {
    mockLimit.mockReset();
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
});
