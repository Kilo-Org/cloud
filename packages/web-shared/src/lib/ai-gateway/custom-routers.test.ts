import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { auto_routing_custom_routers, type User } from '@kilocode/db/schema';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { listUsableCustomRouters } from './custom-routers';

const MODEL = 'openai/test-pool-model';
const DEFINITION = {
  slug: 'efficient',
  name: 'Efficient',
  base_router: 'efficient' as const,
  mode: 'best_accuracy' as const,
  entries: [{ kind: 'gateway' as const, model: MODEL }],
  default_entry_key: `gateway:${MODEL}`,
};

describe('listUsableCustomRouters', () => {
  let user: User;

  beforeEach(async () => {
    user = await insertTestUser();
  });

  afterEach(async () => {
    await cleanupDbForTest();
  });

  test('lists every personal and organization router', async () => {
    const organization = await createTestOrganization('Owner', user.id, 0);
    await db.insert(auto_routing_custom_routers).values([
      { ...DEFINITION, owned_by_user_id: user.id },
      { ...DEFINITION, owned_by_user_id: user.id, slug: 'other' },
      {
        ...DEFINITION,
        owned_by_organization_id: organization.id,
        slug: 'team',
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
});
