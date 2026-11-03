const mockLimit = jest.fn();
const mockIsOrganizationMember = jest.fn();

jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
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
jest.mock('@kilocode/worker-utils/account-access', () => ({
  isOrganizationMember: (...args: unknown[]) => mockIsOrganizationMember(...args),
}));

import { INTEGRATION_STATUS, PLATFORM } from '@/lib/integrations/core/constants';
import {
  canKiloUserAccessPlatformIntegration,
  getPlatformIntegration,
  getPlatformIntegrationByBotUserId,
  getPlatformIntegrationById,
  PlatformIntegrationUnavailableError,
} from './platform-helpers';
import type { PlatformIntegration } from '@kilocode/db';

const HEALTHY_INTEGRATION = {
  integration_status: INTEGRATION_STATUS.ACTIVE,
  suspended_at: null,
  auth_invalid_at: null,
  github_disconnected_at: null,
} as const;

describe('platform helpers', () => {
  beforeEach(() => {
    mockLimit.mockReset();
    mockIsOrganizationMember.mockReset();
  });

  it('returns the platform integration for a given identity', async () => {
    const integration = {
      ...HEALTHY_INTEGRATION,
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

  it('returns null for a suspended integration', async () => {
    mockLimit.mockResolvedValue([
      {
        ...HEALTHY_INTEGRATION,
        id: 'pi_slack',
        platform: PLATFORM.SLACK,
        platform_installation_id: 'T123',
        integration_status: INTEGRATION_STATUS.SUSPENDED,
        suspended_at: '2026-10-01T00:00:00.000Z',
      },
    ]);

    const result = await getPlatformIntegration({
      platform: 'slack',
      teamId: 'T123',
      userId: 'U123',
    });

    expect(result).toBeNull();
  });

  it('returns null for an integration with invalid credentials', async () => {
    mockLimit.mockResolvedValue([
      {
        ...HEALTHY_INTEGRATION,
        id: 'pi_linear',
        platform: PLATFORM.LINEAR,
        platform_installation_id: 'linear-org-1',
        auth_invalid_at: '2026-10-01T00:00:00.000Z',
      },
    ]);

    const result = await getPlatformIntegration({
      platform: 'linear',
      teamId: 'linear-org-1',
      userId: 'linear-user-1',
    });

    expect(result).toBeNull();
  });

  it('returns a GitHub workflow integration that is healthy', async () => {
    const integration = {
      ...HEALTHY_INTEGRATION,
      id: 'pi_github',
      platform: PLATFORM.GITHUB,
      platform_installation_id: '42',
      github_connection_role: 'workflow',
    };
    mockLimit.mockResolvedValue([integration]);

    const result = await getPlatformIntegration({
      platform: 'github',
      teamId: '42',
      userId: 'github-user-1',
      githubAppType: 'standard',
    });

    expect(result).toBe(integration);
  });

  it('returns null for a GitHub integration that is not a workflow connection', async () => {
    mockLimit.mockResolvedValue([
      {
        ...HEALTHY_INTEGRATION,
        id: 'pi_github',
        platform: PLATFORM.GITHUB,
        platform_installation_id: '42',
        github_connection_role: 'agent_only',
      },
    ]);

    const result = await getPlatformIntegration({
      platform: 'github',
      teamId: '42',
      userId: 'github-user-1',
      githubAppType: 'standard',
    });

    expect(result).toBeNull();
  });

  it('returns the platform integration for a given id', async () => {
    const integration = {
      ...HEALTHY_INTEGRATION,
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

  it('throws an unavailable error for a suspended integration id', async () => {
    mockLimit.mockResolvedValue([
      {
        ...HEALTHY_INTEGRATION,
        id: 'pi_slack',
        platform: PLATFORM.SLACK,
        platform_installation_id: 'T123',
        integration_status: INTEGRATION_STATUS.SUSPENDED,
        suspended_at: '2026-10-01T00:00:00.000Z',
      },
    ]);

    await expect(getPlatformIntegrationById('pi_slack')).rejects.toThrow(
      PlatformIntegrationUnavailableError
    );
  });

  it('returns the platform integration for a bot user id', async () => {
    const integration = {
      ...HEALTHY_INTEGRATION,
      id: 'pi_slack',
      platform: PLATFORM.SLACK,
      metadata: { bot_user_id: 'U_BOT' },
    };
    mockLimit.mockResolvedValue([integration]);

    const result = await getPlatformIntegrationByBotUserId('slack', 'U_BOT');

    expect(result).toBe(integration);
  });

  it('returns null for a bot user id on a suspended integration', async () => {
    mockLimit.mockResolvedValue([
      {
        ...HEALTHY_INTEGRATION,
        id: 'pi_slack',
        platform: PLATFORM.SLACK,
        metadata: { bot_user_id: 'U_BOT' },
        integration_status: INTEGRATION_STATUS.SUSPENDED,
        suspended_at: '2026-10-01T00:00:00.000Z',
      },
    ]);

    const result = await getPlatformIntegrationByBotUserId('slack', 'U_BOT');

    expect(result).toBeNull();
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
      expect(mockIsOrganizationMember).toHaveBeenCalledWith(expect.anything(), 'org-1', 'user-1');
    });

    it('denies integrations without ownership data', async () => {
      await expect(
        canKiloUserAccessPlatformIntegration({} as PlatformIntegration, 'user-1')
      ).resolves.toBe(false);
    });
  });
});
