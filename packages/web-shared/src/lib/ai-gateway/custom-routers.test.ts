import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { auto_routing_custom_routers, type User } from '@kilocode/db/schema';
import { getAutoRoutingSettings } from '@kilocode/web-shared/lib/ai-gateway/auto-routing-admin-client';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { findEffectiveLegacyPoolRouter, listUsableCustomRouters } from './custom-routers';

jest.mock('@kilocode/web-shared/lib/ai-gateway/auto-routing-admin-client', () => ({
  getAutoRoutingSettings: jest.fn(),
}));

const MODEL = 'openai/test-pool-model';
const DEFINITION = {
  slug: 'efficient',
  name: 'Efficient',
  base_router: 'efficient' as const,
  mode: 'best_accuracy' as const,
  entries: [{ kind: 'gateway' as const, model: MODEL }],
  default_entry_key: `gateway:${MODEL}`,
  legacy_pool: true,
};

describe('canonical legacy pool discovery', () => {
  let user: User;

  beforeEach(async () => {
    jest.resetAllMocks();
    user = await insertTestUser();
  });

  afterEach(async () => {
    await cleanupDbForTest();
  });

  test('lists every personal and organization router, migrated or not', async () => {
    const organization = await createTestOrganization('Owner', user.id, 0);
    await db.insert(auto_routing_custom_routers).values([
      { ...DEFINITION, owned_by_user_id: user.id },
      { ...DEFINITION, owned_by_user_id: user.id, slug: 'other', legacy_pool: false },
      {
        ...DEFINITION,
        owned_by_organization_id: organization.id,
        slug: 'team',
        legacy_pool: false,
      },
    ]);

    const routers = await listUsableCustomRouters({
      userId: user.id,
      organizationId: organization.id,
    });
    expect(routers.map(router => `${router.ownerType}:${router.slug}`).sort()).toEqual([
      'org:team',
      'user:efficient',
      'user:other',
    ]);
  });

  test('the organization canonical pool takes priority over the personal canonical pool', async () => {
    const organization = await createTestOrganization('Migrated', user.id, 0);
    await db.insert(auto_routing_custom_routers).values([
      { ...DEFINITION, owned_by_user_id: user.id },
      { ...DEFINITION, owned_by_organization_id: organization.id },
    ]);

    await expect(
      findEffectiveLegacyPoolRouter({ userId: user.id, organizationId: organization.id })
    ).resolves.toMatchObject({
      ownerType: 'org',
      ownerId: organization.id,
    });
    expect(getAutoRoutingSettings).not.toHaveBeenCalled();
  });

  test('an unmigrated organization pool still takes priority over a personal canonical pool', async () => {
    const organization = await createTestOrganization('Unmigrated', user.id, 0);
    await db
      .insert(auto_routing_custom_routers)
      .values({ ...DEFINITION, owned_by_user_id: user.id });
    jest.mocked(getAutoRoutingSettings).mockResolvedValue({
      status: 200,
      body: {
        ownerType: 'org',
        ownerId: organization.id,
        mode: 'cost_per_accuracy',
        configuredMode: null,
        defaultMode: 'cost_per_accuracy',
        configuredPool: [{ model: 'google/organization-pool-model' }],
        poolStatuses: [],
      },
    });

    await expect(
      findEffectiveLegacyPoolRouter({ userId: user.id, organizationId: organization.id })
    ).resolves.toBeNull();
  });

  test('an organization mode-only setting does not replace the personal canonical pool', async () => {
    const organization = await createTestOrganization('Mode only', user.id, 0);
    await db
      .insert(auto_routing_custom_routers)
      .values({ ...DEFINITION, owned_by_user_id: user.id });
    jest.mocked(getAutoRoutingSettings).mockResolvedValue({
      status: 200,
      body: {
        ownerType: 'org',
        ownerId: organization.id,
        mode: 'cost_per_accuracy',
        configuredMode: 'cost_per_accuracy',
        defaultMode: 'cost_per_accuracy',
        configuredPool: null,
        poolStatuses: [],
      },
    });

    await expect(
      findEffectiveLegacyPoolRouter({ userId: user.id, organizationId: organization.id })
    ).resolves.toMatchObject({ ownerType: 'user', ownerId: user.id });
  });

  test('an unavailable organization settings read never silently selects the personal pool', async () => {
    const organization = await createTestOrganization('Unavailable', user.id, 0);
    await db
      .insert(auto_routing_custom_routers)
      .values({ ...DEFINITION, owned_by_user_id: user.id });
    jest
      .mocked(getAutoRoutingSettings)
      .mockResolvedValue({ status: 500, body: { error: 'unavailable' } });

    await expect(
      findEffectiveLegacyPoolRouter({ userId: user.id, organizationId: organization.id })
    ).rejects.toThrow('Could not resolve the organization pool');
  });

  test('a canonical database failure propagates rather than consulting a legacy snapshot', async () => {
    const select = jest.spyOn(db, 'select').mockImplementationOnce(() => {
      throw new Error('database unavailable');
    });

    await expect(
      findEffectiveLegacyPoolRouter({ userId: user.id, organizationId: null })
    ).rejects.toThrow('database unavailable');
    select.mockRestore();
    expect(getAutoRoutingSettings).not.toHaveBeenCalled();
  });
});
