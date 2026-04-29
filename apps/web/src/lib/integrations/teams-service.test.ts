process.env.NEXTAUTH_SECRET ||= 'test-nextauth-secret';
process.env.TURNSTILE_SECRET_KEY ||= 'test-turnstile-secret';

const mockLimit = jest.fn();
const mockInsertValues = jest.fn();
const mockInsertReturning = jest.fn();
const mockUpdateSet = jest.fn();
const mockUpdateWhere = jest.fn();
const mockUpdateReturning = jest.fn();

jest.mock('@/lib/drizzle', () => ({
  db: {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(() => ({
          limit: mockLimit,
        })),
      })),
    })),
    insert: jest.fn(() => ({
      values: mockInsertValues,
    })),
    update: jest.fn(() => ({
      set: mockUpdateSet,
    })),
  },
}));

jest.mock('@/lib/ai-gateway/kilo-auto', () => ({
  KILO_AUTO_FREE_MODEL: { id: 'kilo-auto' },
}));

jest.mock('@/lib/slack-bot/model-allow-list', () => ({
  getDefaultAllowedModel: jest.fn(async () => 'org-model'),
}));

import type { Owner } from '@/lib/integrations/core/types';
import { upsertTeamsInstallation } from './teams-service';

describe('teams-service upsertTeamsInstallation', () => {
  beforeEach(() => {
    mockLimit.mockReset();
    mockInsertValues.mockReset();
    mockInsertReturning.mockReset();
    mockUpdateSet.mockReset();
    mockUpdateWhere.mockReset();
    mockUpdateReturning.mockReset();

    mockInsertValues.mockReturnValue({ returning: mockInsertReturning });
    mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
    mockUpdateWhere.mockReturnValue({ returning: mockUpdateReturning });
  });

  it('creates a Teams platform integration for a user owner', async () => {
    const owner = { type: 'user', id: 'user-1' } satisfies Owner;
    const created = { id: 'teams-integration-1' };
    mockLimit.mockResolvedValue([]);
    mockInsertReturning.mockResolvedValue([created]);

    await expect(
      upsertTeamsInstallation({ owner, tenantId: 'tenant-1', tenantName: 'Acme' })
    ).resolves.toBe(created);

    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        owned_by_user_id: 'user-1',
        owned_by_organization_id: null,
        platform: 'teams',
        integration_type: 'app',
        platform_installation_id: 'tenant-1',
        platform_account_id: 'tenant-1',
        platform_account_login: 'Acme',
        integration_status: 'active',
        metadata: { model_slug: 'kilo-auto' },
      })
    );
  });

  it('updates an existing Teams integration and preserves its model', async () => {
    const owner = { type: 'org', id: 'org-1' } satisfies Owner;
    const updated = { id: 'teams-integration-1' };
    mockLimit.mockResolvedValue([
      { id: 'teams-integration-1', metadata: { model_slug: 'custom' } },
    ]);
    mockUpdateReturning.mockResolvedValue([updated]);

    await expect(
      upsertTeamsInstallation({ owner, tenantId: 'tenant-2', tenantName: 'Example Org' })
    ).resolves.toBe(updated);

    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        platform_installation_id: 'tenant-2',
        platform_account_id: 'tenant-2',
        platform_account_login: 'Example Org',
        integration_status: 'active',
        metadata: { model_slug: 'custom' },
      })
    );
  });
});
