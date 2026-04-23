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
import { getPlatformIntegration } from './platform-helpers';

describe('platform helpers', () => {
  beforeEach(() => {
    mockLimit.mockReset();
  });

  it('returns the canonical Slack platform integration for a Slack team', async () => {
    const integration = {
      id: 'pi_slack',
      platform: PLATFORM.SLACK,
      platform_installation_id: 'T123',
    };
    mockLimit.mockResolvedValue([integration]);

    const result = await getPlatformIntegration(
      { id: 'slack:C123:123.456' } as Parameters<typeof getPlatformIntegration>[0],
      {
        raw: { team_id: 'T123' },
        author: { userId: 'U123' },
      } as Parameters<typeof getPlatformIntegration>[1]
    );

    expect(result).toBe(integration);
  });

  it('returns null when no canonical Slack platform integration exists', async () => {
    mockLimit.mockResolvedValue([]);

    const result = await getPlatformIntegration(
      { id: 'slack:C123:123.456' } as Parameters<typeof getPlatformIntegration>[0],
      {
        raw: { team_id: 'T404' },
        author: { userId: 'U123' },
      } as Parameters<typeof getPlatformIntegration>[1]
    );

    expect(result).toBeNull();
  });
});
