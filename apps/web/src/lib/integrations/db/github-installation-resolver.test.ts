import { afterEach, describe, expect, it } from '@jest/globals';
import { db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { kilocode_users, organizations, platform_integrations } from '@kilocode/db/schema';
import { inArray } from 'drizzle-orm';
import {
  resolveGitHubIntegrationForRepository,
  resolveOrganizationGitHubIntegrationForRepository,
} from './platform-integrations';

const organizationIds = [crypto.randomUUID(), crypto.randomUUID()];
const installationIds: string[] = [];
const userIds: string[] = [];

async function insertOrganization(organizationId: string) {
  await db.insert(organizations).values({
    id: organizationId,
    name: `GitHub resolver ${organizationId}`,
  });
}

async function insertIntegration(
  organizationId: string,
  overrides: Partial<typeof platform_integrations.$inferInsert> = {}
) {
  const installationId = `resolver-${crypto.randomUUID()}`;
  installationIds.push(installationId);
  const [integration] = await db
    .insert(platform_integrations)
    .values({
      owned_by_organization_id: organizationId,
      platform: 'github',
      integration_type: 'app',
      integration_status: 'active',
      platform_installation_id: installationId,
      platform_account_login: 'acme',
      repository_access: 'all',
      github_app_type: 'standard',
      ...overrides,
    })
    .returning();
  if (!integration) throw new Error('Expected GitHub integration fixture');
  return integration;
}

afterEach(async () => {
  if (installationIds.length > 0) {
    await db
      .delete(platform_integrations)
      .where(inArray(platform_integrations.platform_installation_id, installationIds));
    installationIds.length = 0;
  }
  await db.delete(organizations).where(inArray(organizations.id, organizationIds));
  if (userIds.length > 0) {
    await db.delete(kilocode_users).where(inArray(kilocode_users.id, userIds));
    userIds.length = 0;
  }
});

describe('resolveOrganizationGitHubIntegrationForRepository', () => {
  it('resolves the exact healthy integration row when its account and repository match', async () => {
    await insertOrganization(organizationIds[0]);
    const integration = await insertIntegration(organizationIds[0], {
      repository_access: 'selected',
      repositories: [{ id: 1, name: 'api', full_name: 'acme/api', private: true }],
      github_app_type: 'lite',
    });
    await insertIntegration(organizationIds[0], {
      platform_account_login: 'other',
    });

    await expect(
      resolveOrganizationGitHubIntegrationForRepository({
        organizationId: organizationIds[0],
        repositoryFullName: 'acme/api',
        expectedPlatformIntegrationId: integration.id,
      })
    ).resolves.toEqual({ success: true, integration });
  });

  it('fails a pinned integration closed when its selected repositories do not include the repo', async () => {
    await insertOrganization(organizationIds[0]);
    const integration = await insertIntegration(organizationIds[0], {
      repository_access: 'selected',
      repositories: [{ id: 1, name: 'web', full_name: 'acme/web', private: true }],
    });

    await expect(
      resolveOrganizationGitHubIntegrationForRepository({
        organizationId: organizationIds[0],
        repositoryFullName: 'acme/api',
        expectedPlatformIntegrationId: integration.id,
      })
    ).resolves.toEqual({ success: false, reason: 'no_installation_found' });
  });

  it('fails a pinned integration closed when its account does not own the repository', async () => {
    await insertOrganization(organizationIds[0]);
    const integration = await insertIntegration(organizationIds[0], {
      platform_account_login: 'other',
    });

    await expect(
      resolveOrganizationGitHubIntegrationForRepository({
        organizationId: organizationIds[0],
        repositoryFullName: 'acme/api',
        expectedPlatformIntegrationId: integration.id,
      })
    ).resolves.toEqual({ success: false, reason: 'no_installation_found' });
  });

  it.each([
    {
      access: 'selected' as const,
      repositories: [{ id: 1, name: 'api', full_name: 'acme/api', private: false }],
    },
    { access: 'all' as const, repositories: null },
  ])('resolves unpinned $access repository access', async fixture => {
    await insertOrganization(organizationIds[0]);
    const integration = await insertIntegration(organizationIds[0], {
      repository_access: fixture.access,
      repositories: fixture.repositories,
    });

    await expect(
      resolveOrganizationGitHubIntegrationForRepository({
        organizationId: organizationIds[0],
        repositoryFullName: 'acme/api',
      })
    ).resolves.toEqual({ success: true, integration });
  });

  it('matches a renamed account and repository without case sensitivity', async () => {
    await insertOrganization(organizationIds[0]);
    const integration = await insertIntegration(organizationIds[0], {
      platform_account_login: 'Renamed-Acme',
      repository_access: 'selected',
      repositories: [{ id: 1, name: 'API', full_name: 'RENAMED-ACME/API', private: false }],
    });

    await expect(
      resolveOrganizationGitHubIntegrationForRepository({
        organizationId: organizationIds[0],
        repositoryFullName: 'renamed-acme/api',
      })
    ).resolves.toEqual({ success: true, integration });
  });

  it('ignores same-account installations that do not include the selected repository', async () => {
    await insertOrganization(organizationIds[0]);
    await insertIntegration(organizationIds[0], {
      repository_access: 'selected',
      repositories: [{ id: 1, name: 'web', full_name: 'acme/web', private: false }],
    });
    const integration = await insertIntegration(organizationIds[0], {
      repository_access: 'selected',
      repositories: [{ id: 2, name: 'api', full_name: 'acme/api', private: false }],
      github_app_type: 'lite',
    });

    await expect(
      resolveOrganizationGitHubIntegrationForRepository({
        organizationId: organizationIds[0],
        repositoryFullName: 'acme/api',
      })
    ).resolves.toEqual({ success: true, integration });
  });

  it.each([{ integration_status: 'suspended' }, { suspended_at: '2026-08-27T00:00:00.000Z' }])(
    'does not resolve suspended rows ($#)',
    async suspension => {
      await insertOrganization(organizationIds[0]);
      const integration = await insertIntegration(organizationIds[0], suspension);

      await expect(
        resolveOrganizationGitHubIntegrationForRepository({
          organizationId: organizationIds[0],
          repositoryFullName: 'acme/api',
          expectedPlatformIntegrationId: integration.id,
        })
      ).resolves.toEqual({ success: false, reason: 'no_installation_found' });
    }
  );

  it('does not resolve an exact integration owned by another organization', async () => {
    await Promise.all(organizationIds.map(insertOrganization));
    const integration = await insertIntegration(organizationIds[1]);

    await expect(
      resolveOrganizationGitHubIntegrationForRepository({
        organizationId: organizationIds[0],
        repositoryFullName: 'acme/api',
        expectedPlatformIntegrationId: integration.id,
      })
    ).resolves.toEqual({ success: false, reason: 'no_installation_found' });
  });

  it('fails closed distinctly when multiple installations match', async () => {
    await insertOrganization(organizationIds[0]);
    await insertIntegration(organizationIds[0]);
    await insertIntegration(organizationIds[0], { github_app_type: 'lite' });

    await expect(
      resolveOrganizationGitHubIntegrationForRepository({
        organizationId: organizationIds[0],
        repositoryFullName: 'acme/api',
      })
    ).resolves.toEqual({ success: false, reason: 'ambiguous_installation' });
  });

  it('requires the repository owner to match even for all-repository access', async () => {
    await insertOrganization(organizationIds[0]);
    await insertIntegration(organizationIds[0], { platform_account_login: 'other' });

    await expect(
      resolveOrganizationGitHubIntegrationForRepository({
        organizationId: organizationIds[0],
        repositoryFullName: 'acme/api',
      })
    ).resolves.toEqual({ success: false, reason: 'no_installation_found' });
  });
});

describe('resolveGitHubIntegrationForRepository', () => {
  it('resolves an exact personal installation and fails closed on ambiguity', async () => {
    const user = await insertTestUser();
    userIds.push(user.id);
    const first = await db
      .insert(platform_integrations)
      .values({
        owned_by_user_id: user.id,
        platform: 'github',
        integration_type: 'app',
        integration_status: 'active',
        platform_installation_id: `resolver-${crypto.randomUUID()}`,
        platform_account_login: 'acme',
        repository_access: 'all',
        github_app_type: 'standard',
      })
      .returning();
    const second = await db
      .insert(platform_integrations)
      .values({
        owned_by_user_id: user.id,
        platform: 'github',
        integration_type: 'app',
        integration_status: 'active',
        platform_installation_id: `resolver-${crypto.randomUUID()}`,
        platform_account_login: 'acme',
        repository_access: 'all',
        github_app_type: 'lite',
      })
      .returning();
    const integrations = [...first, ...second];
    installationIds.push(...integrations.map(integration => integration.platform_installation_id!));

    await expect(
      resolveGitHubIntegrationForRepository({
        owner: { type: 'user', id: user.id },
        repositoryFullName: 'acme/api',
        expectedPlatformIntegrationId: integrations[0].id,
      })
    ).resolves.toEqual({ success: true, integration: integrations[0] });
    await expect(
      resolveGitHubIntegrationForRepository({
        owner: { type: 'user', id: user.id },
        repositoryFullName: 'acme/api',
      })
    ).resolves.toEqual({ success: false, reason: 'ambiguous_installation' });
  });
});
