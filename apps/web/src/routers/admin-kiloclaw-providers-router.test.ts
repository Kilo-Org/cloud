import { cleanupDbForTest } from '@/lib/drizzle';
import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import type { User } from '@kilocode/db/schema';

let adminUser: User;
let nonAdminUser: User;

describe('admin KiloClaw provider rollout router', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
    adminUser = await insertTestUser({
      google_user_email: 'admin-kiloclaw-providers@admin.example.com',
      google_user_name: 'Admin KiloClaw Provider User',
      is_admin: true,
    });
    nonAdminUser = await insertTestUser({
      google_user_email: 'non-admin-kiloclaw-providers@example.com',
      google_user_name: 'Non Admin KiloClaw Provider User',
      is_admin: false,
    });
  });

  it('returns default disabled Northflank rollout config', async () => {
    const caller = await createCallerForUser(adminUser.id);

    await expect(caller.admin.kiloclawProviders.get({ provider: 'northflank' })).resolves.toEqual({
      provider: 'northflank',
      enabled: false,
      personalTrafficPercent: 0,
      organizationTrafficPercent: 0,
    });
  });

  it('updates Northflank rollout config', async () => {
    const caller = await createCallerForUser(adminUser.id);

    await caller.admin.kiloclawProviders.update({
      provider: 'northflank',
      enabled: true,
      personalTrafficPercent: 10,
      organizationTrafficPercent: 25,
    });

    await expect(caller.admin.kiloclawProviders.get({ provider: 'northflank' })).resolves.toEqual({
      provider: 'northflank',
      enabled: true,
      personalTrafficPercent: 10,
      organizationTrafficPercent: 25,
    });
  });

  it('rejects invalid traffic percentages', async () => {
    const caller = await createCallerForUser(adminUser.id);

    await expect(
      caller.admin.kiloclawProviders.update({
        provider: 'northflank',
        enabled: true,
        personalTrafficPercent: 101,
        organizationTrafficPercent: 25,
      })
    ).rejects.toThrow();
  });

  it('rejects non-admin users', async () => {
    const caller = await createCallerForUser(nonAdminUser.id);

    await expect(caller.admin.kiloclawProviders.get({ provider: 'northflank' })).rejects.toThrow();
  });
});
