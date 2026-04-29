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
import { getPlatformIdentity, getPlatformIntegration } from './platform-helpers';

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

  it('extracts Teams identity from tenant metadata', () => {
    const result = getPlatformIdentity(
      { id: 'teams:conversation:service' } as Parameters<typeof getPlatformIdentity>[0],
      {
        raw: {
          conversation: { tenantId: 'tenant-1' },
          channelData: { team: { name: 'Example Team' } },
        },
        author: { userId: '29:user' },
      } as Parameters<typeof getPlatformIdentity>[1]
    );

    expect(result).toEqual({
      platform: 'teams',
      teamId: 'tenant-1',
      userId: '29:user',
      teamName: 'Example Team',
    });
  });

  it('returns the canonical Teams platform integration for a Teams tenant', async () => {
    const integration = {
      id: 'pi_teams',
      platform: PLATFORM.TEAMS,
      platform_installation_id: 'tenant-1',
    };
    mockLimit.mockResolvedValue([integration]);

    const result = await getPlatformIntegration(
      { id: 'teams:conversation:service' } as Parameters<typeof getPlatformIntegration>[0],
      {
        raw: { channelData: { tenant: { id: 'tenant-1' } } },
        author: { userId: '29:user' },
      } as Parameters<typeof getPlatformIntegration>[1]
    );

    expect(result).toBe(integration);
  });
});
