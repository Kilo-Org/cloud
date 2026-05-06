const mockLimit = jest.fn();
const mockIsOrganizationMember = jest.fn();

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
jest.mock('@/lib/organizations/organizations', () => ({
  isOrganizationMember: (organizationId: string, kiloUserId: string) =>
    mockIsOrganizationMember(organizationId, kiloUserId),
}));

import { PLATFORM } from '@/lib/integrations/core/constants';
import {
  canKiloUserAccessPlatformIntegration,
  getPlatformIntegration,
  getPlatformIntegrationByBotUserId,
  getPlatformIntegrationById,
} from './platform-helpers';
import type { PlatformIntegration } from '@kilocode/db';

describe('platform helpers', () => {
  beforeEach(() => {
    mockLimit.mockReset();
    mockIsOrganizationMember.mockReset();
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

  describe('canKiloUserAccessPlatformIntegration', () => {
    it('allows access to user-owned integrations only for the owner', async () => {
      const integration = { owned_by_user_id: 'user-1' } as PlatformIntegration;

      await expect(canKiloUserAccessPlatformIntegration(integration, 'user-1')).resolves.toBe(true);
      await expect(canKiloUserAccessPlatformIntegration(integration, 'user-2')).resolves.toBe(
        false
      );
      expect(mockIsOrganizationMember).not.toHaveBeenCalled();
    });

    it('checks organization membership for org-owned integrations', async () => {
      const integration = { owned_by_organization_id: 'org-1' } as PlatformIntegration;
      mockIsOrganizationMember.mockResolvedValue(true);

      await expect(canKiloUserAccessPlatformIntegration(integration, 'user-1')).resolves.toBe(true);
      expect(mockIsOrganizationMember).toHaveBeenCalledWith('org-1', 'user-1');
    });

    it('denies integrations without ownership data', async () => {
      await expect(
        canKiloUserAccessPlatformIntegration({} as PlatformIntegration, 'user-1')
      ).resolves.toBe(false);
    });
  });
});
