import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import type { PlatformIntegration } from '@kilocode/db/schema';
import type { Owner } from '@/lib/integrations/core/types';
import { buildGitLabCloneUrl } from './gitlab-integration-helpers';

// Define mock functions at module level with proper typing
const mockGetGitLabIntegration = jest.fn<(owner: Owner) => Promise<PlatformIntegration | null>>();
const mockGetValidGitLabToken = jest.fn<(integration: PlatformIntegration) => Promise<string>>();
const mockGetIntegrationForOrganization =
  jest.fn<(organizationId: string, platform: string) => Promise<PlatformIntegration | null>>();
const mockGetIntegrationForOwner =
  jest.fn<(owner: Owner, platform: string) => Promise<PlatformIntegration | null>>();
const mockUpdateRepositoriesForIntegration =
  jest.fn<(integrationId: string, repositories: unknown[]) => Promise<void>>();
const mockFetchGitLabProjects =
  jest.fn<(accessToken: string, instanceUrl: string) => Promise<unknown[]>>();

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
  fetchGitLabProjects: mockFetchGitLabProjects,
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
      expect(mockGetValidGitLabToken).toHaveBeenCalledWith(mockIntegration);
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
      const result = await getGitLabTokenForOrganization('org-123');

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
      const result = await getGitLabTokenForOrganization('org-123');

      expect(result).toBe('org-valid-token-456');
      expect(mockGetValidGitLabToken).toHaveBeenCalledWith(mockIntegration);
    });

    it('should throw TRPCError when token retrieval fails', async () => {
      const mockIntegration = {
        id: 'integration-1',
        metadata: { access_token: 'test-token' },
      } as PlatformIntegration;
      mockGetIntegrationForOrganization.mockResolvedValue(mockIntegration);
      mockGetValidGitLabToken.mockRejectedValue(new Error('Token refresh failed'));

      const { getGitLabTokenForOrganization } = await import('./gitlab-integration-helpers');

      await expect(getGitLabTokenForOrganization('org-123')).rejects.toThrow(
        'Failed to authenticate with GitLab integration'
      );
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
      const result = await validateGitLabRepoAccessForOrganization('org-123', 'org/project');

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
      const result = await validateGitLabRepoAccessForOrganization('org-123', 'org/nonexistent');

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
      const result = await validateGitLabRepoAccessForOrganization('org-123', 'org/project');

      expect(result).toBe(true);
    });

    it('should return false when no integration exists', async () => {
      mockGetIntegrationForOrganization.mockResolvedValue(null);

      const { validateGitLabRepoAccessForOrganization } =
        await import('./gitlab-integration-helpers');
      const result = await validateGitLabRepoAccessForOrganization('org-123', 'org/project');

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
      const result = await validateGitLabRepoAccessForOrganization('org-123', 'org/project');

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
        'org/subgroup/project'
      );

      expect(result).toBe(true);
    });
  });
});
