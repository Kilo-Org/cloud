import { beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { platform_integrations, type Organization, type User } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  addUserToOrganization,
  createOrganization,
} from '@kilocode/web-shared/lib/organizations/organizations';
import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { GITLAB_PROJECT_NOT_IN_CACHE_MESSAGE } from '@/lib/integrations/platforms/gitlab/project-scope';

// @swc/jest only hoists `jest.mock` calls when `jest` is the GLOBAL binding, so
// `jest` is not imported from '@jest/globals' here. Same pattern as
// cloud-agent-next-router.branches.test.ts.
const mockFetchGitLabCredential = jest.fn();
jest.mock('@/lib/integrations/platforms/gitlab/credential-broker-client', () => ({
  ...jest.requireActual('@/lib/integrations/platforms/gitlab/credential-broker-client'),
  fetchGitLabCredential: (...a: unknown[]) => mockFetchGitLabCredential(...a),
}));

const mockFetchGitLabBranches = jest.fn();
jest.mock('@/lib/integrations/platforms/gitlab/adapter', () => ({
  ...jest.requireActual('@/lib/integrations/platforms/gitlab/adapter'),
  fetchGitLabBranches: (...a: unknown[]) => mockFetchGitLabBranches(...a),
}));

let organization: Organization;
let member: User;

beforeAll(async () => {
  const owner = await insertTestUser();
  member = await insertTestUser();
  organization = await createOrganization(`GitLab router ${crypto.randomUUID()}`, owner.id);
  await addUserToOrganization(organization.id, member.id, 'member');
});

describe('gitlabRouter.getInstallation', () => {
  it('allows organization members to read installation status', async () => {
    const caller = await createCallerForUser(member.id);

    await expect(
      caller.gitlab.getInstallation({ organizationId: organization.id })
    ).resolves.toEqual({ installed: false, installation: null });
  });

  it.each([
    ['suspended_at', { suspended_at: new Date().toISOString() }],
    ['auth_invalid_at', { auth_invalid_at: new Date().toISOString() }],
  ] as const)('does not report an integration with %s as installed', async (_field, state) => {
    await db
      .delete(platform_integrations)
      .where(eq(platform_integrations.owned_by_organization_id, organization.id));
    await db.insert(platform_integrations).values({
      owned_by_organization_id: organization.id,
      platform: 'gitlab',
      integration_type: 'oauth',
      platform_installation_id: crypto.randomUUID(),
      integration_status: 'active',
      repository_access: 'all',
      ...state,
    });
    const caller = await createCallerForUser(member.id);

    const result = await caller.gitlab.getInstallation({ organizationId: organization.id });

    expect(result.installed).toBe(false);
    expect(result.installation).not.toBeNull();
  });
});

describe('gitlabRouter.listBranches', () => {
  /** A cached project: nested namespace, mixed casing as GitLab stores it. */
  const cachedProject = {
    id: 41,
    name: 'Repo',
    full_name: 'Group/Sub/Repo',
    private: true,
  };

  async function insertIntegration(overrides: Partial<typeof platform_integrations.$inferInsert>) {
    await db
      .delete(platform_integrations)
      .where(eq(platform_integrations.owned_by_organization_id, organization.id));
    const [row] = await db
      .insert(platform_integrations)
      .values({
        owned_by_organization_id: organization.id,
        platform: 'gitlab',
        integration_type: 'pat',
        integration_status: 'active',
        repository_access: 'all',
        metadata: { gitlab_instance_url: 'https://gitlab.com', auth_type: 'pat' },
        repositories: [cachedProject],
        repositories_synced_at: '2026-10-01T00:00:00.000Z',
        ...overrides,
      })
      .returning();
    return row;
  }

  beforeEach(() => {
    mockFetchGitLabCredential.mockReset();
    mockFetchGitLabBranches.mockReset();
    mockFetchGitLabCredential.mockResolvedValue({
      status: 'available',
      token: 'glpat-test-token',
      instanceUrl: 'https://gitlab.com',
      glabIsOAuth2: false,
    });
    mockFetchGitLabBranches.mockResolvedValue([
      { name: 'main', default: true, protected: true },
      { name: 'feature/x', default: false, protected: false },
    ]);
  });

  it('lists the branches of a project in the connection cache, addressed by any casing', async () => {
    const integration = await insertIntegration({});
    const caller = await createCallerForUser(member.id);

    const result = await caller.gitlab.listBranches({
      organizationId: organization.id,
      integrationId: integration.id,
      projectPath: '/group/sub/repo/',
    });

    expect(result).toEqual({
      branches: [
        { name: 'main', isDefault: true },
        { name: 'feature/x', isDefault: false },
      ],
    });
    // The provider request carries the connection's canonical project path,
    // not the caller's spelling.
    expect(mockFetchGitLabBranches).toHaveBeenCalledWith(
      'glpat-test-token',
      'Group/Sub/Repo',
      'https://gitlab.com'
    );
  });

  it.each(['other-group/private-project', 'Group/Sub', 'Sub/Repo', 'Group/Sub/Repo-Fork'])(
    'refuses "%s" — outside the connection cache — before any credential is released',
    async projectPath => {
      const integration = await insertIntegration({});
      const caller = await createCallerForUser(member.id);

      await expect(
        caller.gitlab.listBranches({
          organizationId: organization.id,
          integrationId: integration.id,
          projectPath,
        })
      ).rejects.toMatchObject({
        code: 'NOT_FOUND',
        message: GITLAB_PROJECT_NOT_IN_CACHE_MESSAGE,
      });
      expect(mockFetchGitLabCredential).not.toHaveBeenCalled();
      expect(mockFetchGitLabBranches).not.toHaveBeenCalled();
    }
  );

  it('refuses every project when the connection has no cached repositories', async () => {
    const integration = await insertIntegration({
      repositories: null,
      repositories_synced_at: null,
    });
    const caller = await createCallerForUser(member.id);

    await expect(
      caller.gitlab.listBranches({
        organizationId: organization.id,
        integrationId: integration.id,
        projectPath: 'Group/Sub/Repo',
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mockFetchGitLabCredential).not.toHaveBeenCalled();
    expect(mockFetchGitLabBranches).not.toHaveBeenCalled();
  });

  it('refuses an integration id that does not belong to the caller owner', async () => {
    const otherOwner = await insertTestUser();
    const [foreignRow] = await db
      .insert(platform_integrations)
      .values({
        owned_by_user_id: otherOwner.id,
        platform: 'gitlab',
        integration_type: 'pat',
        integration_status: 'active',
        repository_access: 'all',
        repositories: [cachedProject],
        repositories_synced_at: '2026-10-01T00:00:00.000Z',
      })
      .returning();
    const caller = await createCallerForUser(member.id);

    await expect(
      caller.gitlab.listBranches({
        organizationId: organization.id,
        integrationId: foreignRow.id,
        projectPath: 'Group/Sub/Repo',
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'GitLab integration not found' });
    expect(mockFetchGitLabCredential).not.toHaveBeenCalled();
    expect(mockFetchGitLabBranches).not.toHaveBeenCalled();
  });
});
