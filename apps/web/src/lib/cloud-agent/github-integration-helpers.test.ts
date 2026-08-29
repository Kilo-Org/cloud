import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import type { PlatformIntegration } from '@kilocode/db/schema';
import type { Owner } from '@/lib/integrations/core/types';

// Define mock functions at module level with proper typing
const mockGetIntegrationForOrganization =
  jest.fn<(organizationId: string, platform: string) => Promise<PlatformIntegration | null>>();
const mockGetIntegrationForOwner =
  jest.fn<(owner: Owner, platform: string) => Promise<PlatformIntegration | null>>();
const mockGetPrimaryGitHubIntegrationForOrganization =
  jest.fn<(organizationId: string) => Promise<PlatformIntegration | null>>();
const mockUpdateRepositoriesForIntegration =
  jest.fn<(integrationId: string, repositories: unknown[]) => Promise<void>>();
const mockGetIntegrationsByOrganization =
  jest.fn<(organizationId: string, platform: string) => Promise<PlatformIntegration[]>>();
const mockFetchGitHubRepositories =
  jest.fn<(installationId: string, appType: string) => Promise<unknown[]>>();
const mockGenerateGitHubInstallationToken =
  jest.fn<(installationId: string, appType: string) => Promise<{ token: string }>>();
const mockCheckExistingFork =
  jest.fn<
    (
      installationId: string,
      accountLogin: string,
      sourceOwner: string,
      sourceRepoName: string
    ) => Promise<{ exists: boolean; fullName: string | null }>
  >();

// Wire up the mocks
jest.mock('@/lib/integrations/db/platform-integrations', () => ({
  getGitHubIntegrationById: jest.fn(),
  getIntegrationForOrganization: mockGetIntegrationForOrganization,
  getIntegrationForOwner: mockGetIntegrationForOwner,
  getPrimaryGitHubIntegrationForOrganization: mockGetPrimaryGitHubIntegrationForOrganization,
  getIntegrationsByOrganization: mockGetIntegrationsByOrganization,
  updateRepositoriesForIntegration: mockUpdateRepositoriesForIntegration,
}));

jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  fetchGitHubBranches: jest.fn(),
  fetchGitHubRepositories: mockFetchGitHubRepositories,
  generateGitHubInstallationToken: mockGenerateGitHubInstallationToken,
  checkExistingFork: mockCheckExistingFork,
}));

jest.mock('@/components/cloud-agent/demo-config', () => ({
  DEMO_SOURCE_OWNER: 'demo-owner',
  DEMO_SOURCE_REPO_NAME: 'demo-repo',
}));

const cachedRepositories = [{ id: 1, name: 'repo', full_name: 'org/repo', private: false }];

const buildIntegration = (overrides: Partial<PlatformIntegration> = {}): PlatformIntegration =>
  ({
    id: 'integration-1',
    platform: 'github',
    integration_status: 'active',
    suspended_at: null,
    auth_invalid_at: null,
    platform_installation_id: 'installation-1',
    github_app_type: 'standard',
    repositories: cachedRepositories,
    repositories_synced_at: '2024-01-01T00:00:00Z',
    ...overrides,
  }) as PlatformIntegration;

describe('github-integration-helpers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
  });

  describe('fetchGitHubRepositoriesForUser', () => {
    it('returns cached repositories for an active integration', async () => {
      mockGetIntegrationForOwner.mockResolvedValue(buildIntegration());

      const { fetchGitHubRepositoriesForUser } = await import('./github-integration-helpers');
      const result = await fetchGitHubRepositoriesForUser('user-123');

      expect(result.integrationInstalled).toBe(true);
      expect(result.repositories).toEqual([
        expect.objectContaining({ id: 1, name: 'repo', fullName: 'org/repo', private: false }),
      ]);
      expect(mockFetchGitHubRepositories).not.toHaveBeenCalled();
    });

    it('returns integrationInstalled false when no integration exists', async () => {
      mockGetIntegrationForOwner.mockResolvedValue(null);

      const { fetchGitHubRepositoriesForUser } = await import('./github-integration-helpers');
      const result = await fetchGitHubRepositoriesForUser('user-123');

      expect(result.integrationInstalled).toBe(false);
      expect(result.repositories).toEqual([]);
    });

    it('returns no repositories when the integration is suspended', async () => {
      mockGetIntegrationForOwner.mockResolvedValue(
        buildIntegration({
          integration_status: 'suspended',
          suspended_at: '2026-06-25 18:00:00+00',
          suspended_by: 'someone',
        })
      );

      const { fetchGitHubRepositoriesForUser } = await import('./github-integration-helpers');
      const result = await fetchGitHubRepositoriesForUser('user-123');

      expect(result.integrationInstalled).toBe(false);
      expect(result.repositories).toEqual([]);
      expect(result.errorMessage).toBe('GitHub integration is suspended');
      expect(mockFetchGitHubRepositories).not.toHaveBeenCalled();
    });

    it('returns no repositories when suspended_at is set even if status is active', async () => {
      mockGetIntegrationForOwner.mockResolvedValue(
        buildIntegration({ suspended_at: '2026-06-25 18:00:00+00' })
      );

      const { fetchGitHubRepositoriesForUser } = await import('./github-integration-helpers');
      const result = await fetchGitHubRepositoriesForUser('user-123');

      expect(result.integrationInstalled).toBe(false);
      expect(result.repositories).toEqual([]);
      expect(mockFetchGitHubRepositories).not.toHaveBeenCalled();
    });

    it('does not refresh repositories for a suspended integration even with forceRefresh', async () => {
      mockGetIntegrationForOwner.mockResolvedValue(
        buildIntegration({ integration_status: 'suspended' })
      );

      const { fetchGitHubRepositoriesForUser } = await import('./github-integration-helpers');
      const result = await fetchGitHubRepositoriesForUser('user-123', true);

      expect(result.integrationInstalled).toBe(false);
      expect(mockFetchGitHubRepositories).not.toHaveBeenCalled();
      expect(mockUpdateRepositoriesForIntegration).not.toHaveBeenCalled();
    });

    it('fetches fresh repositories when forceRefresh is true', async () => {
      mockGetIntegrationForOwner.mockResolvedValue(buildIntegration());
      mockFetchGitHubRepositories.mockResolvedValue([
        { id: 2, name: 'fresh', full_name: 'org/fresh', private: true },
      ]);

      const { fetchGitHubRepositoriesForUser } = await import('./github-integration-helpers');
      const result = await fetchGitHubRepositoriesForUser('user-123', true);

      expect(result.integrationInstalled).toBe(true);
      expect(result.repositories).toEqual([
        expect.objectContaining({ id: 2, name: 'fresh', fullName: 'org/fresh', private: true }),
      ]);
      expect(mockUpdateRepositoriesForIntegration).toHaveBeenCalledWith('integration-1', [
        { id: 2, name: 'fresh', full_name: 'org/fresh', private: true },
      ]);
    });
  });

  describe('fetchGitHubRepositoriesForOrganization', () => {
    it('returns cached repositories for an active integration', async () => {
      mockGetIntegrationsByOrganization.mockResolvedValue([buildIntegration()]);

      const { fetchAllGitHubRepositoriesForOrganization } =
        await import('./github-integration-helpers');
      const result = await fetchAllGitHubRepositoriesForOrganization('org-123');

      expect(result.integrationInstalled).toBe(true);
      expect(result.repositories).toEqual([
        expect.objectContaining({
          id: 1,
          name: 'repo',
          fullName: 'org/repo',
          private: false,
          platformIntegrationId: 'integration-1',
        }),
      ]);
      expect(mockFetchGitHubRepositories).not.toHaveBeenCalled();
    });

    it('preserves installation provenance across multiple GitHub organizations', async () => {
      mockGetIntegrationsByOrganization.mockResolvedValue([
        buildIntegration({
          id: 'integration-1',
          platform_account_login: 'acme-core',
          repositories: [{ id: 1, name: 'api', full_name: 'acme-core/api', private: true }],
        }),
        buildIntegration({
          id: 'integration-2',
          platform_installation_id: 'installation-2',
          platform_account_login: 'acme-security',
          repositories: [
            { id: 2, name: 'scanner', full_name: 'acme-security/scanner', private: true },
          ],
        }),
      ]);

      const { fetchAllGitHubRepositoriesForOrganization } =
        await import('./github-integration-helpers');
      const result = await fetchAllGitHubRepositoriesForOrganization('org-123');

      expect(result.repositories).toEqual([
        expect.objectContaining({
          fullName: 'acme-core/api',
          platformIntegrationId: 'integration-1',
          platformAccountLogin: 'acme-core',
        }),
        expect.objectContaining({
          fullName: 'acme-security/scanner',
          platformIntegrationId: 'integration-2',
          platformAccountLogin: 'acme-security',
        }),
      ]);
    });

    it('returns repositories from healthy installations when a sibling fetch fails', async () => {
      mockGetIntegrationsByOrganization.mockResolvedValue([
        buildIntegration({
          id: 'integration-1',
          repositories: [{ id: 1, name: 'api', full_name: 'acme-core/api', private: true }],
        }),
        buildIntegration({
          id: 'integration-2',
          platform_installation_id: 'installation-2',
          repositories: null,
        }),
      ]);
      mockFetchGitHubRepositories.mockRejectedValue(new Error('GitHub unavailable'));

      const { fetchAllGitHubRepositoriesForOrganization } =
        await import('./github-integration-helpers');
      const result = await fetchAllGitHubRepositoriesForOrganization('org-123');

      expect(result.integrationInstalled).toBe(true);
      expect(result.repositories).toEqual([
        expect.objectContaining({
          fullName: 'acme-core/api',
          platformIntegrationId: 'integration-1',
        }),
      ]);
    });

    it('fails when no installation can provide repositories', async () => {
      mockGetIntegrationsByOrganization.mockResolvedValue([
        buildIntegration({ repositories: null }),
        buildIntegration({
          id: 'integration-2',
          platform_installation_id: 'installation-2',
          repositories: null,
        }),
      ]);
      mockFetchGitHubRepositories.mockRejectedValue(new Error('GitHub unavailable'));

      const { fetchAllGitHubRepositoriesForOrganization } =
        await import('./github-integration-helpers');

      await expect(fetchAllGitHubRepositoriesForOrganization('org-123')).rejects.toThrow(
        'Failed to fetch GitHub repositories'
      );
    });

    it('returns integrationInstalled false when no integration exists', async () => {
      mockGetPrimaryGitHubIntegrationForOrganization.mockResolvedValue(null);
      mockGetIntegrationForOrganization.mockResolvedValue(null);

      const { fetchGitHubRepositoriesForOrganization } =
        await import('./github-integration-helpers');
      const result = await fetchGitHubRepositoriesForOrganization('org-123');

      expect(result.integrationInstalled).toBe(false);
      expect(result.repositories).toEqual([]);
    });

    it('returns no repositories when the integration is suspended', async () => {
      mockGetPrimaryGitHubIntegrationForOrganization.mockResolvedValue(null);
      mockGetIntegrationForOrganization.mockResolvedValue(
        buildIntegration({
          integration_status: 'suspended',
          suspended_at: '2026-06-25 18:00:00+00',
          suspended_by: 'someone',
        })
      );

      const { fetchGitHubRepositoriesForOrganization } =
        await import('./github-integration-helpers');
      const result = await fetchGitHubRepositoriesForOrganization('org-123');

      expect(result.integrationInstalled).toBe(false);
      expect(result.repositories).toEqual([]);
      expect(result.errorMessage).toBe('GitHub integration is suspended');
      expect(mockFetchGitHubRepositories).not.toHaveBeenCalled();
    });

    it('returns no repositories when the integration requires reauthorization', async () => {
      mockGetPrimaryGitHubIntegrationForOrganization.mockResolvedValue(null);
      mockGetIntegrationForOrganization.mockResolvedValue(
        buildIntegration({ auth_invalid_at: '2026-06-25 18:00:00+00' })
      );

      const { fetchGitHubRepositoriesForOrganization } =
        await import('./github-integration-helpers');
      const result = await fetchGitHubRepositoriesForOrganization('org-123');

      expect(result.integrationInstalled).toBe(false);
      expect(result.errorMessage).toBe('GitHub integration requires reauthorization');
      expect(mockFetchGitHubRepositories).not.toHaveBeenCalled();
    });

    it('does not refresh repositories for a suspended integration even with forceRefresh', async () => {
      mockGetPrimaryGitHubIntegrationForOrganization.mockResolvedValue(null);
      mockGetIntegrationForOrganization.mockResolvedValue(
        buildIntegration({ integration_status: 'suspended' })
      );

      const { fetchGitHubRepositoriesForOrganization } =
        await import('./github-integration-helpers');
      const result = await fetchGitHubRepositoriesForOrganization('org-123', true);

      expect(result.integrationInstalled).toBe(false);
      expect(mockFetchGitHubRepositories).not.toHaveBeenCalled();
      expect(mockUpdateRepositoriesForIntegration).not.toHaveBeenCalled();
    });
  });

  describe('discovery identity and branches', () => {
    const integrationId = '11111111-1111-4111-8111-111111111111';
    const userOwner = { type: 'user' as const, id: 'oauth/user' };
    const orgOwner = { type: 'org' as const, id: '22222222-2222-4222-8222-222222222222' };
    const repository = {
      id: 42,
      name: 'API',
      full_name: 'acme/API',
      private: true,
      default_branch: 'release/Case',
    };
    const expectedRepository = {
      provider: 'github' as const,
      repositoryId: '42',
      instanceUrl: 'https://github.com',
      fullName: 'acme/API',
      defaultBranch: 'release/Case',
    };

    it.each(
      ['personal', 'primary', 'all'].flatMap(context =>
        [false, true].map(fresh => ({ context, fresh }))
      )
    )(
      'preserves defaults and producing identity for $context, fresh=$fresh',
      async ({ context, fresh }) => {
        const integration = buildIntegration({ id: integrationId, repositories: [repository] });
        mockGetIntegrationForOwner.mockResolvedValue(integration);
        mockGetPrimaryGitHubIntegrationForOrganization.mockResolvedValue(integration);
        mockGetIntegrationsByOrganization.mockResolvedValue([integration]);
        mockFetchGitHubRepositories.mockResolvedValue([repository]);
        const helpers = await import('./github-integration-helpers');
        const result =
          context === 'personal'
            ? await helpers.fetchGitHubRepositoriesForUser(userOwner.id, fresh)
            : context === 'primary'
              ? await helpers.fetchGitHubRepositoriesForOrganization(orgOwner.id, fresh)
              : await helpers.fetchAllGitHubRepositoriesForOrganization(orgOwner.id, fresh);
        expect(result.repositories[0]).toMatchObject({
          id: 42,
          fullName: 'acme/API',
          defaultBranch: 'release/Case',
          platformIntegrationId: integrationId,
          repositoryReference: {
            repository: expectedRepository,
            authorization: {
              kind: 'ownerIntegration',
              owner: context === 'personal' ? userOwner : orgOwner,
              integrationId,
            },
          },
        });
      }
    );

    it('does not invent a default for an old Personal cache row', async () => {
      mockGetIntegrationForOwner.mockResolvedValue(buildIntegration({ id: integrationId }));
      const { fetchGitHubRepositoriesForUser } = await import('./github-integration-helpers');
      const result = await fetchGitHubRepositoriesForUser(userOwner.id);
      expect(result.repositories[0].repositoryReference.repository.defaultBranch).toBeNull();
    });

    it('keeps same-name repositories distinct across installations', async () => {
      mockGetIntegrationsByOrganization.mockResolvedValue([
        buildIntegration({ id: integrationId, repositories: [repository] }),
        buildIntegration({
          id: '33333333-3333-4333-8333-333333333333',
          repositories: [repository],
        }),
      ]);
      const { fetchAllGitHubRepositoriesForOrganization } =
        await import('./github-integration-helpers');
      const result = await fetchAllGitHubRepositoriesForOrganization(orgOwner.id);
      expect(
        result.repositories.map(row => row.repositoryReference.authorization.integrationId)
      ).toEqual([integrationId, '33333333-3333-4333-8333-333333333333']);
    });

    it('keeps the producing integration when replacement occurs during a fresh fetch', async () => {
      mockGetIntegrationForOwner.mockResolvedValue(buildIntegration({ id: integrationId }));
      mockFetchGitHubRepositories.mockImplementation(async () => {
        mockGetIntegrationForOwner.mockResolvedValue(buildIntegration({ id: 'replacement' }));
        return [repository];
      });
      const { fetchGitHubRepositoriesForUser } = await import('./github-integration-helpers');
      const result = await fetchGitHubRepositoriesForUser(userOwner.id, true);
      expect(result.repositories[0].repositoryReference.authorization).toEqual({
        kind: 'ownerIntegration',
        owner: userOwner,
        integrationId,
      });
    });

    it.each([userOwner, orgOwner])(
      'uses the provider default and preserves branch case for $type',
      async owner => {
        const lookups = jest.requireMock<{
          getGitHubIntegrationById: jest.Mock<
            (owner: Owner, id: string) => Promise<PlatformIntegration | null>
          >;
        }>('@/lib/integrations/db/platform-integrations');
        lookups.getGitHubIntegrationById.mockImplementation(async (actualOwner, id) =>
          actualOwner.id === owner.id && id === integrationId
            ? buildIntegration({ id: integrationId, repositories: [repository] })
            : null
        );
        const adapter = jest.requireMock<{
          fetchGitHubBranches: jest.Mock<() => Promise<{ name: string; isDefault: boolean }[]>>;
        }>('@/lib/integrations/platforms/github/adapter');
        adapter.fetchGitHubBranches.mockResolvedValue([
          { name: 'feature/Case', isDefault: false },
          { name: 'release/Case', isDefault: true },
        ]);
        const { listGitHubRepositoryBranches } = await import('./github-integration-helpers');
        await expect(
          listGitHubRepositoryBranches(owner, {
            repository: expectedRepository,
            authorization: { kind: 'ownerIntegration', owner, integrationId },
          })
        ).resolves.toEqual({
          branches: [
            { name: 'feature/Case', isDefault: false },
            { name: 'release/Case', isDefault: true },
          ],
          defaultBranch: 'release/Case',
          nextCursor: null,
        });
      }
    );

    it.each(['owner', 'integration', 'repository', 'instance'] as const)(
      'rejects a changed %s without selecting a same-name repository',
      async change => {
        const lookups = jest.requireMock<{
          getGitHubIntegrationById: jest.Mock<
            (owner: Owner, id: string) => Promise<PlatformIntegration | null>
          >;
        }>('@/lib/integrations/db/platform-integrations');
        lookups.getGitHubIntegrationById.mockImplementation(async (_owner, id) =>
          id === integrationId
            ? buildIntegration({ id: integrationId, repositories: [repository] })
            : null
        );
        const { listGitHubRepositoryBranches } = await import('./github-integration-helpers');
        await expect(
          listGitHubRepositoryBranches(userOwner, {
            repository: {
              ...expectedRepository,
              ...(change === 'repository' ? { repositoryId: '999' } : {}),
              ...(change === 'instance' ? { instanceUrl: 'https://other.test' } : {}),
            },
            authorization: {
              kind: 'ownerIntegration',
              owner: change === 'owner' ? orgOwner : userOwner,
              integrationId: change === 'integration' ? 'stale' : integrationId,
            },
          })
        ).rejects.toMatchObject({ code: change === 'owner' ? 'FORBIDDEN' : 'NOT_FOUND' });
      }
    );

    it('returns an empty branch list without guessing main', async () => {
      const lookups = jest.requireMock<{
        getGitHubIntegrationById: jest.Mock<() => Promise<PlatformIntegration | null>>;
      }>('@/lib/integrations/db/platform-integrations');
      lookups.getGitHubIntegrationById.mockResolvedValue(
        buildIntegration({ id: integrationId, repositories: [repository] })
      );
      const adapter = jest.requireMock<{ fetchGitHubBranches: jest.Mock<() => Promise<never[]>> }>(
        '@/lib/integrations/platforms/github/adapter'
      );
      adapter.fetchGitHubBranches.mockResolvedValue([]);
      const { listGitHubRepositoryBranches } = await import('./github-integration-helpers');
      await expect(
        listGitHubRepositoryBranches(userOwner, {
          repository: expectedRepository,
          authorization: { kind: 'ownerIntegration', owner: userOwner, integrationId },
        })
      ).resolves.toEqual({ branches: [], defaultBranch: null, nextCursor: null });
    });
  });
});
