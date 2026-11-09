import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import type { PlatformIntegration } from '@kilocode/db/schema';
import type * as GitLabAdapter from '@/lib/integrations/platforms/gitlab/adapter';
import type { Owner } from '@/lib/integrations/core/types';
import { INTEGRATION_STATUS } from '@/lib/integrations/core/constants';
import { buildGitLabCloneUrl } from './gitlab-integration-helpers';

/**
 * The suite resets the module registry per test, so the requester helper and
 * the adapter's real error class must be loaded from the same registry: the
 * actual module first, then the helper that the mocked adapter factory builds
 * from it.
 */
async function loadRequesterAccess() {
  const { GitLabProjectFetchError } = jest.requireActual<typeof GitLabAdapter>(
    '@/lib/integrations/platforms/gitlab/adapter'
  );
  const helpers = await import('./gitlab-integration-helpers');
  return { GitLabProjectFetchError, helpers };
}

// Define mock functions at module level with proper typing
const mockGetGitLabIntegration = jest.fn<(owner: Owner) => Promise<PlatformIntegration | null>>();
const mockGetValidGitLabToken =
  jest.fn<
    (
      integration: PlatformIntegration,
      actor: { userId: string; organizationId?: string }
    ) => Promise<string>
  >();
const mockGetIntegrationForOrganization =
  jest.fn<(organizationId: string, platform: string) => Promise<PlatformIntegration | null>>();
const mockGetIntegrationForOwner =
  jest.fn<(owner: Owner, platform: string) => Promise<PlatformIntegration | null>>();
const mockUpdateRepositoriesForIntegration =
  jest.fn<(integrationId: string, repositories: unknown[]) => Promise<void>>();
const mockFetchGitLabProjects =
  jest.fn<(accessToken: string, instanceUrl: string) => Promise<unknown[]>>();
const mockGetGitLabProject =
  jest.fn<(accessToken: string, projectPath: string, instanceUrl: string) => Promise<unknown>>();

// Wire up the mocks
jest.mock('@/lib/integrations/gitlab-service', () => ({
  getGitLabIntegration: mockGetGitLabIntegration,
  getValidGitLabToken: mockGetValidGitLabToken,
}));

jest.mock('@/lib/integrations/db/platform-integrations', () => ({
  getIntegrationForOrganization: mockGetIntegrationForOrganization,
  getIntegrationForOwner: mockGetIntegrationForOwner,
  updateRepositoriesForIntegration: mockUpdateRepositoriesForIntegration,
}));

jest.mock('@/lib/integrations/platforms/gitlab/adapter', () => ({
  ...jest.requireActual<typeof GitLabAdapter>('@/lib/integrations/platforms/gitlab/adapter'),
  fetchGitLabProjects: mockFetchGitLabProjects,
  getGitLabProject: mockGetGitLabProject,
}));

describe('gitlab-integration-helpers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
  });

  describe('buildGitLabCloneUrl', () => {
    it('should build URL for simple project path', () => {
      const result = buildGitLabCloneUrl('group/project');
      expect(result).toBe('https://gitlab.com/group/project.git');
    });

    it('should build URL for nested project path', () => {
      const result = buildGitLabCloneUrl('group/subgroup/project');
      expect(result).toBe('https://gitlab.com/group/subgroup/project.git');
    });

    it('should build URL for deeply nested project path', () => {
      const result = buildGitLabCloneUrl('org/team/subteam/project');
      expect(result).toBe('https://gitlab.com/org/team/subteam/project.git');
    });

    it('should use custom instance URL when provided', () => {
      const result = buildGitLabCloneUrl('group/project', 'https://gitlab.example.com');
      expect(result).toBe('https://gitlab.example.com/group/project.git');
    });

    it('should handle custom instance URL with trailing slash', () => {
      const result = buildGitLabCloneUrl('group/project', 'https://gitlab.example.com/');
      expect(result).toBe('https://gitlab.example.com/group/project.git');
    });

    it('should handle project path with leading slash', () => {
      const result = buildGitLabCloneUrl('/group/project');
      expect(result).toBe('https://gitlab.com/group/project.git');
    });

    it('should handle project path with trailing slash', () => {
      const result = buildGitLabCloneUrl('group/project/');
      expect(result).toBe('https://gitlab.com/group/project.git');
    });

    it('should handle project path with both leading and trailing slashes', () => {
      const result = buildGitLabCloneUrl('/group/project/');
      expect(result).toBe('https://gitlab.com/group/project.git');
    });

    it('should use default gitlab.com when instanceUrl is not provided', () => {
      const result = buildGitLabCloneUrl('mygroup/myproject');
      expect(result).toBe('https://gitlab.com/mygroup/myproject.git');
    });
  });

  describe('getGitLabInstanceUrlForUser', () => {
    it('should return default URL when no integration exists', async () => {
      mockGetGitLabIntegration.mockResolvedValue(null);

      const { getGitLabInstanceUrlForUser } = await import('./gitlab-integration-helpers');
      const result = await getGitLabInstanceUrlForUser('user-123');

      expect(result).toBe('https://gitlab.com');
      expect(mockGetGitLabIntegration).toHaveBeenCalledWith({ type: 'user', id: 'user-123' });
    });

    it('should return default URL when integration has no custom instance URL', async () => {
      mockGetGitLabIntegration.mockResolvedValue({
        id: 'integration-1',
        metadata: {},
      } as PlatformIntegration);

      const { getGitLabInstanceUrlForUser } = await import('./gitlab-integration-helpers');
      const result = await getGitLabInstanceUrlForUser('user-123');

      expect(result).toBe('https://gitlab.com');
    });

    it('should return custom instance URL from integration metadata', async () => {
      mockGetGitLabIntegration.mockResolvedValue({
        id: 'integration-1',
        metadata: {
          gitlab_instance_url: 'https://gitlab.mycompany.com',
        },
      } as PlatformIntegration);

      const { getGitLabInstanceUrlForUser } = await import('./gitlab-integration-helpers');
      const result = await getGitLabInstanceUrlForUser('user-123');

      expect(result).toBe('https://gitlab.mycompany.com');
    });

    it('should return default URL when metadata is null', async () => {
      mockGetGitLabIntegration.mockResolvedValue({
        id: 'integration-1',
        metadata: null,
      } as PlatformIntegration);

      const { getGitLabInstanceUrlForUser } = await import('./gitlab-integration-helpers');
      const result = await getGitLabInstanceUrlForUser('user-123');

      expect(result).toBe('https://gitlab.com');
    });
  });

  describe('getGitLabInstanceUrlForOrganization', () => {
    it('should return default URL when no integration exists', async () => {
      mockGetIntegrationForOrganization.mockResolvedValue(null);

      const { getGitLabInstanceUrlForOrganization } = await import('./gitlab-integration-helpers');
      const result = await getGitLabInstanceUrlForOrganization('org-123');

      expect(result).toBe('https://gitlab.com');
      expect(mockGetIntegrationForOrganization).toHaveBeenCalledWith('org-123', 'gitlab');
    });

    it('should return default URL when integration has no custom instance URL', async () => {
      mockGetIntegrationForOrganization.mockResolvedValue({
        id: 'integration-1',
        metadata: {},
      } as PlatformIntegration);

      const { getGitLabInstanceUrlForOrganization } = await import('./gitlab-integration-helpers');
      const result = await getGitLabInstanceUrlForOrganization('org-123');

      expect(result).toBe('https://gitlab.com');
    });

    it('should return custom instance URL from integration metadata', async () => {
      mockGetIntegrationForOrganization.mockResolvedValue({
        id: 'integration-1',
        metadata: {
          gitlab_instance_url: 'https://gitlab.enterprise.com',
        },
      } as PlatformIntegration);

      const { getGitLabInstanceUrlForOrganization } = await import('./gitlab-integration-helpers');
      const result = await getGitLabInstanceUrlForOrganization('org-123');

      expect(result).toBe('https://gitlab.enterprise.com');
    });

    it('should return default URL when metadata is null', async () => {
      mockGetIntegrationForOrganization.mockResolvedValue({
        id: 'integration-1',
        metadata: null,
      } as PlatformIntegration);

      const { getGitLabInstanceUrlForOrganization } = await import('./gitlab-integration-helpers');
      const result = await getGitLabInstanceUrlForOrganization('org-123');

      expect(result).toBe('https://gitlab.com');
    });
  });

  describe('getGitLabTokenForUser', () => {
    it('should return undefined when no integration exists', async () => {
      mockGetGitLabIntegration.mockResolvedValue(null);

      const { getGitLabTokenForUser } = await import('./gitlab-integration-helpers');
      const result = await getGitLabTokenForUser('user-123');

      expect(result).toBeUndefined();
      expect(mockGetGitLabIntegration).toHaveBeenCalledWith({ type: 'user', id: 'user-123' });
    });

    it('should return token when integration exists', async () => {
      const mockIntegration = {
        id: 'integration-1',
        metadata: { access_token: 'test-token' },
      } as PlatformIntegration;
      mockGetGitLabIntegration.mockResolvedValue(mockIntegration);
      mockGetValidGitLabToken.mockResolvedValue('valid-token-123');

      const { getGitLabTokenForUser } = await import('./gitlab-integration-helpers');
      const result = await getGitLabTokenForUser('user-123');

      expect(result).toBe('valid-token-123');
      expect(mockGetValidGitLabToken).toHaveBeenCalledWith(mockIntegration, {
        userId: 'user-123',
      });
    });

    it('should throw TRPCError when token retrieval fails', async () => {
      const mockIntegration = {
        id: 'integration-1',
        metadata: { access_token: 'test-token' },
      } as PlatformIntegration;
      mockGetGitLabIntegration.mockResolvedValue(mockIntegration);
      mockGetValidGitLabToken.mockRejectedValue(new Error('Token refresh failed'));

      const { getGitLabTokenForUser } = await import('./gitlab-integration-helpers');

      await expect(getGitLabTokenForUser('user-123')).rejects.toThrow(
        'Failed to authenticate with GitLab integration'
      );
    });
  });

  describe('getGitLabTokenForOrganization', () => {
    it('should return undefined when no integration exists', async () => {
      mockGetIntegrationForOrganization.mockResolvedValue(null);

      const { getGitLabTokenForOrganization } = await import('./gitlab-integration-helpers');
      const result = await getGitLabTokenForOrganization('org-123', 'actor-123');

      expect(result).toBeUndefined();
      expect(mockGetIntegrationForOrganization).toHaveBeenCalledWith('org-123', 'gitlab');
    });

    it('should return token when integration exists', async () => {
      const mockIntegration = {
        id: 'integration-1',
        metadata: { access_token: 'test-token' },
      } as PlatformIntegration;
      mockGetIntegrationForOrganization.mockResolvedValue(mockIntegration);
      mockGetValidGitLabToken.mockResolvedValue('org-valid-token-456');

      const { getGitLabTokenForOrganization } = await import('./gitlab-integration-helpers');
      const result = await getGitLabTokenForOrganization('org-123', 'actor-123');

      expect(result).toBe('org-valid-token-456');
      expect(mockGetValidGitLabToken).toHaveBeenCalledWith(mockIntegration, {
        userId: 'actor-123',
        organizationId: 'org-123',
      });
    });

    it('should throw TRPCError when token retrieval fails', async () => {
      const mockIntegration = {
        id: 'integration-1',
        metadata: { access_token: 'test-token' },
      } as PlatformIntegration;
      mockGetIntegrationForOrganization.mockResolvedValue(mockIntegration);
      mockGetValidGitLabToken.mockRejectedValue(new Error('Token refresh failed'));

      const { getGitLabTokenForOrganization } = await import('./gitlab-integration-helpers');

      await expect(getGitLabTokenForOrganization('org-123', 'actor-123')).rejects.toThrow(
        'Failed to authenticate with GitLab integration'
      );
    });
  });

  describe('getGitLabProjectAccessForRequester', () => {
    const buildIntegration = (): PlatformIntegration =>
      ({
        id: 'integration-1',
        metadata: {},
      }) as PlatformIntegration;

    it('allows a project the requester credential holds Developer access to', async () => {
      mockGetGitLabIntegration.mockResolvedValue(buildIntegration());
      mockGetValidGitLabToken.mockResolvedValue('requester-token');
      mockGetGitLabProject.mockResolvedValue({
        id: 7,
        permissions: { project_access: { access_level: 30 }, group_access: null },
      });

      const { getGitLabProjectAccessForRequester } = await import('./gitlab-integration-helpers');
      await expect(getGitLabProjectAccessForRequester('user-1', 'group/repo')).resolves.toEqual({
        outcome: 'allowed',
      });
      expect(mockGetGitLabProject).toHaveBeenCalledWith(
        'requester-token',
        'group/repo',
        'https://gitlab.com'
      );
    });

    it('allows a project the requester reaches through a group at Maintainer level', async () => {
      mockGetGitLabIntegration.mockResolvedValue(buildIntegration());
      mockGetValidGitLabToken.mockResolvedValue('requester-token');
      mockGetGitLabProject.mockResolvedValue({
        id: 7,
        permissions: { project_access: null, group_access: { access_level: 40 } },
      });

      const { getGitLabProjectAccessForRequester } = await import('./gitlab-integration-helpers');
      await expect(getGitLabProjectAccessForRequester('user-1', 'group/repo')).resolves.toEqual({
        outcome: 'allowed',
      });
    });

    it('refuses a requester whose reported level cannot push', async () => {
      mockGetGitLabIntegration.mockResolvedValue(buildIntegration());
      mockGetValidGitLabToken.mockResolvedValue('requester-token');
      mockGetGitLabProject.mockResolvedValue({
        id: 7,
        permissions: { project_access: { access_level: 20 }, group_access: null },
      });

      const { getGitLabProjectAccessForRequester } = await import('./gitlab-integration-helpers');
      await expect(getGitLabProjectAccessForRequester('user-1', 'group/repo')).resolves.toEqual({
        outcome: 'refused',
      });
      expect(mockGetGitLabProject).toHaveBeenCalledTimes(1);
    });

    it('refuses a project the instance reports no access level for', async () => {
      mockGetGitLabIntegration.mockResolvedValue(buildIntegration());
      mockGetValidGitLabToken.mockResolvedValue('requester-token');
      mockGetGitLabProject.mockResolvedValue({ id: 7 });

      const { getGitLabProjectAccessForRequester } = await import('./gitlab-integration-helpers');
      await expect(getGitLabProjectAccessForRequester('user-1', 'group/repo')).resolves.toEqual({
        outcome: 'refused',
      });
    });

    it('refuses a project whose reported permissions cannot be read', async () => {
      mockGetGitLabIntegration.mockResolvedValue(buildIntegration());
      mockGetValidGitLabToken.mockResolvedValue('requester-token');
      mockGetGitLabProject.mockResolvedValue({
        id: 7,
        permissions: { project_access: { access_level: '30' } },
      });

      const { getGitLabProjectAccessForRequester } = await import('./gitlab-integration-helpers');
      await expect(getGitLabProjectAccessForRequester('user-1', 'group/repo')).resolves.toEqual({
        outcome: 'refused',
      });
    });

    it('refuses a 404 from the requester instance without retrying', async () => {
      const { GitLabProjectFetchError, helpers } = await loadRequesterAccess();
      mockGetGitLabIntegration.mockResolvedValue(buildIntegration());
      mockGetValidGitLabToken.mockResolvedValue('requester-token');
      mockGetGitLabProject.mockRejectedValue(new GitLabProjectFetchError(404));

      await expect(
        helpers.getGitLabProjectAccessForRequester('user-1', 'group/repo')
      ).resolves.toEqual({
        outcome: 'refused',
      });
      expect(mockGetGitLabProject).toHaveBeenCalledTimes(1);
    });

    it('refuses a requester with no GitLab connection of their own', async () => {
      mockGetGitLabIntegration.mockResolvedValue(null);

      const { getGitLabProjectAccessForRequester } = await import('./gitlab-integration-helpers');
      await expect(getGitLabProjectAccessForRequester('user-1', 'group/repo')).resolves.toEqual({
        outcome: 'refused',
      });
      expect(mockGetValidGitLabToken).not.toHaveBeenCalled();
      expect(mockGetGitLabProject).not.toHaveBeenCalled();
    });

    it('refuses a suspended requester connection before any credential or project read', async () => {
      mockGetGitLabIntegration.mockResolvedValue({
        id: 'integration-1',
        metadata: {},
        integration_status: INTEGRATION_STATUS.SUSPENDED,
        suspended_at: '2024-01-01T00:00:00.000Z',
      } as PlatformIntegration);

      const { getGitLabProjectAccessForRequester } = await import('./gitlab-integration-helpers');
      await expect(getGitLabProjectAccessForRequester('user-1', 'group/repo')).resolves.toEqual({
        outcome: 'refused',
      });
      expect(mockGetValidGitLabToken).not.toHaveBeenCalled();
      expect(mockGetGitLabProject).not.toHaveBeenCalled();
    });

    it('propagates a transient lookup failure for the retry response', async () => {
      const { GitLabProjectFetchError, helpers } = await loadRequesterAccess();
      mockGetGitLabIntegration.mockResolvedValue(buildIntegration());
      mockGetValidGitLabToken.mockResolvedValue('requester-token');
      mockGetGitLabProject.mockRejectedValue(new GitLabProjectFetchError(503));

      await expect(
        helpers.getGitLabProjectAccessForRequester('user-1', 'group/repo')
      ).rejects.toThrow('GitLab project lookup failed');
    });

    it('keeps the provider failure as the cause of the lookup error', async () => {
      const { GitLabProjectFetchError, helpers } = await loadRequesterAccess();
      const failure = new GitLabProjectFetchError(503);
      mockGetGitLabIntegration.mockResolvedValue(buildIntegration());
      mockGetValidGitLabToken.mockResolvedValue('requester-token');
      mockGetGitLabProject.mockRejectedValue(failure);

      await expect(
        helpers.getGitLabProjectAccessForRequester('user-1', 'group/repo')
      ).rejects.toMatchObject({
        status: 503,
        cause: failure,
      });
    });

    it('does not treat a failure without a provider status as a refusal', async () => {
      mockGetGitLabIntegration.mockResolvedValue(buildIntegration());
      mockGetValidGitLabToken.mockResolvedValue('requester-token');
      mockGetGitLabProject.mockRejectedValue(new Error('GitLab project fetch failed: 404'));

      const { getGitLabProjectAccessForRequester } = await import('./gitlab-integration-helpers');
      await expect(
        getGitLabProjectAccessForRequester('user-1', 'group/repo')
      ).rejects.toMatchObject({ status: 0 });
    });
  });

  describe('validateGitLabRepoAccessForUser', () => {
    it('should return true when project is in repository list', async () => {
      mockGetIntegrationForOwner.mockResolvedValue({
        id: 'integration-1',
        metadata: {},
        repositories: [
          { id: 1, name: 'project', full_name: 'group/project', private: false },
          { id: 2, name: 'other', full_name: 'group/other', private: true },
        ],
        repositories_synced_at: '2024-01-01T00:00:00Z',
      } as PlatformIntegration);

      const { validateGitLabRepoAccessForUser } = await import('./gitlab-integration-helpers');
      const result = await validateGitLabRepoAccessForUser('user-123', 'group/project');

      expect(result).toBe(true);
    });

    it('should return false when project is not in repository list', async () => {
      mockGetIntegrationForOwner.mockResolvedValue({
        id: 'integration-1',
        metadata: {},
        repositories: [{ id: 1, name: 'project', full_name: 'group/project', private: false }],
        repositories_synced_at: '2024-01-01T00:00:00Z',
      } as PlatformIntegration);

      const { validateGitLabRepoAccessForUser } = await import('./gitlab-integration-helpers');
      const result = await validateGitLabRepoAccessForUser('user-123', 'group/nonexistent');

      expect(result).toBe(false);
    });

    it('should perform case-insensitive matching', async () => {
      mockGetIntegrationForOwner.mockResolvedValue({
        id: 'integration-1',
        metadata: {},
        repositories: [{ id: 1, name: 'Project', full_name: 'Group/Project', private: false }],
        repositories_synced_at: '2024-01-01T00:00:00Z',
      } as PlatformIntegration);

      const { validateGitLabRepoAccessForUser } = await import('./gitlab-integration-helpers');
      const result = await validateGitLabRepoAccessForUser('user-123', 'group/project');

      expect(result).toBe(true);
    });

    it('should return false when no integration exists', async () => {
      mockGetIntegrationForOwner.mockResolvedValue(null);

      const { validateGitLabRepoAccessForUser } = await import('./gitlab-integration-helpers');
      const result = await validateGitLabRepoAccessForUser('user-123', 'group/project');

      expect(result).toBe(false);
    });

    it('should return false when project not found in non-empty repository list', async () => {
      mockGetIntegrationForOwner.mockResolvedValue({
        id: 'integration-1',
        metadata: {},
        repositories: [{ id: 1, name: 'other', full_name: 'other/repo', private: false }],
        repositories_synced_at: '2024-01-01T00:00:00Z',
      } as PlatformIntegration);

      const { validateGitLabRepoAccessForUser } = await import('./gitlab-integration-helpers');
      // Search for a project that doesn't exist in the list
      const result = await validateGitLabRepoAccessForUser('user-123', 'group/project');

      expect(result).toBe(false);
    });
  });

  describe('validateGitLabRepoAccessForOrganization', () => {
    it('should return true when project is in repository list', async () => {
      mockGetIntegrationForOrganization.mockResolvedValue({
        id: 'integration-1',
        metadata: {},
        repositories: [
          { id: 1, name: 'project', full_name: 'org/project', private: false },
          { id: 2, name: 'other', full_name: 'org/other', private: true },
        ],
        repositories_synced_at: '2024-01-01T00:00:00Z',
      } as PlatformIntegration);

      const { validateGitLabRepoAccessForOrganization } =
        await import('./gitlab-integration-helpers');
      const result = await validateGitLabRepoAccessForOrganization(
        'org-123',
        'actor-123',
        'org/project'
      );

      expect(result).toBe(true);
    });

    it('should return false when project is not in repository list', async () => {
      mockGetIntegrationForOrganization.mockResolvedValue({
        id: 'integration-1',
        metadata: {},
        repositories: [{ id: 1, name: 'project', full_name: 'org/project', private: false }],
        repositories_synced_at: '2024-01-01T00:00:00Z',
      } as PlatformIntegration);

      const { validateGitLabRepoAccessForOrganization } =
        await import('./gitlab-integration-helpers');
      const result = await validateGitLabRepoAccessForOrganization(
        'org-123',
        'actor-123',
        'org/nonexistent'
      );

      expect(result).toBe(false);
    });

    it('should perform case-insensitive matching', async () => {
      mockGetIntegrationForOrganization.mockResolvedValue({
        id: 'integration-1',
        metadata: {},
        repositories: [{ id: 1, name: 'Project', full_name: 'ORG/PROJECT', private: false }],
        repositories_synced_at: '2024-01-01T00:00:00Z',
      } as PlatformIntegration);

      const { validateGitLabRepoAccessForOrganization } =
        await import('./gitlab-integration-helpers');
      const result = await validateGitLabRepoAccessForOrganization(
        'org-123',
        'actor-123',
        'org/project'
      );

      expect(result).toBe(true);
    });

    it('should return false when no integration exists', async () => {
      mockGetIntegrationForOrganization.mockResolvedValue(null);

      const { validateGitLabRepoAccessForOrganization } =
        await import('./gitlab-integration-helpers');
      const result = await validateGitLabRepoAccessForOrganization(
        'org-123',
        'actor-123',
        'org/project'
      );

      expect(result).toBe(false);
    });

    it('should return false when project not found in non-empty repository list', async () => {
      mockGetIntegrationForOrganization.mockResolvedValue({
        id: 'integration-1',
        metadata: {},
        repositories: [{ id: 1, name: 'other', full_name: 'other/repo', private: false }],
        repositories_synced_at: '2024-01-01T00:00:00Z',
      } as PlatformIntegration);

      const { validateGitLabRepoAccessForOrganization } =
        await import('./gitlab-integration-helpers');
      const result = await validateGitLabRepoAccessForOrganization(
        'org-123',
        'actor-123',
        'org/project'
      );

      expect(result).toBe(false);
    });

    it('should handle nested project paths', async () => {
      mockGetIntegrationForOrganization.mockResolvedValue({
        id: 'integration-1',
        metadata: {},
        repositories: [
          { id: 1, name: 'project', full_name: 'org/subgroup/project', private: false },
        ],
        repositories_synced_at: '2024-01-01T00:00:00Z',
      } as PlatformIntegration);

      const { validateGitLabRepoAccessForOrganization } =
        await import('./gitlab-integration-helpers');
      const result = await validateGitLabRepoAccessForOrganization(
        'org-123',
        'actor-123',
        'org/subgroup/project'
      );

      expect(result).toBe(true);
    });
  });

  describe('fetchGitLabRepositoriesForUser', () => {
    const buildIntegration = (overrides: Partial<PlatformIntegration> = {}): PlatformIntegration =>
      ({
        id: 'integration-1',
        platform: 'gitlab',
        integration_status: 'active',
        suspended_at: null,
        auth_invalid_at: null,
        metadata: {},
        repositories: [{ id: 1, name: 'project', full_name: 'group/project', private: false }],
        repositories_synced_at: '2024-01-01T00:00:00Z',
        ...overrides,
      }) as PlatformIntegration;

    it('should return cached repositories for an active integration', async () => {
      mockGetIntegrationForOwner.mockResolvedValue(buildIntegration());

      const { fetchGitLabRepositoriesForUser } = await import('./gitlab-integration-helpers');
      const result = await fetchGitLabRepositoriesForUser('user-123');

      expect(result.integrationInstalled).toBe(true);
      expect(result.repositories).toEqual([
        { id: 1, name: 'project', fullName: 'group/project', private: false },
      ]);
      expect(mockFetchGitLabProjects).not.toHaveBeenCalled();
    });

    it('should return a synced empty list as the connected-empty snapshot', async () => {
      mockGetIntegrationForOwner.mockResolvedValue(buildIntegration({ repositories: [] }));

      const { fetchGitLabRepositoriesForUser } = await import('./gitlab-integration-helpers');
      const result = await fetchGitLabRepositoriesForUser('user-123');

      expect(result.integrationInstalled).toBe(true);
      expect(result.repositories).toEqual([]);
      expect(mockFetchGitLabProjects).not.toHaveBeenCalled();
      expect(mockUpdateRepositoriesForIntegration).not.toHaveBeenCalled();
    });

    it('should sync an integration whose repository list was never synced', async () => {
      mockGetIntegrationForOwner.mockResolvedValue(
        buildIntegration({ repositories: [], repositories_synced_at: null })
      );
      mockGetValidGitLabToken.mockResolvedValue('valid-token');
      mockFetchGitLabProjects.mockResolvedValue([]);

      const { fetchGitLabRepositoriesForUser } = await import('./gitlab-integration-helpers');
      const result = await fetchGitLabRepositoriesForUser('user-123');

      expect(mockFetchGitLabProjects).toHaveBeenCalledTimes(1);
      expect(result.repositories).toEqual([]);
    });

    it('should re-sync a synced empty list when forceRefresh is set', async () => {
      mockGetIntegrationForOwner.mockResolvedValue(buildIntegration({ repositories: [] }));
      mockGetValidGitLabToken.mockResolvedValue('valid-token');
      mockFetchGitLabProjects.mockResolvedValue([
        { id: 2, name: 'new', full_name: 'group/new', private: false },
      ]);

      const { fetchGitLabRepositoriesForUser } = await import('./gitlab-integration-helpers');
      const result = await fetchGitLabRepositoriesForUser('user-123', true);

      expect(mockFetchGitLabProjects).toHaveBeenCalledTimes(1);
      expect(result.repositories).toEqual([
        { id: 2, name: 'new', fullName: 'group/new', private: false },
      ]);
    });

    it('should return no repositories when the integration is suspended', async () => {
      mockGetIntegrationForOwner.mockResolvedValue(
        buildIntegration({
          integration_status: 'suspended',
          suspended_at: '2026-06-25 18:00:00+00',
        })
      );

      const { fetchGitLabRepositoriesForUser } = await import('./gitlab-integration-helpers');
      const result = await fetchGitLabRepositoriesForUser('user-123');

      expect(result.integrationInstalled).toBe(false);
      expect(result.repositories).toEqual([]);
      expect(mockFetchGitLabProjects).not.toHaveBeenCalled();
    });

    it('should not refresh repositories for a suspended integration even with forceRefresh', async () => {
      mockGetIntegrationForOwner.mockResolvedValue(
        buildIntegration({ integration_status: 'suspended' })
      );

      const { fetchGitLabRepositoriesForUser } = await import('./gitlab-integration-helpers');
      const result = await fetchGitLabRepositoriesForUser('user-123', true);

      expect(result.integrationInstalled).toBe(false);
      expect(mockFetchGitLabProjects).not.toHaveBeenCalled();
      expect(mockUpdateRepositoriesForIntegration).not.toHaveBeenCalled();
    });
  });

  describe('fetchGitLabRepositoriesForOrganization', () => {
    const buildIntegration = (overrides: Partial<PlatformIntegration> = {}): PlatformIntegration =>
      ({
        id: 'integration-1',
        platform: 'gitlab',
        integration_status: 'active',
        suspended_at: null,
        auth_invalid_at: null,
        metadata: {},
        repositories: [{ id: 1, name: 'project', full_name: 'org/project', private: false }],
        repositories_synced_at: '2024-01-01T00:00:00Z',
        ...overrides,
      }) as PlatformIntegration;

    it('should return cached repositories for an active integration', async () => {
      mockGetIntegrationForOrganization.mockResolvedValue(buildIntegration());

      const { fetchGitLabRepositoriesForOrganization } =
        await import('./gitlab-integration-helpers');
      const result = await fetchGitLabRepositoriesForOrganization('org-123', 'actor-123');

      expect(result.integrationInstalled).toBe(true);
      expect(result.repositories).toEqual([
        { id: 1, name: 'project', fullName: 'org/project', private: false },
      ]);
      expect(mockFetchGitLabProjects).not.toHaveBeenCalled();
    });

    it('should return a synced empty list as the connected-empty snapshot', async () => {
      mockGetIntegrationForOrganization.mockResolvedValue(buildIntegration({ repositories: [] }));

      const { fetchGitLabRepositoriesForOrganization } =
        await import('./gitlab-integration-helpers');
      const result = await fetchGitLabRepositoriesForOrganization('org-123', 'actor-123');

      expect(result.integrationInstalled).toBe(true);
      expect(result.repositories).toEqual([]);
      expect(mockFetchGitLabProjects).not.toHaveBeenCalled();
      expect(mockUpdateRepositoriesForIntegration).not.toHaveBeenCalled();
    });

    it('should sync an integration whose repository list was never synced', async () => {
      mockGetIntegrationForOrganization.mockResolvedValue(
        buildIntegration({ repositories: [], repositories_synced_at: null })
      );
      mockGetValidGitLabToken.mockResolvedValue('valid-token');
      mockFetchGitLabProjects.mockResolvedValue([]);

      const { fetchGitLabRepositoriesForOrganization } =
        await import('./gitlab-integration-helpers');
      const result = await fetchGitLabRepositoriesForOrganization('org-123', 'actor-123');

      expect(mockFetchGitLabProjects).toHaveBeenCalledTimes(1);
      expect(result.repositories).toEqual([]);
    });

    it('should re-sync a synced empty list when forceRefresh is set', async () => {
      mockGetIntegrationForOrganization.mockResolvedValue(buildIntegration({ repositories: [] }));
      mockGetValidGitLabToken.mockResolvedValue('valid-token');
      mockFetchGitLabProjects.mockResolvedValue([
        { id: 2, name: 'new', full_name: 'org/new', private: false },
      ]);

      const { fetchGitLabRepositoriesForOrganization } =
        await import('./gitlab-integration-helpers');
      const result = await fetchGitLabRepositoriesForOrganization('org-123', 'actor-123', true);

      expect(mockFetchGitLabProjects).toHaveBeenCalledTimes(1);
      expect(result.repositories).toEqual([
        { id: 2, name: 'new', fullName: 'org/new', private: false },
      ]);
    });

    it('should return no repositories when the integration is suspended', async () => {
      mockGetIntegrationForOrganization.mockResolvedValue(
        buildIntegration({
          integration_status: 'suspended',
          suspended_at: '2026-06-25 18:00:00+00',
        })
      );

      const { fetchGitLabRepositoriesForOrganization } =
        await import('./gitlab-integration-helpers');
      const result = await fetchGitLabRepositoriesForOrganization('org-123', 'actor-123');

      expect(result.integrationInstalled).toBe(false);
      expect(result.repositories).toEqual([]);
      expect(mockFetchGitLabProjects).not.toHaveBeenCalled();
    });

    it('should not refresh repositories for a suspended integration even with forceRefresh', async () => {
      mockGetIntegrationForOrganization.mockResolvedValue(
        buildIntegration({ integration_status: 'suspended' })
      );

      const { fetchGitLabRepositoriesForOrganization } =
        await import('./gitlab-integration-helpers');
      const result = await fetchGitLabRepositoriesForOrganization('org-123', 'actor-123', true);

      expect(result.integrationInstalled).toBe(false);
      expect(mockFetchGitLabProjects).not.toHaveBeenCalled();
      expect(mockUpdateRepositoriesForIntegration).not.toHaveBeenCalled();
    });
  });
});
