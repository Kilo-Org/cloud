import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { db } from '@/lib/drizzle';
import { platform_integrations, kilocode_users, organizations } from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';
import {
  deleteIntegration,
  deleteIntegrationForOwner,
  createPendingIntegration,
  findIntegrationByInstallationId,
  suspendIntegration,
  suspendIntegrationForOwner,
  unsuspendIntegration,
  unsuspendIntegrationForOwner,
  updateIntegrationRepositories,
  updateRepositoriesForIntegration,
  upsertPlatformIntegrationForOwner,
} from './platform-integrations';
import type { Owner } from '../core/types';
import type * as GitLabAdapter from '../platforms/gitlab/adapter';
import type { fetchGitLabCredential } from '../platforms/gitlab/credential-broker-client';

const mockFetchGitLabProjects = jest.fn<typeof GitLabAdapter.fetchGitLabProjects>();
const mockValidatePersonalAccessToken = jest.fn<typeof GitLabAdapter.validatePersonalAccessToken>();
const mockFetchGitLabCredential = jest.fn<typeof fetchGitLabCredential>();
jest.mock('@/lib/integrations/platforms/gitlab/adapter', () => ({
  fetchGitLabProjects: mockFetchGitLabProjects,
  validatePersonalAccessToken: mockValidatePersonalAccessToken,
}));
jest.mock('@/lib/integrations/platforms/gitlab/credential-broker-client', () => ({
  fetchGitLabCredential: mockFetchGitLabCredential,
}));
jest.mock('@/lib/integrations/platforms/gitlab/credential-encryption', () => ({
  encryptGitLabPersonalAccessToken: () => 'test-encrypted-token',
}));
jest.mock('@/lib/agent-config/db/agent-configs', () => ({
  resetCodeReviewConfigForOwner: jest.fn(),
}));

const INSTALLATION_ID = `test-github-install-${Date.now()}`;

describe('upsertPlatformIntegrationForOwner', () => {
  const userId = `test-upsert-user-${Date.now()}`;
  const otherUserId = `test-upsert-other-user-${Date.now()}`;
  const orgId = crypto.randomUUID();
  const otherOrgId = crypto.randomUUID();

  beforeEach(async () => {
    await db.insert(kilocode_users).values([
      {
        id: userId,
        google_user_email: `upsert-${Date.now()}-a@example.com`,
        google_user_name: 'Upsert Test User A',
        google_user_image_url: 'https://example.com/avatar.jpg',
        stripe_customer_id: `cus_upsert_a_${Date.now()}`,
      },
      {
        id: otherUserId,
        google_user_email: `upsert-${Date.now()}-b@example.com`,
        google_user_name: 'Upsert Test User B',
        google_user_image_url: 'https://example.com/avatar.jpg',
        stripe_customer_id: `cus_upsert_b_${Date.now()}`,
      },
    ]);

    await db.insert(organizations).values([
      { id: orgId, name: `Upsert Test Org A ${Date.now()}` },
      { id: otherOrgId, name: `Upsert Test Org B ${Date.now()}` },
    ]);
  });

  afterEach(async () => {
    await db
      .delete(platform_integrations)
      .where(eq(platform_integrations.platform_installation_id, INSTALLATION_ID));
    await db
      .delete(platform_integrations)
      .where(eq(platform_integrations.owned_by_user_id, userId));
    await db
      .delete(platform_integrations)
      .where(eq(platform_integrations.owned_by_user_id, otherUserId));
    await db
      .delete(platform_integrations)
      .where(eq(platform_integrations.owned_by_organization_id, orgId));
    await db
      .delete(platform_integrations)
      .where(eq(platform_integrations.owned_by_organization_id, otherOrgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(organizations).where(eq(organizations.id, otherOrgId));
    await db.delete(kilocode_users).where(eq(kilocode_users.id, userId));
    await db.delete(kilocode_users).where(eq(kilocode_users.id, otherUserId));
  });

  const baseInstallData = (installationId: string) => ({
    platform: 'github',
    integrationType: 'app',
    platformInstallationId: installationId,
    platformAccountId: '12345',
    platformAccountLogin: 'test-owner',
    permissions: null,
    scopes: [],
    repositoryAccess: 'all' as const,
    repositories: null,
    installedAt: new Date().toISOString(),
    githubAppType: 'standard' as const,
  });

  test('inserts a new GitHub installation for a user owner', async () => {
    const owner: Owner = { type: 'user', id: userId };
    const result = await upsertPlatformIntegrationForOwner(owner, baseInstallData(INSTALLATION_ID));

    expect(result).toEqual({ ok: true });

    const [row] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.platform_installation_id, INSTALLATION_ID));

    expect(row).toBeDefined();
    expect(row.owned_by_user_id).toBe(userId);
    expect(row.owned_by_organization_id).toBeNull();
    expect(row.platform).toBe('github');
  });

  test('inserts a new GitHub installation for an org owner', async () => {
    const owner: Owner = { type: 'org', id: orgId };
    const result = await upsertPlatformIntegrationForOwner(owner, baseInstallData(INSTALLATION_ID));

    expect(result).toEqual({ ok: true });

    const [row] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.platform_installation_id, INSTALLATION_ID));

    expect(row.owned_by_user_id).toBeNull();
    expect(row.owned_by_organization_id).toBe(orgId);
  });

  test('same-owner refresh updates the existing row (by primary key)', async () => {
    const owner: Owner = { type: 'user', id: userId };

    // First insert.
    await upsertPlatformIntegrationForOwner(owner, baseInstallData(INSTALLATION_ID));

    // Second call with different account login — same-owner refresh.
    const result = await upsertPlatformIntegrationForOwner(owner, {
      ...baseInstallData(INSTALLATION_ID),
      platformAccountLogin: 'new-login',
    });

    expect(result).toEqual({ ok: true });

    const [row] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.platform_installation_id, INSTALLATION_ID));

    expect(row.platform_account_login).toBe('new-login');
    // Ownership must not have changed.
    expect(row.owned_by_user_id).toBe(userId);
    expect(row.owned_by_organization_id).toBeNull();
  });

  test('cross-owner collision returns claimed_by_other_owner without updating', async () => {
    const ownerA: Owner = { type: 'user', id: userId };
    const ownerB: Owner = { type: 'user', id: otherUserId };

    // Owner A claims the installation.
    await upsertPlatformIntegrationForOwner(ownerA, baseInstallData(INSTALLATION_ID));

    // Owner B tries to claim the same installation.
    const result = await upsertPlatformIntegrationForOwner(
      ownerB,
      baseInstallData(INSTALLATION_ID)
    );

    expect(result).toEqual({ ok: false, reason: 'claimed_by_other_owner' });

    // Ownership must still be owner A.
    const [row] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.platform_installation_id, INSTALLATION_ID));

    expect(row.owned_by_user_id).toBe(userId);
  });

  test('cross-owner type mismatch returns claimed_by_other_owner (user vs org)', async () => {
    // Insert as a user owner.
    const userOwner: Owner = { type: 'user', id: userId };
    await upsertPlatformIntegrationForOwner(userOwner, baseInstallData(INSTALLATION_ID));

    // Try to upsert as an org owner. The owner type differs from the existing
    // integration's user ownership, so the comparison must reject it.
    const orgOwner: Owner = { type: 'org', id: orgId };
    const result = await upsertPlatformIntegrationForOwner(
      orgOwner,
      baseInstallData(INSTALLATION_ID)
    );

    expect(result).toEqual({ ok: false, reason: 'claimed_by_other_owner' });

    // Ownership must still be the user owner.
    const [row] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.platform_installation_id, INSTALLATION_ID));

    expect(row.owned_by_user_id).toBe(userId);
    expect(row.owned_by_organization_id).toBeNull();
  });

  test('second insert after unique index hit same-owner refresh updates (edge case)', async () => {
    const owner: Owner = { type: 'user', id: userId };

    // Insert a row with onConflictDoNothing on global index.
    const result1 = await upsertPlatformIntegrationForOwner(
      owner,
      baseInstallData(INSTALLATION_ID)
    );
    expect(result1).toEqual({ ok: true });

    // Same owner inserts again, skips onDoNothing, re-reads, finds same owner.
    const result2 = await upsertPlatformIntegrationForOwner(owner, {
      ...baseInstallData(INSTALLATION_ID),
      platformAccountLogin: 'refreshed-login',
    });
    expect(result2).toEqual({ ok: true });

    // Verify the update happened.
    const [row] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.platform_installation_id, INSTALLATION_ID));

    expect(row.platform_account_login).toBe('refreshed-login');
  });

  const crossTypeInstallId = `test-github-cross-type-${Date.now()}`;

  afterEach(async () => {
    await db
      .delete(platform_integrations)
      .where(eq(platform_integrations.platform_installation_id, crossTypeInstallId));
  });

  test('selects the correct row for the same installation id across app types', async () => {
    const ownerA: Owner = { type: 'user', id: userId };
    const ownerB: Owner = { type: 'user', id: otherUserId };

    await upsertPlatformIntegrationForOwner(ownerA, {
      ...baseInstallData(crossTypeInstallId),
      githubAppType: 'standard',
    });
    await upsertPlatformIntegrationForOwner(ownerB, {
      ...baseInstallData(crossTypeInstallId),
      githubAppType: 'lite',
    });

    const standard = await findIntegrationByInstallationId(
      'github',
      crossTypeInstallId,
      'standard'
    );
    const lite = await findIntegrationByInstallationId('github', crossTypeInstallId, 'lite');

    expect(standard?.owned_by_user_id).toBe(userId);
    expect(standard?.github_app_type).toBe('standard');
    expect(lite?.owned_by_user_id).toBe(otherUserId);
    expect(lite?.github_app_type).toBe('lite');
  });

  test('cross-owner conflict is scoped to the app type', async () => {
    const ownerA: Owner = { type: 'user', id: userId };
    const ownerB: Owner = { type: 'user', id: otherUserId };

    // Owner A claims the installation with the standard app.
    await upsertPlatformIntegrationForOwner(ownerA, {
      ...baseInstallData(crossTypeInstallId),
      githubAppType: 'standard',
    });

    // Owner B cannot claim the same standard row.
    const blocked = await upsertPlatformIntegrationForOwner(ownerB, {
      ...baseInstallData(crossTypeInstallId),
      githubAppType: 'standard',
    });
    expect(blocked).toEqual({ ok: false, reason: 'claimed_by_other_owner' });

    // Owner B can claim the same installation id under the lite app.
    const liteClaim = await upsertPlatformIntegrationForOwner(ownerB, {
      ...baseInstallData(crossTypeInstallId),
      githubAppType: 'lite',
    });
    expect(liteClaim).toEqual({ ok: true });

    const rows = await db
      .select()
      .from(platform_integrations)
      .where(
        and(
          eq(platform_integrations.platform, 'github'),
          eq(platform_integrations.platform_installation_id, crossTypeInstallId)
        )
      );
    expect(rows).toHaveLength(2);
  });

  test('concurrent callbacks create one pending row for a GitHub app target', async () => {
    const accountId = `pending-target-${Date.now()}`;
    const request = {
      requester: {
        kilo_user_id: userId,
        kilo_user_email: 'requester@example.com',
        kilo_user_name: 'Requester',
        requested_at: new Date().toISOString(),
      },
      githubRequester: { id: 'github-requester', login: 'requester' },
      githubRequest: {
        id: 'github-request',
        accountId,
        accountLogin: 'target-org',
      },
      githubAppType: 'standard' as const,
    };

    const results = await Promise.all([
      createPendingIntegration({ ...request, userId }),
      createPendingIntegration({ ...request, userId: otherUserId }),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    const rows = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.platform_account_id, accountId));
    expect(rows).toHaveLength(1);
  });

  test('same-owner refresh with app type is not confused by another owner other-app-type row', async () => {
    const ownerA: Owner = { type: 'user', id: userId };
    const ownerB: Owner = { type: 'user', id: otherUserId };

    // Owner B claims the lite row first so an unscoped lookup would find it.
    await upsertPlatformIntegrationForOwner(ownerB, {
      ...baseInstallData(crossTypeInstallId),
      githubAppType: 'lite',
    });

    // Owner A claims the standard row.
    const claimed = await upsertPlatformIntegrationForOwner(ownerA, {
      ...baseInstallData(crossTypeInstallId),
      githubAppType: 'standard',
    });
    expect(claimed).toEqual({ ok: true });

    // Owner A refreshes the standard row — must not hit owner B's lite row.
    const refreshed = await upsertPlatformIntegrationForOwner(ownerA, {
      ...baseInstallData(crossTypeInstallId),
      githubAppType: 'standard',
      platformAccountLogin: 'refreshed-login',
    });
    expect(refreshed).toEqual({ ok: true });

    const standard = await findIntegrationByInstallationId(
      'github',
      crossTypeInstallId,
      'standard'
    );
    const lite = await findIntegrationByInstallationId('github', crossTypeInstallId, 'lite');

    expect(standard?.owned_by_user_id).toBe(userId);
    expect(standard?.platform_account_login).toBe('refreshed-login');
    expect(standard?.github_app_type).toBe('standard');
    expect(lite?.owned_by_user_id).toBe(otherUserId);
    expect(lite?.github_app_type).toBe('lite');
  });

  describe('GitLab repository cache snapshots', () => {
    const instanceUrl = 'https://gitlab.example.com/Enterprise';
    const replacementUrl = 'https://other.example.com/gitlab';
    const project = {
      id: 42,
      name: 'API',
      full_name: 'Group/Subgroup/API',
      private: true,
      created_at: '2026-08-01T00:00:00Z',
      default_branch: 'release/Original',
    };
    const replacementProject = { ...project, default_branch: 'release/Replacement' };

    async function createIntegration(
      owner: Owner,
      metadata: unknown = { gitlab_instance_url: instanceUrl }
    ) {
      const [integration] = await db
        .insert(platform_integrations)
        .values({
          owned_by_user_id: owner.type === 'user' ? owner.id : null,
          owned_by_organization_id: owner.type === 'org' ? owner.id : null,
          platform: 'gitlab',
          integration_type: 'oauth',
          integration_status: 'active',
          repositories: [project],
          repositories_synced_at: '2026-08-29T08:00:00Z',
          metadata,
          updated_at: '2026-08-29 08:00:00.123456+00',
        })
        .returning();
      return integration;
    }

    beforeEach(() => {
      mockFetchGitLabProjects.mockReset();
      mockValidatePersonalAccessToken.mockReset();
      mockValidatePersonalAccessToken.mockResolvedValue({
        valid: true,
        user: {
          id: 123,
          username: 'gitlab-user',
          name: 'GitLab User',
          email: 'gitlab-user@example.com',
          avatar_url: 'https://gitlab.com/avatar.png',
          web_url: 'https://gitlab.com/gitlab-user',
        },
      });
      mockFetchGitLabCredential.mockReset();
      mockFetchGitLabCredential.mockResolvedValue({
        status: 'available',
        token: 'test-gitlab-token',
        instanceUrl,
        glabIsOAuth2: true,
      });
    });

    test.each([null, { gitlab_instance_url: instanceUrl }])(
      'updates a matching snapshot with metadata %j',
      async metadata => {
        const integration = await createIntegration({ type: 'user', id: userId }, metadata);
        await updateRepositoriesForIntegration(integration.id, [replacementProject], integration);
        const [current] = await db
          .select()
          .from(platform_integrations)
          .where(eq(platform_integrations.id, integration.id));
        expect(current.repositories).toEqual([replacementProject]);
      }
    );

    test.each(['timestamp', 'metadata'] as const)(
      'does not overwrite the cache or authorization after a changed %s',
      async changed => {
        const integration = await createIntegration({ type: 'user', id: userId });
        const [replacement] = await db
          .update(platform_integrations)
          .set({
            repositories: [replacementProject],
            repositories_synced_at: '2026-08-29T09:00:00Z',
            auth_invalid_at: '2026-08-29T09:00:00Z',
            auth_invalid_reason: 'reconnect_required',
            metadata:
              changed === 'metadata'
                ? { gitlab_instance_url: replacementUrl }
                : integration.metadata,
            updated_at: changed === 'timestamp' ? '2026-08-29T09:00:00Z' : integration.updated_at,
          })
          .where(eq(platform_integrations.id, integration.id))
          .returning();
        await updateRepositoriesForIntegration(integration.id, [project], integration);
        const [current] = await db
          .select()
          .from(platform_integrations)
          .where(eq(platform_integrations.id, integration.id));
        expect(current).toEqual(replacement);
      }
    );

    test('preserves the old two-argument cache writer', async () => {
      const integration = await createIntegration({ type: 'user', id: userId });
      await updateRepositoriesForIntegration(integration.id, [replacementProject]);
      const [current] = await db
        .select()
        .from(platform_integrations)
        .where(eq(platform_integrations.id, integration.id));
      expect(current.repositories).toEqual([replacementProject]);
    });

    test.each(['personal', 'organization', 'service'] as const)(
      'keeps the reconnected host cache after a late %s refresh',
      async context => {
        const owner: Owner =
          context === 'organization' ? { type: 'org', id: orgId } : { type: 'user', id: userId };
        const integration = await createIntegration(owner);
        mockFetchGitLabProjects.mockImplementationOnce(async () => {
          await db
            .update(platform_integrations)
            .set({
              metadata: { gitlab_instance_url: replacementUrl },
              repositories: [replacementProject],
              updated_at: '2026-08-29T09:00:00Z',
            })
            .where(eq(platform_integrations.id, integration.id));
          return [project];
        });
        const helpers = await import('@/lib/cloud-agent/gitlab-integration-helpers');
        const { listGitLabRepositories } = await import('../gitlab-service');
        const fresh =
          context === 'service'
            ? await listGitLabRepositories(owner, integration.id, { userId }, true)
            : owner.type === 'user'
              ? await helpers.fetchGitLabRepositoriesForUser(owner.id, true, integration.id)
              : await helpers.fetchGitLabRepositoriesForOrganization(
                  owner.id,
                  userId,
                  true,
                  integration.id
                );
        if ('instanceUrl' in fresh) {
          expect(fresh.instanceUrl).toBe(instanceUrl);
          expect(fresh.repositories[0]).toMatchObject({
            repositoryReference: {
              repository: { instanceUrl, repositoryId: '42', defaultBranch: 'release/Original' },
              authorization: { kind: 'ownerIntegration', owner, integrationId: integration.id },
            },
          });
        } else {
          expect(fresh.repositories).toEqual([project]);
        }
        const cached =
          owner.type === 'user'
            ? await helpers.fetchGitLabRepositoriesForUser(owner.id, false, integration.id)
            : await helpers.fetchGitLabRepositoriesForOrganization(
                owner.id,
                userId,
                false,
                integration.id
              );
        expect(cached.repositories[0]).toMatchObject({
          fullName: 'Group/Subgroup/API',
          defaultBranch: 'release/Replacement',
          repositoryReference: {
            repository: {
              instanceUrl: replacementUrl,
              repositoryId: '42',
              defaultBranch: 'release/Replacement',
            },
            authorization: { kind: 'ownerIntegration', owner, integrationId: integration.id },
          },
        });
      }
    );

    test('clears the old host cache before fetching projects during PAT reconnect', async () => {
      const owner: Owner = { type: 'user', id: userId };
      const integration = await createIntegration(owner);
      const service = await import('../gitlab-service');
      mockFetchGitLabProjects.mockImplementationOnce(async () => {
        const current = await service.getGitLabIntegration(owner, integration.id);
        expect(current?.metadata).toMatchObject({ gitlab_instance_url: replacementUrl });
        expect(current?.repositories).toBeNull();
        expect(current?.repositories_synced_at).toBeNull();
        return [replacementProject];
      });
      await expect(
        service.connectWithPAT(owner, 'test-pat', replacementUrl, userId)
      ).resolves.toMatchObject({
        success: true,
        integration: { id: integration.id, instanceUrl: replacementUrl },
      });
      const current = await service.getGitLabIntegration(owner, integration.id);
      expect(current?.repositories).toEqual([replacementProject]);
    });

    test.each(['existing', 'new'] as const)(
      'does not replace a reconnected cache after an %s PAT connection fetch',
      async kind => {
        const owner: Owner = { type: 'user', id: userId };
        if (kind === 'existing') await createIntegration(owner);
        const service = await import('../gitlab-service');
        mockFetchGitLabProjects.mockImplementationOnce(async () => {
          const current = await service.getGitLabIntegration(owner);
          if (!current) throw new Error('Missing test integration');
          await db
            .update(platform_integrations)
            .set({
              metadata: { gitlab_instance_url: replacementUrl },
              repositories: [replacementProject],
              updated_at: '2026-08-29T09:00:00Z',
            })
            .where(eq(platform_integrations.id, current.id));
          return [project];
        });
        await service.connectWithPAT(owner, 'test-pat', instanceUrl, userId);
        const current = await service.getGitLabIntegration(owner);
        expect(current?.metadata).toEqual({ gitlab_instance_url: replacementUrl });
        expect(current?.repositories).toEqual([replacementProject]);
      }
    );

    test.each(['user', 'org'] as const)(
      'rejects ambiguous legacy %s lookups but accepts exact selectors',
      async type => {
        const owner: Owner = type === 'user' ? { type, id: userId } : { type, id: orgId };
        const integration = await createIntegration(owner);
        const { getGitLabIntegration } = await import('../gitlab-service');
        expect((await getGitLabIntegration(owner))?.id).toBe(integration.id);
        const second = await createIntegration(owner, { gitlab_instance_url: replacementUrl });
        await expect(getGitLabIntegration(owner)).rejects.toMatchObject({ code: 'CONFLICT' });
        expect((await getGitLabIntegration(owner, integration.id))?.metadata).toEqual({
          gitlab_instance_url: instanceUrl,
        });
        expect((await getGitLabIntegration(owner, second.id))?.metadata).toEqual({
          gitlab_instance_url: replacementUrl,
        });
        const otherOwner: Owner =
          type === 'user' ? { type, id: otherUserId } : { type, id: otherOrgId };
        await expect(getGitLabIntegration(otherOwner, integration.id)).resolves.toBeNull();
        await expect(getGitLabIntegration(owner, crypto.randomUUID())).resolves.toBeNull();
      }
    );
  });

  describe('app-type-scoped destructive mutations', () => {
    const destructiveInstallId = `test-github-destructive-${Date.now()}`;
    const siblingInstallId = `test-github-destructive-sibling-${Date.now()}`;

    async function getRowsByInstallId() {
      return db
        .select()
        .from(platform_integrations)
        .where(
          and(
            eq(platform_integrations.platform, 'github'),
            eq(platform_integrations.platform_installation_id, destructiveInstallId)
          )
        );
    }

    async function getOrgRows() {
      return db
        .select()
        .from(platform_integrations)
        .where(
          and(
            eq(platform_integrations.platform, 'github'),
            eq(platform_integrations.owned_by_organization_id, orgId)
          )
        );
    }

    async function getUserRows() {
      return db
        .select()
        .from(platform_integrations)
        .where(
          and(
            eq(platform_integrations.platform, 'github'),
            eq(platform_integrations.owned_by_user_id, userId)
          )
        );
    }

    // The owner unique index `(owner, platform, installation_id)` forbids two
    // rows for the same owner and installation id, so an owner's standard and
    // lite rows live on separate installations. An unscoped owner mutation
    // (app-type predicate removed) would touch both rows; the app-type scoped
    // one must leave the lite sibling untouched.
    async function seedOrgSiblings() {
      await db.insert(platform_integrations).values([
        {
          owned_by_organization_id: orgId,
          platform: 'github',
          integration_type: 'app',
          platform_installation_id: destructiveInstallId,
          platform_account_id: '1000',
          platform_account_login: 'org-a',
          repository_access: 'all',
          integration_status: 'active',
          github_app_type: 'standard',
        },
        {
          owned_by_organization_id: orgId,
          platform: 'github',
          integration_type: 'app',
          platform_installation_id: siblingInstallId,
          platform_account_id: '2000',
          platform_account_login: 'org-b',
          repository_access: 'all',
          integration_status: 'active',
          github_app_type: 'lite',
        },
      ]);
    }

    async function seedUserSiblings() {
      await db.insert(platform_integrations).values([
        {
          owned_by_user_id: userId,
          platform: 'github',
          integration_type: 'app',
          platform_installation_id: destructiveInstallId,
          platform_account_id: '3000',
          platform_account_login: 'user-a',
          repository_access: 'all',
          integration_status: 'active',
          github_app_type: 'standard',
        },
        {
          owned_by_user_id: userId,
          platform: 'github',
          integration_type: 'app',
          platform_installation_id: siblingInstallId,
          platform_account_id: '4000',
          platform_account_login: 'user-b',
          repository_access: 'all',
          integration_status: 'active',
          github_app_type: 'lite',
        },
      ]);
    }

    // The installation-scoped update matches by installation id, so its
    // app-type predicate only matters when two rows share one installation id.
    // That arrangement is legal only across owners (one row per app type).
    async function seedOrgInstallationSiblings() {
      await db.insert(platform_integrations).values([
        {
          owned_by_organization_id: orgId,
          platform: 'github',
          integration_type: 'app',
          platform_installation_id: destructiveInstallId,
          platform_account_id: '1000',
          platform_account_login: 'org-a',
          repository_access: 'all',
          integration_status: 'active',
          github_app_type: 'standard',
        },
        {
          owned_by_organization_id: otherOrgId,
          platform: 'github',
          integration_type: 'app',
          platform_installation_id: destructiveInstallId,
          platform_account_id: '2000',
          platform_account_login: 'org-b',
          repository_access: 'all',
          integration_status: 'active',
          github_app_type: 'lite',
        },
      ]);
    }

    test('deleteIntegration with app type leaves the owner sibling app-type row', async () => {
      await seedOrgSiblings();

      await deleteIntegration(orgId, 'github', 'standard');

      const rows = await getOrgRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].platform_installation_id).toBe(siblingInstallId);
      expect(rows[0].github_app_type).toBe('lite');
    });

    test('suspendIntegration with app type leaves the owner sibling app-type row active', async () => {
      await seedOrgSiblings();

      await suspendIntegration(orgId, 'github', 'webhook-sender', 'standard');

      const rows = await getOrgRows();
      expect(rows).toHaveLength(2);
      const standard = rows.find(row => row.github_app_type === 'standard');
      const lite = rows.find(row => row.github_app_type === 'lite');
      expect(standard?.integration_status).toBe('suspended');
      expect(standard?.suspended_by).toBe('webhook-sender');
      expect(lite?.integration_status).toBe('active');
      expect(lite?.suspended_at).toBeNull();
    });

    test('unsuspendIntegration with app type leaves the owner sibling app-type row suspended', async () => {
      await seedOrgSiblings();
      await db
        .update(platform_integrations)
        .set({ integration_status: 'suspended' })
        .where(
          and(
            eq(platform_integrations.platform, 'github'),
            eq(platform_integrations.owned_by_organization_id, orgId)
          )
        );

      await unsuspendIntegration(orgId, 'github', 'standard');

      const rows = await getOrgRows();
      expect(rows).toHaveLength(2);
      const standard = rows.find(row => row.github_app_type === 'standard');
      const lite = rows.find(row => row.github_app_type === 'lite');
      expect(standard?.integration_status).toBe('active');
      expect(lite?.integration_status).toBe('suspended');
    });

    test('deleteIntegrationForOwner with app type leaves the owner sibling app-type row', async () => {
      await seedUserSiblings();

      await deleteIntegrationForOwner({ type: 'user', id: userId }, 'github', 'standard');

      const rows = await getUserRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].platform_installation_id).toBe(siblingInstallId);
      expect(rows[0].github_app_type).toBe('lite');
    });

    test('suspendIntegrationForOwner with app type leaves the owner sibling app-type row active', async () => {
      await seedUserSiblings();

      await suspendIntegrationForOwner(
        { type: 'user', id: userId },
        'github',
        'webhook-sender',
        'standard'
      );

      const rows = await getUserRows();
      expect(rows).toHaveLength(2);
      const standard = rows.find(row => row.github_app_type === 'standard');
      const lite = rows.find(row => row.github_app_type === 'lite');
      expect(standard?.integration_status).toBe('suspended');
      expect(lite?.integration_status).toBe('active');
    });

    test('unsuspendIntegrationForOwner with app type leaves the owner sibling app-type row suspended', async () => {
      await seedUserSiblings();
      await db
        .update(platform_integrations)
        .set({ integration_status: 'suspended' })
        .where(
          and(
            eq(platform_integrations.platform, 'github'),
            eq(platform_integrations.owned_by_user_id, userId)
          )
        );

      await unsuspendIntegrationForOwner({ type: 'user', id: userId }, 'github', 'standard');

      const rows = await getUserRows();
      expect(rows).toHaveLength(2);
      const standard = rows.find(row => row.github_app_type === 'standard');
      const lite = rows.find(row => row.github_app_type === 'lite');
      expect(standard?.integration_status).toBe('active');
      expect(lite?.integration_status).toBe('suspended');
    });

    test('updateIntegrationRepositories with app type updates only the matched row', async () => {
      await seedOrgInstallationSiblings();

      await updateIntegrationRepositories(
        'github',
        destructiveInstallId,
        [{ id: 999, name: 'new-repo', full_name: 'acme/new-repo', private: false }],
        'standard'
      );

      const rows = await getRowsByInstallId();
      expect(rows).toHaveLength(2);
      const standard = rows.find(row => row.github_app_type === 'standard');
      const lite = rows.find(row => row.github_app_type === 'lite');
      expect(standard?.repositories).toEqual([
        { id: 999, name: 'new-repo', full_name: 'acme/new-repo', private: false },
      ]);
      expect(lite?.repositories).toBeNull();
    });

    // Two rows for the same owner, same app type, but different installation
    // ids are legal (the GitHub unique index is keyed per installation id).
    // A mutation scoped only to owner and app type would touch both rows; the
    // installation-scoped one must leave the sibling untouched.
    async function seedOrgSameAppTypeSiblings() {
      await db.insert(platform_integrations).values([
        {
          owned_by_organization_id: orgId,
          platform: 'github',
          integration_type: 'app',
          platform_installation_id: destructiveInstallId,
          platform_account_id: '1000',
          platform_account_login: 'org-a',
          repository_access: 'all',
          integration_status: 'active',
          github_app_type: 'standard',
        },
        {
          owned_by_organization_id: orgId,
          platform: 'github',
          integration_type: 'app',
          platform_installation_id: siblingInstallId,
          platform_account_id: '2000',
          platform_account_login: 'org-b',
          repository_access: 'all',
          integration_status: 'active',
          github_app_type: 'standard',
        },
      ]);
    }

    async function seedUserSameAppTypeSiblings() {
      await db.insert(platform_integrations).values([
        {
          owned_by_user_id: userId,
          platform: 'github',
          integration_type: 'app',
          platform_installation_id: destructiveInstallId,
          platform_account_id: '3000',
          platform_account_login: 'user-a',
          repository_access: 'all',
          integration_status: 'active',
          github_app_type: 'standard',
        },
        {
          owned_by_user_id: userId,
          platform: 'github',
          integration_type: 'app',
          platform_installation_id: siblingInstallId,
          platform_account_id: '4000',
          platform_account_login: 'user-b',
          repository_access: 'all',
          integration_status: 'active',
          github_app_type: 'standard',
        },
      ]);
    }

    test('deleteIntegration with installation id leaves the same-owner same-app-type sibling', async () => {
      await seedOrgSameAppTypeSiblings();

      await deleteIntegration(orgId, 'github', 'standard', destructiveInstallId);

      const rows = await getOrgRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].platform_installation_id).toBe(siblingInstallId);
      expect(rows[0].github_app_type).toBe('standard');
    });

    test('suspendIntegration with installation id leaves the same-owner same-app-type sibling active', async () => {
      await seedOrgSameAppTypeSiblings();

      await suspendIntegration(orgId, 'github', 'webhook-sender', 'standard', destructiveInstallId);

      const rows = await getOrgRows();
      expect(rows).toHaveLength(2);
      const matched = rows.find(row => row.platform_installation_id === destructiveInstallId);
      const sibling = rows.find(row => row.platform_installation_id === siblingInstallId);
      expect(matched?.integration_status).toBe('suspended');
      expect(matched?.suspended_by).toBe('webhook-sender');
      expect(sibling?.integration_status).toBe('active');
      expect(sibling?.suspended_at).toBeNull();
    });

    test('unsuspendIntegration with installation id leaves the same-owner same-app-type sibling suspended', async () => {
      await seedOrgSameAppTypeSiblings();
      await db
        .update(platform_integrations)
        .set({ integration_status: 'suspended' })
        .where(
          and(
            eq(platform_integrations.platform, 'github'),
            eq(platform_integrations.owned_by_organization_id, orgId)
          )
        );

      await unsuspendIntegration(orgId, 'github', 'standard', destructiveInstallId);

      const rows = await getOrgRows();
      expect(rows).toHaveLength(2);
      const matched = rows.find(row => row.platform_installation_id === destructiveInstallId);
      const sibling = rows.find(row => row.platform_installation_id === siblingInstallId);
      expect(matched?.integration_status).toBe('active');
      expect(sibling?.integration_status).toBe('suspended');
    });

    test('deleteIntegrationForOwner with installation id leaves the same-owner same-app-type sibling', async () => {
      await seedUserSameAppTypeSiblings();

      await deleteIntegrationForOwner(
        { type: 'user', id: userId },
        'github',
        'standard',
        destructiveInstallId
      );

      const rows = await getUserRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].platform_installation_id).toBe(siblingInstallId);
      expect(rows[0].github_app_type).toBe('standard');
    });

    test('suspendIntegrationForOwner with installation id leaves the same-owner same-app-type sibling active', async () => {
      await seedUserSameAppTypeSiblings();

      await suspendIntegrationForOwner(
        { type: 'user', id: userId },
        'github',
        'webhook-sender',
        'standard',
        destructiveInstallId
      );

      const rows = await getUserRows();
      expect(rows).toHaveLength(2);
      const matched = rows.find(row => row.platform_installation_id === destructiveInstallId);
      const sibling = rows.find(row => row.platform_installation_id === siblingInstallId);
      expect(matched?.integration_status).toBe('suspended');
      expect(sibling?.integration_status).toBe('active');
    });

    test('unsuspendIntegrationForOwner with installation id leaves the same-owner same-app-type sibling suspended', async () => {
      await seedUserSameAppTypeSiblings();
      await db
        .update(platform_integrations)
        .set({ integration_status: 'suspended' })
        .where(
          and(
            eq(platform_integrations.platform, 'github'),
            eq(platform_integrations.owned_by_user_id, userId)
          )
        );

      await unsuspendIntegrationForOwner(
        { type: 'user', id: userId },
        'github',
        'standard',
        destructiveInstallId
      );

      const rows = await getUserRows();
      expect(rows).toHaveLength(2);
      const matched = rows.find(row => row.platform_installation_id === destructiveInstallId);
      const sibling = rows.find(row => row.platform_installation_id === siblingInstallId);
      expect(matched?.integration_status).toBe('active');
      expect(sibling?.integration_status).toBe('suspended');
    });
  });
});
