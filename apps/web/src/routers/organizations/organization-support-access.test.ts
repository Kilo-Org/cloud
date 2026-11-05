import { afterEach, describe, expect, test } from '@jest/globals';
import { support_access_grants } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { createCallerForUser } from '@/routers/test-utils';

function enableSupportAccess(enabled: boolean) {
  if (enabled) process.env.SUPPORT_ACCESS_ENABLED = 'true';
  else delete process.env.SUPPORT_ACCESS_ENABLED;
}

afterEach(async () => {
  enableSupportAccess(false);
  // eslint-disable-next-line drizzle/enforce-delete-with-where
  await db.delete(support_access_grants);
});

async function adminWithGrant(actionClass: 'support_read' | 'support_write' = 'support_read') {
  const owner = await insertTestUser({ is_admin: false });
  const organization = await createTestOrganization(
    `support-callsite-${crypto.randomUUID()}`,
    owner.id,
    0
  );
  const admin = await insertTestUser({
    is_admin: true,
  });
  const now = new Date();
  await db.insert(support_access_grants).values({
    actor_kilo_user_id: admin.id,
    organization_id: organization.id,
    action_class: actionClass,
    status: 'active',
    reason: 'investigating a customer report',
    requested_duration_seconds: 1800,
    issued_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 30 * 60 * 1000).toISOString(),
  });
  return { admin, organization };
}

describe('allowlisted support read call sites', () => {
  test('usageStats admits an allowlisted support read when on', async () => {
    enableSupportAccess(true);
    const { admin, organization } = await adminWithGrant();
    const caller = await createCallerForUser(admin.id);

    const result = await caller.organizations.usageStats({ organizationId: organization.id });

    expect(result).toMatchObject({ totalRequestCount: expect.anything() });
  });

  test('a non-allowlisted organization read still denies support when on', async () => {
    enableSupportAccess(true);
    const { admin, organization } = await adminWithGrant();
    const caller = await createCallerForUser(admin.id);

    await expect(
      caller.organizations.bitbucket.getStatus({ organizationId: organization.id })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  test('off leaves the same non-allowlisted read available to an admin', async () => {
    enableSupportAccess(false);
    const { admin, organization } = await adminWithGrant();
    const caller = await createCallerForUser(admin.id);

    await expect(
      caller.organizations.bitbucket.getStatus({ organizationId: organization.id })
    ).resolves.toBeDefined();
  });
});
