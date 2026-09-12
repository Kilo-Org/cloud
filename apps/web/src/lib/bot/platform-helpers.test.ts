const mockLimit = jest.fn();
const mockIsOrganizationMember = jest.fn();
const mockOwnerHasSharedGitHubInstallation = jest.fn();

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
jest.mock('@/lib/integrations/provider-oauth-attempts', () => ({
  ownerHasSharedGitHubInstallation: (...args: unknown[]) =>
    mockOwnerHasSharedGitHubInstallation(...args),
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
    mockOwnerHasSharedGitHubInstallation.mockReset();
    mockOwnerHasSharedGitHubInstallation.mockResolvedValue(false);
  });

  it('requires an exact reservation for a shared Slack owner', async () => {
    const integration = {
      id: 'pi_shared',
      platform: PLATFORM.SLACK,
      integration_status: 'active',
      platform_installation_id: 'T_SHARED',
      owned_by_user_id: 'user-1',
    };
    mockOwnerHasSharedGitHubInstallation.mockResolvedValue(true);
    mockLimit.mockResolvedValueOnce([integration]).mockResolvedValueOnce([]);

    await expect(
      getPlatformIntegration({ platform: 'slack', teamId: 'T_SHARED', userId: 'U1' })
    ).resolves.toBeNull();
  });

  it('returns the platform integration for a given identity', async () => {
    const integration = {
      id: 'pi_slack',
      platform: PLATFORM.SLACK,
      integration_status: 'active',
      platform_installation_id: 'T123',
      owned_by_user_id: 'user-1',
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
      integration_status: 'active',
      platform_installation_id: 'T123',
      owned_by_user_id: 'user-1',
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
      integration_status: 'active',
      metadata: { bot_user_id: 'U_BOT' },
      platform_installation_id: 'T123',
      owned_by_user_id: 'user-1',
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
