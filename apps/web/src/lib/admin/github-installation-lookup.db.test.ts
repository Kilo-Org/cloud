import { db } from '@/lib/drizzle';
import { createTestOrganization } from '@/tests/helpers/organization.helper';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { kilocode_users, organizations, platform_integrations } from '@kilocode/db/schema';
import { asc, inArray } from 'drizzle-orm';
import { findGitHubOrganizationInstallationRecords } from './github-installation-lookup';

const createdIntegrationIds: string[] = [];
const createdOrganizationIds: string[] = [];
const createdUserIds: string[] = [];

async function createUser(id = `oauth/github/${crypto.randomUUID()}`) {
  const user = await insertTestUser({ id });
  createdUserIds.push(user.id);
  return user;
}

async function createOrganization() {
  const user = await createUser();
  const organization = await createTestOrganization(`Lookup ${crypto.randomUUID()}`, user.id, 0);
  createdOrganizationIds.push(organization.id);
  return organization;
}

async function insertIntegration(
  values: Omit<
    typeof platform_integrations.$inferInsert,
    'owned_by_user_id' | 'owned_by_organization_id'
  > &
    (
      | { owned_by_user_id: string; owned_by_organization_id?: never }
      | { owned_by_organization_id: string; owned_by_user_id?: never }
    )
) {
  const [integration] = await db.insert(platform_integrations).values(values).returning();
  createdIntegrationIds.push(integration.id);
  return integration;
}

afterEach(async () => {
  if (createdIntegrationIds.length > 0) {
    await db
      .delete(platform_integrations)
      .where(inArray(platform_integrations.id, createdIntegrationIds));
  }
  if (createdOrganizationIds.length > 0) {
    await db.delete(organizations).where(inArray(organizations.id, createdOrganizationIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(kilocode_users).where(inArray(kilocode_users.id, createdUserIds));
  }
  createdIntegrationIds.length = 0;
  createdOrganizationIds.length = 0;
  createdUserIds.length = 0;
});

describe('findGitHubOrganizationInstallationRecords', () => {
  test('returns an exact case-insensitive match for a personal integration owned by an arbitrary OAuth user ID', async () => {
    const user = await createUser('oauth/github/123456789');
    const integration = await insertIntegration({
      owned_by_user_id: user.id,
      platform: 'github',
      integration_type: 'app',
      platform_installation_id: `personal-installation-${crypto.randomUUID()}`,
      platform_account_id: 'personal-account',
      platform_account_login: 'Personal-Account',
      integration_status: 'active',
    });

    await expect(
      findGitHubOrganizationInstallationRecords({
        organization: 'personal-account',
        installationIds: [],
        accountIds: [],
      })
    ).resolves.toMatchObject({
      recordsTruncated: false,
      records: [
        {
          id: integration.id,
          owner: { type: 'user', id: user.id, name: 'Test User' },
          association: 'candidate',
        },
      ],
    });
  });

  test('returns an organization owner name without projecting owner email or integration metadata', async () => {
    const organization = await createOrganization();
    const integration = await insertIntegration({
      owned_by_organization_id: organization.id,
      platform: 'github',
      integration_type: 'app',
      platform_installation_id: `organization-installation-${crypto.randomUUID()}`,
      platform_account_id: 'organization-account',
      platform_account_login: 'Acme-Tools',
      integration_status: 'active',
      metadata: { privateEmail: 'should-not-be-projected@example.com' },
    });

    const result = await findGitHubOrganizationInstallationRecords({
      organization: 'acme-tools',
      installationIds: [],
      accountIds: [],
    });

    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      id: integration.id,
      owner: { type: 'organization', id: organization.id, name: organization.name },
    });
    expect(Object.keys(result.records[0]).sort()).toEqual([
      'accountId',
      'accountLogin',
      'appType',
      'association',
      'authInvalid',
      'id',
      'installationId',
      'owner',
      'status',
      'suspendedAt',
      'updatedAt',
    ]);
    expect(result.records[0]).not.toHaveProperty('metadata');
    expect(result.records[0].owner).not.toHaveProperty('email');
  });

  test('finds a renamed account through matched live installation and account IDs', async () => {
    const organization = await createOrganization();
    const integration = await insertIntegration({
      owned_by_organization_id: organization.id,
      platform: 'github',
      integration_type: 'app',
      platform_installation_id: 'live-installation-id',
      platform_account_id: 'live-account-id',
      platform_account_login: 'former-acme-name',
      integration_status: 'active',
    });

    await expect(
      findGitHubOrganizationInstallationRecords({
        organization: 'acme-tools',
        installationIds: ['live-installation-id'],
        accountIds: ['live-account-id'],
      })
    ).resolves.toMatchObject({ records: [expect.objectContaining({ id: integration.id })] });
  });

  test('preserves standard and lite records with shared live account IDs', async () => {
    const organization = await createOrganization();
    const [standard, lite] = await Promise.all(
      (['standard', 'lite'] as const).map(github_app_type =>
        insertIntegration({
          owned_by_organization_id: organization.id,
          platform: 'github',
          integration_type: 'app',
          github_app_type,
          platform_installation_id: `${github_app_type}-installation-${crypto.randomUUID()}`,
          platform_account_id: 'shared-live-account',
          platform_account_login: 'Acme-Tools',
          integration_status: 'active',
        })
      )
    );

    const result = await findGitHubOrganizationInstallationRecords({
      organization: 'unrelated-name',
      installationIds: [],
      accountIds: ['shared-live-account'],
    });

    expect(result.records).toHaveLength(2);
    expect(result.records.map(record => [record.id, record.appType])).toEqual(
      expect.arrayContaining([
        [standard.id, 'standard'],
        [lite.id, 'lite'],
      ])
    );
  });

  test('returns legacy null-app, pending, and suspended GitHub records', async () => {
    const organization = await createOrganization();
    const legacy = await insertIntegration({
      owned_by_organization_id: organization.id,
      platform: 'github',
      integration_type: 'app',
      github_app_type: null,
      platform_installation_id: `legacy-installation-${crypto.randomUUID()}`,
      platform_account_id: 'legacy-account',
      platform_account_login: 'Acme-Tools',
      integration_status: 'active',
    });
    const pending = await insertIntegration({
      owned_by_organization_id: organization.id,
      platform: 'github',
      integration_type: 'app',
      platform_account_id: 'pending-account',
      platform_account_login: 'not-the-requested-name',
      integration_status: 'pending',
    });
    const suspended = await insertIntegration({
      owned_by_organization_id: organization.id,
      platform: 'github',
      integration_type: 'app',
      platform_installation_id: `suspended-installation-${crypto.randomUUID()}`,
      platform_account_id: 'suspended-account',
      platform_account_login: 'acme-tools',
      integration_status: 'suspended',
      suspended_at: '2026-09-03 15:00:00+00',
    });

    const result = await findGitHubOrganizationInstallationRecords({
      organization: 'acme-tools',
      installationIds: [],
      accountIds: ['pending-account'],
    });

    expect(result.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: legacy.id, appType: null, status: 'active' }),
        expect.objectContaining({ id: pending.id, installationId: null, status: 'pending' }),
        expect.objectContaining({
          id: suspended.id,
          status: 'suspended',
          suspendedAt: '2026-09-03T15:00:00.000Z',
        }),
      ])
    );
  });

  test('excludes non-GitHub records and login substring matches', async () => {
    const organization = await createOrganization();
    await Promise.all([
      insertIntegration({
        owned_by_organization_id: organization.id,
        platform: 'gitlab',
        integration_type: 'oauth',
        platform_installation_id: `gitlab-installation-${crypto.randomUUID()}`,
        platform_account_login: 'Acme-Tools',
      }),
      insertIntegration({
        owned_by_organization_id: organization.id,
        platform: 'github',
        integration_type: 'app',
        platform_installation_id: `substring-installation-${crypto.randomUUID()}`,
        platform_account_login: 'Acme-Tools-Archived',
      }),
    ]);

    await expect(
      findGitHubOrganizationInstallationRecords({
        organization: 'acme-tools',
        installationIds: [],
        accountIds: [],
      })
    ).resolves.toEqual({ records: [], recordsTruncated: false });
  });

  test('returns the first 100 records in ID order, reports truncation, and does not mutate rows', async () => {
    const user = await createUser();
    const integrations = await db
      .insert(platform_integrations)
      .values(
        Array.from({ length: 101 }, (_, index) => ({
          owned_by_user_id: user.id,
          platform: 'github',
          integration_type: 'app',
          platform_installation_id: `bulk-installation-${index}-${crypto.randomUUID()}`,
          platform_account_id: `bulk-account-${index}`,
          platform_account_login: 'Acme-Tools',
          integration_status: 'active',
        }))
      )
      .returning({ id: platform_integrations.id, updatedAt: platform_integrations.updated_at });
    createdIntegrationIds.push(...integrations.map(integration => integration.id));
    const expected = await db
      .select({ id: platform_integrations.id, updatedAt: platform_integrations.updated_at })
      .from(platform_integrations)
      .where(inArray(platform_integrations.id, createdIntegrationIds))
      .orderBy(asc(platform_integrations.id));

    const result = await findGitHubOrganizationInstallationRecords({
      organization: 'acme-tools',
      installationIds: [],
      accountIds: [],
    });

    expect(result.recordsTruncated).toBe(true);
    expect(result.records.map(record => record.id)).toEqual(
      expected.slice(0, 100).map(row => row.id)
    );
    await expect(
      db
        .select({ id: platform_integrations.id, updatedAt: platform_integrations.updated_at })
        .from(platform_integrations)
        .where(inArray(platform_integrations.id, createdIntegrationIds))
        .orderBy(asc(platform_integrations.id))
    ).resolves.toEqual(expected);
  });
});
