import { randomInt } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import {
  github_app_installations,
  organizations,
  platform_integrations,
  type PlatformIntegration,
} from '@kilocode/db/schema';
import type { PlatformRepository } from '@/lib/integrations/core/types';
import { getIntegrationForOwner } from '@/lib/integrations/db/platform-integrations';
import { getInstallation } from '@/lib/integrations/github-apps-service';
import {
  fetchGitHubInstallationDetails,
  fetchGitHubRepositories,
  generateGitHubInstallationToken,
} from '@/lib/integrations/platforms/github/adapter';
import {
  fetchAllGitHubRepositoriesForOrganization,
  fetchGitHubRepositoriesForUser,
  getGitHubInstallationIdForUser,
  getGitHubTokenForUser,
} from '@/lib/cloud-agent/github-integration-helpers';
import { createCallerForUser } from '@/routers/test-utils';

jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  ...jest.requireActual<Record<string, unknown>>('@/lib/integrations/platforms/github/adapter'),
  fetchGitHubInstallationDetails: jest.fn(),
  fetchGitHubRepositories: jest.fn(),
  generateGitHubInstallationToken: jest.fn(),
}));

const mockFetchGitHubInstallationDetails = jest.mocked(fetchGitHubInstallationDetails);
const mockFetchGitHubRepositories = jest.mocked(fetchGitHubRepositories);
const mockGenerateGitHubInstallationToken = jest.mocked(generateGitHubInstallationToken);

const deletedInstallationIds = new Set<string>();

function rejectDeletedInstallation(installationId: string) {
  if (deletedInstallationIds.has(installationId)) {
    throw Object.assign(new Error('Not Found'), { status: 404 });
  }
}

let repositoryId = 1;
function repository(name: string): PlatformRepository {
  return { id: repositoryId++, name, full_name: `synthetic-github-org/${name}`, private: true };
}

let installationIdSequence = randomInt(100_000_000, 900_000_000);
function nextInstallationId() {
  return String(installationIdSequence++);
}

function requestedInstallationIds() {
  return [
    ...mockFetchGitHubInstallationDetails.mock.calls,
    ...mockFetchGitHubRepositories.mock.calls,
    ...mockGenerateGitHubInstallationToken.mock.calls,
  ].map(([installationId]) => installationId);
}

type AssociationState = Partial<
  Pick<
    PlatformIntegration,
    | 'integration_status'
    | 'suspended_at'
    | 'suspended_by'
    | 'auth_invalid_at'
    | 'auth_invalid_reason'
    | 'github_disconnected_at'
    | 'created_at'
    | 'updated_at'
  >
>;

async function insertPersonalAssociation(
  userId: string,
  lifecycleState: 'active' | 'deleted',
  state: AssociationState
) {
  const installationId = nextInstallationId();
  const [canonical] = await db
    .insert(github_app_installations)
    .values({
      github_app_type: 'standard',
      installation_id: installationId,
      lifecycle_state: lifecycleState,
      deleted_at: lifecycleState === 'deleted' ? '2026-03-01T00:00:00.000Z' : null,
    })
    .returning();
  const [association] = await db
    .insert(platform_integrations)
    .values({
      owned_by_user_id: userId,
      platform: 'github',
      integration_type: 'app',
      github_connection_role: 'workflow',
      github_app_type: 'standard',
      github_installation_id: canonical.id,
      platform_installation_id: installationId,
      platform_account_login: 'synthetic-github-org',
      repository_access: 'selected',
      repositories: [repository(`repo-${installationId}`)],
      repositories_synced_at: '2026-04-01T00:00:00.000Z',
      integration_status: 'active',
      ...state,
    })
    .returning();
  if (lifecycleState === 'deleted') deletedInstallationIds.add(installationId);
  return { association, canonical, installationId };
}

const deletedBeforeReinstall: AssociationState = {
  integration_status: 'suspended',
  suspended_at: '2026-03-01T00:00:00.000Z',
  suspended_by: 'github_deleted',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-03-01T00:00:00.000Z',
};

/**
 * As after a real reinstall, the historical association is older and has the
 * lower installation ID, so an unordered lookup through the owner/installation
 * index returns it first.
 */
async function seedReinstalledPersonalWorkspace() {
  const user = await insertTestUser();
  const historical = await insertPersonalAssociation(user.id, 'deleted', deletedBeforeReinstall);
  const current = await insertPersonalAssociation(user.id, 'active', {
    created_at: '2026-04-01T00:00:00.000Z',
    updated_at: '2026-04-01T00:00:00.000Z',
  });
  return { user, historical, current };
}

async function expectHistoricalAssociationPreserved(
  historical: Awaited<ReturnType<typeof insertPersonalAssociation>>
) {
  const [association] = await db
    .select()
    .from(platform_integrations)
    .where(eq(platform_integrations.id, historical.association.id));
  expect(association).toMatchObject({
    integration_status: 'suspended',
    suspended_by: 'github_deleted',
    github_installation_id: historical.canonical.id,
    platform_installation_id: historical.installationId,
    repositories: historical.association.repositories,
  });
  const [canonical] = await db
    .select()
    .from(github_app_installations)
    .where(eq(github_app_installations.id, historical.canonical.id));
  expect(canonical).toMatchObject({ lifecycle_state: 'deleted' });
  expect(canonical?.deleted_at).not.toBeNull();
}

beforeEach(() => {
  mockFetchGitHubInstallationDetails.mockReset().mockImplementation(async installationId => {
    rejectDeletedInstallation(installationId);
    return {
      id: Number(installationId),
      account: { id: 4242, login: 'synthetic-github-org', type: 'Organization' },
      repository_selection: 'selected',
      permissions: { contents: 'write' },
      events: ['pull_request'],
      created_at: '2026-04-01T00:00:00.000Z',
    };
  });
  mockFetchGitHubRepositories.mockReset().mockImplementation(async installationId => {
    rejectDeletedInstallation(installationId);
    return [
      { ...repository(`refreshed-${installationId}`), created_at: '2026-04-01T00:00:00.000Z' },
    ];
  });
  mockGenerateGitHubInstallationToken.mockReset().mockImplementation(async installationId => {
    rejectDeletedInstallation(installationId);
    return { token: `token-for-${installationId}`, expires_at: '2099-01-01T00:00:00.000Z' };
  });
});

describe('personal GitHub installation selection after a reinstall', () => {
  it('resolves the reinstalled installation for the badge and operational lookups', async () => {
    const { user, current } = await seedReinstalledPersonalWorkspace();
    const owner = { type: 'user' as const, id: user.id };

    expect((await getInstallation(owner))?.id).toBe(current.association.id);
    expect((await getIntegrationForOwner(owner, 'github'))?.id).toBe(current.association.id);
    expect((await getIntegrationForOwner(owner, 'github', 'active'))?.id).toBe(
      current.association.id
    );
  });

  it('keeps the status argument as a filter rather than a health override', async () => {
    const { user, historical } = await seedReinstalledPersonalWorkspace();

    const suspended = await getIntegrationForOwner(
      { type: 'user', id: user.id },
      'github',
      'suspended'
    );

    expect(suspended?.id).toBe(historical.association.id);
  });

  it('lists repositories and mints credentials only for the reinstalled installation', async () => {
    const { user, historical, current } = await seedReinstalledPersonalWorkspace();

    const cached = await fetchGitHubRepositoriesForUser(user.id);
    expect(cached.integrationInstalled).toBe(true);
    expect(cached.repositories.map(repo => repo.platformIntegrationId)).toEqual([
      current.association.id,
    ]);

    const refreshed = await fetchGitHubRepositoriesForUser(user.id, true);
    expect(refreshed.repositories.map(repo => repo.fullName)).toEqual([
      `synthetic-github-org/refreshed-${current.installationId}`,
    ]);
    expect(await getGitHubTokenForUser(user.id)).toBe(`token-for-${current.installationId}`);
    expect(await getGitHubInstallationIdForUser(user.id)).toBe(current.installationId);

    expect(requestedInstallationIds()).not.toContain(historical.installationId);
    await expectHistoricalAssociationPreserved(historical);
  });

  it('shows the reinstalled installation and refreshes it by the displayed integration id', async () => {
    const { user, historical, current } = await seedReinstalledPersonalWorkspace();
    const caller = await createCallerForUser(user.id);

    const badge = await caller.githubApps.getInstallation();
    expect(badge.installed).toBe(true);
    expect(badge.installation).toMatchObject({
      id: current.association.id,
      installationId: current.installationId,
    });

    await expect(
      caller.githubApps.refreshInstallation({ integrationId: badge.installation?.id })
    ).resolves.toEqual({ success: true });

    expect(mockFetchGitHubInstallationDetails).toHaveBeenCalledTimes(1);
    expect(mockFetchGitHubInstallationDetails).toHaveBeenCalledWith(
      current.installationId,
      'standard'
    );
    expect(requestedInstallationIds()).not.toContain(historical.installationId);
    await expectHistoricalAssociationPreserved(historical);
  });

  it('refreshes the reinstalled installation when an older client omits the integration id', async () => {
    const { user, historical, current } = await seedReinstalledPersonalWorkspace();
    const caller = await createCallerForUser(user.id);

    await expect(caller.githubApps.refreshInstallation()).resolves.toEqual({ success: true });

    expect(mockFetchGitHubInstallationDetails).toHaveBeenCalledWith(
      current.installationId,
      'standard'
    );
    expect(requestedInstallationIds()).not.toContain(historical.installationId);
    await expectHistoricalAssociationPreserved(historical);
  });
});

describe('personal GitHub workspace without a healthy installation', () => {
  it.each([
    {
      name: 'deleted and suspended',
      lifecycleState: 'deleted' as const,
      state: deletedBeforeReinstall,
      message: 'GitHub integration is suspended',
    },
    {
      name: 'locally disconnected',
      lifecycleState: 'active' as const,
      state: { github_disconnected_at: '2026-03-01T00:00:00.000Z' },
      message: 'GitHub integration is disconnected',
    },
    {
      name: 'auth-invalid',
      lifecycleState: 'active' as const,
      state: {
        auth_invalid_at: '2026-03-01T00:00:00.000Z',
        auth_invalid_reason: 'installation_token_auth_failed',
      },
      message: 'GitHub integration requires reauthorization',
    },
  ])('stays unavailable when the only installation is $name', async testCase => {
    const user = await insertTestUser();
    const { association } = await insertPersonalAssociation(
      user.id,
      testCase.lifecycleState,
      testCase.state
    );
    const caller = await createCallerForUser(user.id);

    const badge = await caller.githubApps.getInstallation();
    expect(badge.installed).toBe(false);
    expect(badge.installation?.id).toBe(association.id);
    expect(await fetchGitHubRepositoriesForUser(user.id)).toEqual({
      integrationInstalled: false,
      repositories: [],
      syncedAt: null,
      errorMessage: testCase.message,
    });
    expect(await getGitHubTokenForUser(user.id)).toBeUndefined();
    expect(await getGitHubInstallationIdForUser(user.id)).toBeUndefined();
    expect(mockGenerateGitHubInstallationToken).not.toHaveBeenCalled();
    expect(mockFetchGitHubRepositories).not.toHaveBeenCalled();
  });

  it('stays unavailable when every installation is unhealthy', async () => {
    const user = await insertTestUser();
    await insertPersonalAssociation(user.id, 'deleted', deletedBeforeReinstall);
    await insertPersonalAssociation(user.id, 'active', {
      github_disconnected_at: '2026-04-01T00:00:00.000Z',
      updated_at: '2026-04-01T00:00:00.000Z',
    });

    const result = await fetchGitHubRepositoriesForUser(user.id);

    expect(result.integrationInstalled).toBe(false);
    expect(await getGitHubTokenForUser(user.id)).toBeUndefined();
    expect(await getGitHubInstallationIdForUser(user.id)).toBeUndefined();
    expect(requestedInstallationIds()).toEqual([]);
  });
});

describe('organization GitHub installations', () => {
  it('keeps the oldest healthy installation primary and lists every healthy installation', async () => {
    const [organization] = await db
      .insert(organizations)
      .values({ name: `GitHub multi-installation ${crypto.randomUUID()}` })
      .returning();
    const organizationAssociation = (createdAt: string, state: AssociationState = {}) => ({
      owned_by_organization_id: organization.id,
      platform: 'github',
      integration_type: 'app',
      github_connection_role: 'workflow' as const,
      github_app_type: 'standard' as const,
      platform_installation_id: nextInstallationId(),
      repository_access: 'selected',
      repositories: [repository(`org-repo-${createdAt}`)],
      repositories_synced_at: '2026-04-01T00:00:00.000Z',
      integration_status: 'active',
      created_at: createdAt,
      ...state,
    });
    const [suspended, primary, secondary] = await db
      .insert(platform_integrations)
      .values([
        organizationAssociation('2026-01-01T00:00:00.000Z', {
          integration_status: 'suspended',
          suspended_at: '2026-03-01T00:00:00.000Z',
          suspended_by: 'github_deleted',
        }),
        organizationAssociation('2026-02-01T00:00:00.000Z'),
        organizationAssociation('2026-03-01T00:00:00.000Z'),
      ])
      .returning();

    const owner = { type: 'org' as const, id: organization.id };
    expect((await getIntegrationForOwner(owner, 'github'))?.id).toBe(primary.id);
    expect((await getInstallation(owner))?.id).toBe(primary.id);

    const listed = await fetchAllGitHubRepositoriesForOrganization(organization.id);
    expect(new Set(listed.repositories.map(repo => repo.platformIntegrationId))).toEqual(
      new Set([primary.id, secondary.id])
    );
    expect(listed.repositories.map(repo => repo.platformIntegrationId)).not.toContain(suspended.id);
  });
});
