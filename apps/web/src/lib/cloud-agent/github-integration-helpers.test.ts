import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import type { PlatformIntegration } from '@kilocode/db/schema';
import type { Owner } from '@/lib/integrations/core/types';

// Define mock functions at module level with proper typing
const mockGetIntegrationForOrganization =
  jest.fn<(organizationId: string, platform: string) => Promise<PlatformIntegration | null>>();
const mockGetIntegrationForOwner =
  jest.fn<(owner: Owner, platform: string) => Promise<PlatformIntegration | null>>();
const mockUpdateRepositoriesForIntegration =
  jest.fn<(integrationId: string, repositories: unknown[]) => Promise<void>>();
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
  getIntegrationForOrganization: mockGetIntegrationForOrganization,
  getIntegrationForOwner: mockGetIntegrationForOwner,
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
      mockGetIntegrationForOrganization.mockResolvedValue(buildIntegration());

      const { fetchGitHubRepositoriesForOrganization } =
        await import('./github-integration-helpers');
      const result = await fetchGitHubRepositoriesForOrganization('org-123');

      expect(result.integrationInstalled).toBe(true);
      expect(result.repositories).toEqual([
        { id: 1, name: 'repo', fullName: 'org/repo', private: false },
      ]);
      expect(mockFetchGitHubRepositories).not.toHaveBeenCalled();
    });

    it('returns integrationInstalled false when no integration exists', async () => {
      mockGetIntegrationForOrganization.mockResolvedValue(null);

      const { fetchGitHubRepositoriesForOrganization } =
        await import('./github-integration-helpers');
      const result = await fetchGitHubRepositoriesForOrganization('org-123');

      expect(result.integrationInstalled).toBe(false);
      expect(result.repositories).toEqual([]);
    });

    it('returns no repositories when the integration is suspended', async () => {
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
      expect(mockFetchGitHubRepositories).not.toHaveBeenCalled();
    });

    it('does not refresh repositories for a suspended integration even with forceRefresh', async () => {
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
