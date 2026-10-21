import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import {
  auto_routing_custom_routers,
  organization_memberships,
  organizations,
  type User,
} from '@kilocode/db/schema';
import { getAutoRoutingSettings } from '@kilocode/web-shared/lib/ai-gateway/auto-routing-admin-client';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { isReleaseToggleEnabled } from '@kilocode/web-shared/lib/posthog-feature-flags';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import {
  findEffectiveLegacyPoolRouter,
  hasCustomRoutersAccess,
  isCustomRoutersEnabled,
  listUsableCustomRouters,
} from './custom-routers';
import { eq } from 'drizzle-orm';

jest.mock('@kilocode/web-shared/lib/ai-gateway/auto-routing-admin-client', () => ({
  getAutoRoutingSettings: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/posthog-feature-flags');

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
    jest.mocked(isReleaseToggleEnabled).mockResolvedValue(false);
  });

  afterEach(async () => {
    await cleanupDbForTest();
  });

  test('migration grants access only to marked rows without graduating the feature flag', async () => {
    await db.insert(auto_routing_custom_routers).values([
      { ...DEFINITION, owned_by_user_id: user.id },
      { ...DEFINITION, owned_by_user_id: user.id, slug: 'other', legacy_pool: false },
    ]);

    await expect(hasCustomRoutersAccess(user.id)).resolves.toBe(true);
    await expect(isCustomRoutersEnabled(user.id)).resolves.toBe(false);
    expect(await listUsableCustomRouters({ userId: user.id, organizationId: null })).toEqual([
      expect.objectContaining({ slug: 'efficient', legacyPool: true }),
    ]);
  });

  test('only organization members discover its migrated pool', async () => {
    const organization = await createTestOrganization('Migrated', user.id, 0);
    await db
      .insert(auto_routing_custom_routers)
      .values({ ...DEFINITION, owned_by_organization_id: organization.id });
    const member = await insertTestUser();
    const outsider = await insertTestUser();
    await db.insert(organization_memberships).values({
      organization_id: organization.id,
      kilo_user_id: member.id,
      role: 'member',
    });

    await expect(hasCustomRoutersAccess(member.id)).resolves.toBe(true);
    await expect(hasCustomRoutersAccess(outsider.id)).resolves.toBe(false);
    expect(
      await listUsableCustomRouters({ userId: member.id, organizationId: organization.id })
    ).toEqual([
      expect.objectContaining({ ownerType: 'org', ownerId: organization.id, legacyPool: true }),
    ]);
  });

  test.each(['owner', 'admin', 'billing_manager'] as const)(
    'a parent %s discovers its child migrated pool without graduating the flag',
    async role => {
      const parent = await createTestOrganization('Parent', user.id, 0);
      const childOwner = await insertTestUser();
      const child = await createTestOrganization('Child', childOwner.id, 0);
      await db
        .update(organizations)
        .set({ parent_organization_id: parent.id })
        .where(eq(organizations.id, child.id));
      await db
        .update(organization_memberships)
        .set({ role })
        .where(eq(organization_memberships.kilo_user_id, user.id));
      await db.insert(auto_routing_custom_routers).values({
        ...DEFINITION,
        owned_by_organization_id: child.id,
      });

      await expect(hasCustomRoutersAccess(user.id)).resolves.toBe(true);
      await expect(isCustomRoutersEnabled(user.id)).resolves.toBe(false);
      expect(await listUsableCustomRouters({ userId: user.id, organizationId: child.id })).toEqual([
        expect.objectContaining({ ownerType: 'org', ownerId: child.id, legacyPool: true }),
      ]);
    }
  );

  test('parent ordinary members and grandparent owners do not discover a child migrated pool', async () => {
    const grandparent = await createTestOrganization('Grandparent', user.id, 0);
    const parentOwner = await insertTestUser();
    const parent = await createTestOrganization('Parent', parentOwner.id, 0);
    const childOwner = await insertTestUser();
    const child = await createTestOrganization('Child', childOwner.id, 0);
    await db
      .update(organizations)
      .set({ parent_organization_id: grandparent.id })
      .where(eq(organizations.id, parent.id));
    await db
      .update(organizations)
      .set({ parent_organization_id: parent.id })
      .where(eq(organizations.id, child.id));
    const member = await insertTestUser();
    await db.insert(organization_memberships).values({
      organization_id: parent.id,
      kilo_user_id: member.id,
      role: 'member',
    });
    await db.insert(auto_routing_custom_routers).values({
      ...DEFINITION,
      owned_by_organization_id: child.id,
    });

    await expect(hasCustomRoutersAccess(member.id)).resolves.toBe(false);
    await expect(hasCustomRoutersAccess(user.id)).resolves.toBe(false);
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
