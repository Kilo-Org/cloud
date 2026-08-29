import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import type { PlatformIntegration } from '@kilocode/db/schema';
import type { Owner } from '@/lib/integrations/core/types';
import type { RepositoryReadOptions } from '@/lib/integrations/core/repository-read-limits';

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
  jest.fn<
    (installationId: string, appType: string, options?: RepositoryReadOptions) => Promise<unknown[]>
  >();
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
  getIntegrationForOrganization: mockGetIntegrationForOrganization,
  getIntegrationForOwner: mockGetIntegrationForOwner,
  getPrimaryGitHubIntegrationForOrganization: mockGetPrimaryGitHubIntegrationForOrganization,
  getIntegrationsByOrganization: mockGetIntegrationsByOrganization,
  updateRepositoriesForIntegration: mockUpdateRepositoriesForIntegration,
}));

jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
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
        { id: 1, name: 'repo', fullName: 'org/repo', private: false },
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
        { id: 2, name: 'fresh', fullName: 'org/fresh', private: true },
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
        {
          id: 1,
          name: 'repo',
          fullName: 'org/repo',
          private: false,
          platformIntegrationId: 'integration-1',
        },
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
});

describe('bounded GitHub repository reads', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchGitHubRepositories.mockReset();
    mockUpdateRepositoriesForIntegration.mockReset();
  });

  describe.each(['personal', 'organization'] as const)('%s', scope => {
    async function read(forceRefresh = false) {
      const helpers = await import('./github-integration-helpers');
      return scope === 'personal'
        ? helpers.fetchGitHubRepositoriesForUser('oauth/member', forceRefresh, { bounded: true })
        : helpers.fetchAllGitHubRepositoriesForOrganization('org-123', forceRefresh, {
            bounded: true,
          });
    }

    function configure(integration: PlatformIntegration | null) {
      mockGetIntegrationForOwner.mockResolvedValue(integration);
      mockGetIntegrationsByOrganization.mockResolvedValue(integration ? [integration] : []);
    }

    it.each([
      ['absent', null, 'not_connected'],
      ['empty', buildIntegration({ repositories: [] }), 'available'],
      ['suspended', buildIntegration({ suspended_at: '2026-06-25 18:00:00+00' }), 'suspended'],
      [
        'auth-invalid',
        buildIntegration({ auth_invalid_at: '2026-06-25 18:00:00+00' }),
        'reconnect_required',
      ],
      ['misconfigured', buildIntegration({ platform_installation_id: null }), 'misconfigured'],
    ] as const)('keeps %s distinct without fetching', async (_label, integration, status) => {
      configure(integration);
      await expect(read()).resolves.toMatchObject({
        status,
        integrationInstalled: integration !== null,
        repositories: [],
      });
      expect(mockFetchGitHubRepositories).not.toHaveBeenCalled();
    });

    it('bounds cached entries before validation and projection', async () => {
      const repositories = Array.from({ length: 60 }, (_, id) => ({
        id,
        name: `repo-${id}`,
        full_name: `org/repo-${id}`,
        private: false,
      }));
      Object.defineProperty(repositories[50], 'id', {
        get() {
          throw new Error('Past the bound');
        },
      });
      configure(buildIntegration({ repositories }));
      const result = await read();
      expect(result.status).toBe('available');
      expect(result.repositories).toHaveLength(50);
      expect(result.repositories.at(-1)?.fullName).toBe('org/repo-49');
    });

    it.each([false, true])(
      'does not replace the complete cache on bounded refresh=%s',
      async forceRefresh => {
        const repositories = Array.from({ length: 60 }, (_, id) => ({
          id,
          name: `repo-${id}`,
          full_name: `org/repo-${id}`,
          private: false,
        }));
        const integration = buildIntegration({
          repositories: forceRefresh ? repositories : null,
          repositories_synced_at: forceRefresh ? '2024-01-01T00:00:00Z' : null,
        });
        configure(integration);
        mockUpdateRepositoriesForIntegration.mockImplementation(async (_id, value) => {
          integration.repositories = value as PlatformIntegration['repositories'];
        });
        mockFetchGitHubRepositories.mockImplementation(async (_id, _app, options) => {
          if (!options?.bounded || !options.signal) throw new Error('Unbounded transport');
          return repositories.slice(0, 50);
        });
        const result = await read(forceRefresh);
        expect(result.status).toBe('available');
        expect(result.repositories).toHaveLength(50);
        mockFetchGitHubRepositories.mockResolvedValue(repositories);
        const helpers = await import('./github-integration-helpers');
        const legacy =
          scope === 'personal'
            ? await helpers.fetchGitHubRepositoriesForUser('oauth/member')
            : await helpers.fetchAllGitHubRepositoriesForOrganization('org-123');
        expect(legacy.repositories).toHaveLength(60);
        expect(legacy).not.toHaveProperty('status');
      }
    );

    it('reports provider failure without exposing its raw error', async () => {
      configure(buildIntegration({ repositories: null }));
      mockFetchGitHubRepositories.mockRejectedValue(new Error('secret provider response'));
      await expect(read()).resolves.toEqual({
        status: 'temporarily_unavailable',
        integrationInstalled: true,
        repositories: [],
        syncedAt: null,
      });
    });
  });

  it('rejects more than ten configured installations before network work', async () => {
    mockGetIntegrationsByOrganization.mockResolvedValue(
      Array.from({ length: 11 }, () => buildIntegration())
    );
    const { fetchAllGitHubRepositoriesForOrganization } =
      await import('./github-integration-helpers');
    await expect(
      fetchAllGitHubRepositoriesForOrganization('org-123', true, { bounded: true })
    ).resolves.toMatchObject({ status: 'integration_limit_exceeded', repositories: [] });
    expect(mockFetchGitHubRepositories).not.toHaveBeenCalled();
  });

  it('rejects an unavailable sibling instead of hiding it behind healthy repositories', async () => {
    mockGetIntegrationsByOrganization.mockResolvedValue([
      buildIntegration(),
      buildIntegration({ auth_invalid_at: '2026-06-25 18:00:00+00' }),
    ]);
    const { fetchAllGitHubRepositoriesForOrganization } =
      await import('./github-integration-helpers');
    await expect(
      fetchAllGitHubRepositoriesForOrganization('org-123', false, { bounded: true })
    ).resolves.toMatchObject({ status: 'reconnect_required', repositories: [] });
  });

  it('rejects a later provider failure even after collecting fifty repositories', async () => {
    mockGetIntegrationsByOrganization.mockResolvedValue([
      buildIntegration({ repositories: Array.from({ length: 50 }, () => cachedRepositories[0]) }),
      buildIntegration({ id: 'integration-2', repositories: null }),
    ]);
    mockFetchGitHubRepositories.mockRejectedValue(new Error('unavailable'));
    const { fetchAllGitHubRepositoriesForOrganization } =
      await import('./github-integration-helpers');
    await expect(
      fetchAllGitHubRepositoriesForOrganization('org-123', false, { bounded: true })
    ).resolves.toMatchObject({ status: 'temporarily_unavailable', repositories: [] });
  });

  it('fetches sequentially and caps the aggregate while preserving installation provenance', async () => {
    mockGetIntegrationsByOrganization.mockResolvedValue([
      buildIntegration({ repositories: null }),
      buildIntegration({
        id: 'integration-2',
        platform_installation_id: 'installation-2',
        repositories: null,
      }),
    ]);
    let active = 0;
    let peak = 0;
    mockFetchGitHubRepositories.mockImplementation(async installationId => {
      peak = Math.max(peak, ++active);
      await Promise.resolve();
      active--;
      return Array.from({ length: 40 }, (_, id) => ({
        id,
        name: 'repo',
        full_name: `${installationId}/repo-${id}`,
        private: false,
      }));
    });
    const { fetchAllGitHubRepositoriesForOrganization } =
      await import('./github-integration-helpers');
    const result = await fetchAllGitHubRepositoriesForOrganization('org-123', true, {
      bounded: true,
    });
    expect(result.status).toBe('available');
    expect(peak).toBe(1);
    expect(result.repositories).toHaveLength(50);
    expect(result.repositories.at(-1)).toMatchObject({
      fullName: 'installation-2/repo-9',
      platformIntegrationId: 'integration-2',
    });
  });

  it('uses one deadline and starts no later installation after timeout', async () => {
    jest.useFakeTimers();
    try {
      mockGetIntegrationsByOrganization.mockResolvedValue([buildIntegration(), buildIntegration()]);
      mockFetchGitHubRepositories.mockImplementation(() => new Promise(() => {}));
      const { fetchAllGitHubRepositoriesForOrganization } =
        await import('./github-integration-helpers');
      const result = fetchAllGitHubRepositoriesForOrganization('org-123', true, { bounded: true });
      await jest.advanceTimersByTimeAsync(30_000);
      await expect(result).resolves.toMatchObject({
        status: 'temporarily_unavailable',
        repositories: [],
      });
      expect(mockFetchGitHubRepositories).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
});
