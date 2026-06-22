import { beforeEach, describe, expect, test } from '@jest/globals';
import { organization_memberships } from '@kilocode/db/schema';
import { cleanupDbForTest, db } from '@/lib/drizzle';
import { KILO_ORGANIZATION_ID } from '@/lib/organizations/constants';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { findEligibleNativeMcpUser } from './native-token-verifier';

async function addOrganizationMembership(userId: string, organizationId = KILO_ORGANIZATION_ID) {
  await db.insert(organization_memberships).values({
    organization_id: organizationId,
    kilo_user_id: userId,
    role: 'member',
  });
}

describe('findEligibleNativeMcpUser', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
  });

  test('allows admins who are members of the Kilo organization', async () => {
    const user = await insertTestUser({ is_admin: true });
    await addOrganizationMembership(user.id);

    await expect(findEligibleNativeMcpUser(user.id, db)).resolves.toMatchObject({ id: user.id });
  });

  test('rejects admins outside the Kilo organization', async () => {
    const user = await insertTestUser({ is_admin: true });
    await addOrganizationMembership(user.id, '03366a2a-b498-498a-8560-98bffe4a0997');

    await expect(findEligibleNativeMcpUser(user.id, db)).resolves.toBeNull();
  });

  test('rejects Kilo organization members who are not admins', async () => {
    const user = await insertTestUser({ is_admin: false });
    await addOrganizationMembership(user.id);

    await expect(findEligibleNativeMcpUser(user.id, db)).resolves.toBeNull();
  });
});
