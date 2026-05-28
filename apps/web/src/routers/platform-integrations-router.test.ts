import { describe, test, expect, beforeAll, afterEach } from '@jest/globals';
import { db } from '@/lib/drizzle';
import { addUserToOrganization } from '@/lib/organizations/organizations';
import { INTEGRATION_STATUS, PLATFORM } from '@/lib/integrations/core/constants';
import { createCallerForUser } from '@/routers/test-utils';
import { createTestOrganization } from '@/tests/helpers/organization.helper';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { platform_integrations, type Organization, type User } from '@kilocode/db/schema';
import { eq, or } from 'drizzle-orm';

describe('platformIntegrationsRouter', () => {
  let ownerUser: User;
  let memberUser: User;
  let nonMemberUser: User;
  let organization: Organization;

  beforeAll(async () => {
    ownerUser = await insertTestUser({
      google_user_email: 'platform-integrations-owner@example.com',
      google_user_name: 'Platform Integrations Owner',
    });
    memberUser = await insertTestUser({
      google_user_email: 'platform-integrations-member@example.com',
      google_user_name: 'Platform Integrations Member',
    });
    nonMemberUser = await insertTestUser({
      google_user_email: 'platform-integrations-non-member@example.com',
      google_user_name: 'Platform Integrations Non-member',
    });

    organization = await createTestOrganization('Platform Integrations Test Org', ownerUser.id, 1);
    await addUserToOrganization(organization.id, memberUser.id, 'member');
  });

  afterEach(async () => {
    await db
      .delete(platform_integrations)
      .where(
        or(
          eq(platform_integrations.owned_by_user_id, ownerUser.id),
          eq(platform_integrations.owned_by_organization_id, organization.id)
        )
      );
  });

  test('returns sanitized setup statuses for the current user', async () => {
    await insertPlatformIntegration({
      userId: ownerUser.id,
      platform: PLATFORM.SLACK,
      platformAccountLogin: 'Kilo Team',
      status: INTEGRATION_STATUS.ACTIVE,
    });
    await insertPlatformIntegration({
      userId: ownerUser.id,
      platform: PLATFORM.GITHUB,
      platformAccountLogin: 'kilocode',
      status: INTEGRATION_STATUS.SUSPENDED,
    });
    await insertPlatformIntegration({
      userId: ownerUser.id,
      platform: PLATFORM.DOLTHUB,
      platformAccountLogin: 'kilocode',
      status: INTEGRATION_STATUS.ACTIVE,
    });

    const caller = await createCallerForUser(ownerUser.id);
    const result = await caller.platformIntegrations.listSetupStatus();

    expect(result).toEqual([
      {
        platform: PLATFORM.SLACK,
        installed: true,
        installation: { teamName: 'Kilo Team' },
      },
      {
        platform: PLATFORM.GITHUB,
        installed: false,
        installation: { accountLogin: 'kilocode' },
      },
      {
        platform: PLATFORM.DOLTHUB,
        installed: true,
        installation: { accountLogin: 'kilocode' },
      },
    ]);
  });

  test('allows organization members to read organization setup status', async () => {
    await insertPlatformIntegration({
      organizationId: organization.id,
      platform: PLATFORM.GITLAB,
      platformAccountLogin: 'kilocode',
      status: INTEGRATION_STATUS.ACTIVE,
    });

    const caller = await createCallerForUser(memberUser.id);
    const result = await caller.platformIntegrations.listSetupStatus({
      organizationId: organization.id,
    });

    expect(result).toEqual([
      {
        platform: PLATFORM.GITLAB,
        installed: true,
        installation: { accountLogin: 'kilocode' },
      },
    ]);
  });

  test('rejects organization setup status reads for non-members', async () => {
    const caller = await createCallerForUser(nonMemberUser.id);

    await expect(
      caller.platformIntegrations.listSetupStatus({ organizationId: organization.id })
    ).rejects.toThrow('You do not have access to this organization');
  });
});

async function insertPlatformIntegration({
  userId,
  organizationId,
  platform,
  platformAccountLogin,
  status,
}: {
  userId?: string;
  organizationId?: string;
  platform: string;
  platformAccountLogin: string;
  status: string;
}) {
  await db.insert(platform_integrations).values({
    owned_by_user_id: userId ?? null,
    owned_by_organization_id: organizationId ?? null,
    platform,
    integration_type: 'app',
    platform_installation_id: `${platform}-${crypto.randomUUID()}`,
    platform_account_login: platformAccountLogin,
    repository_access: 'all',
    integration_status: status,
    metadata: { access_token: 'secret-token' },
  });
}
