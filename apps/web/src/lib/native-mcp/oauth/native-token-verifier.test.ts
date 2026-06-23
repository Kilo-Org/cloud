import { beforeEach, describe, expect, test } from '@jest/globals';
import { cleanupDbForTest, db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { findEligibleNativeMcpUser } from './native-token-verifier';

describe('findEligibleNativeMcpUser', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
  });

  test('allows admins without requiring Kilo organization membership', async () => {
    const user = await insertTestUser({ is_admin: true });

    await expect(findEligibleNativeMcpUser(user.id, db)).resolves.toMatchObject({ id: user.id });
  });

  test('rejects users who are not admins', async () => {
    const user = await insertTestUser({ is_admin: false });

    await expect(findEligibleNativeMcpUser(user.id, db)).resolves.toBeNull();
  });
});
