import { describe, expect, it, jest, beforeEach, beforeAll } from '@jest/globals';
import type { PlatformIntegration } from '@kilocode/db/schema';
import type { Owner } from '@/lib/integrations/core/types';
import type * as GitLabHelpers from './gitlab-integration-helpers';
import type * as GitLabService from '@/lib/integrations/gitlab-service';
import type { updateRepositoriesForIntegration } from '@/lib/integrations/db/platform-integrations';
import type { fetchGitLabBranches } from '@/lib/integrations/platforms/gitlab/adapter';
import type { fetchGitLabCredential } from '@/lib/integrations/platforms/gitlab/credential-broker-client';

let buildGitLabCloneUrl: typeof GitLabHelpers.buildGitLabCloneUrl;
beforeAll(async () => {
  ({ buildGitLabCloneUrl } = await import('./gitlab-integration-helpers'));
});

// Define mock functions at module level with proper typing
const mockGetGitLabIntegration =
  jest.fn<(owner: Owner, integrationId?: string) => Promise<PlatformIntegration | null>>();
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
const mockUpdateRepositoriesForIntegration = jest.fn<typeof updateRepositoriesForIntegration>();
const mockFetchGitLabProjects =
  jest.fn<(accessToken: string, instanceUrl: string) => Promise<unknown[]>>();
const mockListGitLabBranches = jest.fn<typeof GitLabService.listGitLabBranches>();
const mockFetchGitLabBranches = jest.fn<typeof fetchGitLabBranches>();
const mockIntegrationRows = jest.fn<() => Promise<PlatformIntegration[]>>();
const mockFetchGitLabCredential = jest.fn<typeof fetchGitLabCredential>();

jest.mock('@/lib/drizzle', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: mockIntegrationRows }) }) }),
  },
}));
jest.mock('@/lib/agent-config/db/agent-configs', () => ({}));
jest.mock('@/lib/integrations/platforms/gitlab/credential-encryption', () => ({}));
jest.mock('@/lib/integrations/platforms/gitlab/credential-broker-client', () => ({
  fetchGitLabCredential: mockFetchGitLabCredential,
}));

// Wire up the mocks
jest.mock('@/lib/integrations/gitlab-service', () => ({
  getGitLabIntegration: mockGetGitLabIntegration,
  getValidGitLabToken: mockGetValidGitLabToken,
  listGitLabBranches: mockListGitLabBranches,
}));

jest.mock('@/lib/integrations/db/platform-integrations', () => ({
  getIntegrationForOrganization: mockGetIntegrationForOrganization,
  getIntegrationForOwner: mockGetIntegrationForOwner,
  updateRepositoriesForIntegration: mockUpdateRepositoriesForIntegration,
}));

jest.mock('@/lib/integrations/platforms/gitlab/adapter', () => ({
  fetchGitLabProjects: mockFetchGitLabProjects,
  fetchGitLabBranches: mockFetchGitLabBranches,
}));
jest.mock('@/lib/utils.server', () => ({ logExceptInTest: jest.fn() }));

describe('gitlab-integration-helpers', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    jest.resetModules();
    mockGetGitLabIntegration.mockImplementation(owner =>
      owner.type === 'org'
        ? mockGetIntegrationForOrganization(owner.id, 'gitlab')
        : mockGetIntegrationForOwner(owner, 'gitlab')
    );
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
      expect(mockGetGitLabIntegration).toHaveBeenCalledWith(
        { type: 'user', id: 'user-123' },
        undefined
      );
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
        expect.objectContaining({
          id: 1,
          name: 'project',
          fullName: 'group/project',
          private: false,
        }),
      ]);
      expect(mockFetchGitLabProjects).not.toHaveBeenCalled();
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
        expect.objectContaining({
          id: 1,
          name: 'project',
          fullName: 'org/project',
          private: false,
        }),
      ]);
      expect(mockFetchGitLabProjects).not.toHaveBeenCalled();
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

  describe('branch identity through the GitLab service', () => {
    const owner: Owner = { type: 'user', id: 'oauth/user' };
    const instanceUrl = 'https://gitlab.example.com/Enterprise';
    const projectPath = 'Group/Subgroup/API';
    const integration = {
      id: 'integration-1',
      platform: 'gitlab',
      integration_status: 'active',
      suspended_at: null,
      auth_invalid_at: null,
      metadata: { gitlab_instance_url: instanceUrl },
      repositories: [{ id: 42, name: 'API', full_name: projectPath, private: true }],
    } as PlatformIntegration;
    const reference = {
      repository: {
        provider: 'gitlab' as const,
        instanceUrl,
        repositoryId: '42',
        fullName: projectPath,
        defaultBranch: null,
      },
      authorization: { kind: 'ownerIntegration' as const, owner, integrationId: integration.id },
    };

    beforeEach(() => {
      const service = jest.requireActual<typeof GitLabService>('@/lib/integrations/gitlab-service');
      mockGetGitLabIntegration.mockImplementation(service.getGitLabIntegration);
      mockListGitLabBranches.mockImplementation(service.listGitLabBranches);
      mockIntegrationRows.mockResolvedValue([integration]);
      mockFetchGitLabCredential.mockResolvedValue({
        status: 'available',
        token: 'test-token',
        instanceUrl,
        glabIsOAuth2: true,
      });
      mockFetchGitLabBranches.mockImplementation(async (_token, projectId, host) => {
        if (host !== instanceUrl) throw new Error('Wrong GitLab host');
        if (projectId === '42') return [{ name: 'release/Case', default: true, protected: true }];
        if (projectId === projectPath)
          return [{ name: 'legacy-path', default: true, protected: false }];
        throw new Error('Wrong GitLab project');
      });
    });

    it.each<Owner>([owner, { type: 'org', id: 'organization-1' }])(
      'uses the immutable project ID and configured host for $type branches',
      async selectedOwner => {
        const { listGitLabRepositoryBranches } = await import('./gitlab-integration-helpers');
        await expect(
          listGitLabRepositoryBranches(selectedOwner, 'actor', {
            ...reference,
            authorization: { ...reference.authorization, owner: selectedOwner },
          })
        ).resolves.toEqual({
          branches: [{ name: 'release/Case', isDefault: true }],
          defaultBranch: 'release/Case',
          nextCursor: null,
        });
      }
    );

    it.each(['owner', 'integration', 'instance', 'repository', 'path'] as const)(
      'rejects a changed %s without substituting a project',
      async changed => {
        if (changed === 'integration') mockIntegrationRows.mockResolvedValue([]);
        const { listGitLabRepositoryBranches } = await import('./gitlab-integration-helpers');
        await expect(
          listGitLabRepositoryBranches(owner, 'actor', {
            repository: {
              ...reference.repository,
              ...(changed === 'instance' ? { instanceUrl: 'https://other.example.com' } : {}),
              ...(changed === 'repository' ? { repositoryId: '99' } : {}),
              ...(changed === 'path' ? { fullName: projectPath.toLowerCase() } : {}),
            },
            authorization: {
              ...reference.authorization,
              owner: changed === 'owner' ? { type: 'org', id: owner.id } : owner,
            },
          })
        ).rejects.toMatchObject({
          code:
            changed === 'owner'
              ? 'FORBIDDEN'
              : changed === 'instance'
                ? 'PRECONDITION_FAILED'
                : 'NOT_FOUND',
        });
      }
    );

    it('returns zero branches without guessing a default', async () => {
      mockFetchGitLabBranches.mockResolvedValue([]);
      const { listGitLabRepositoryBranches } = await import('./gitlab-integration-helpers');
      await expect(listGitLabRepositoryBranches(owner, 'actor', reference)).resolves.toEqual({
        branches: [],
        defaultBranch: null,
        nextCursor: null,
      });
    });

    it('keeps the default unavailable when no branch is marked default', async () => {
      mockFetchGitLabBranches.mockResolvedValue([
        { name: 'feature/Case', default: false, protected: false },
      ]);
      const { listGitLabRepositoryBranches } = await import('./gitlab-integration-helpers');
      await expect(listGitLabRepositoryBranches(owner, 'actor', reference)).resolves.toEqual({
        branches: [{ name: 'feature/Case', isDefault: false }],
        defaultBranch: null,
        nextCursor: null,
      });
    });

    it('preserves a retryable provider branch failure', async () => {
      const error = new Error('GitLab branch page unavailable');
      mockFetchGitLabBranches.mockRejectedValue(error);
      const { listGitLabRepositoryBranches } = await import('./gitlab-integration-helpers');
      await expect(listGitLabRepositoryBranches(owner, 'actor', reference)).rejects.toBe(error);
    });

    it('retains path-only branch lookup for a legacy caller', async () => {
      await expect(
        mockListGitLabBranches(owner, integration.id, { userId: owner.id }, projectPath)
      ).resolves.toEqual({ branches: [{ name: 'legacy-path', isDefault: true }] });
    });

    it('rejects an ambiguous unpinned clone host', async () => {
      mockIntegrationRows.mockResolvedValue([integration, { ...integration, id: 'integration-2' }]);
      const { getGitLabInstanceUrlForUser } = await import('./gitlab-integration-helpers');
      await expect(getGitLabInstanceUrlForUser(owner.id)).rejects.toMatchObject({
        code: 'CONFLICT',
      });
    });
  });

  describe('discovery identity', () => {
    const integrationId = '11111111-1111-4111-8111-111111111111';
    const instanceUrl = 'https://gitlab.example.com/Enterprise';
    const project = {
      id: 42,
      name: 'API',
      full_name: 'Group/Subgroup/API',
      private: true,
      default_branch: 'release/Case',
    };
    const owners = [
      { type: 'user', id: 'oauth/user' },
      { type: 'org', id: '22222222-2222-4222-8222-222222222222' },
    ] as const;

    it.each(owners.flatMap(owner => [false, true].map(fresh => ({ owner, fresh }))))(
      'retains the producing identity for $owner.type, fresh=$fresh',
      async ({ owner, fresh }) => {
        mockGetGitLabIntegration.mockResolvedValue({
          id: integrationId,
          integration_status: 'active',
          repositories: [project],
          metadata: { gitlab_instance_url: `${instanceUrl}/` },
          repositories_synced_at: '2026-08-29T00:00:00Z',
        } as PlatformIntegration);
        mockGetValidGitLabToken.mockResolvedValue('token');
        mockFetchGitLabProjects.mockResolvedValue([project]);
        const helpers = await import('./gitlab-integration-helpers');
        const result =
          owner.type === 'user'
            ? await helpers.fetchGitLabRepositoriesForUser(owner.id, fresh)
            : await helpers.fetchGitLabRepositoriesForOrganization(owner.id, 'actor', fresh);
        expect(result.repositories).toEqual([
          {
            id: 42,
            name: 'API',
            fullName: 'Group/Subgroup/API',
            private: true,
            defaultBranch: 'release/Case',
            platformIntegrationId: integrationId,
            instanceUrl,
            repositoryReference: {
              repository: {
                provider: 'gitlab',
                repositoryId: '42',
                instanceUrl,
                fullName: 'Group/Subgroup/API',
                defaultBranch: 'release/Case',
              },
              authorization: { kind: 'ownerIntegration', owner, integrationId },
            },
          },
        ]);
      }
    );

    it('keeps a missing old default explicitly unavailable', async () => {
      mockGetGitLabIntegration.mockResolvedValue({
        id: integrationId,
        repositories: [{ id: 42, name: 'API', full_name: project.full_name, private: true }],
        metadata: null,
      } as PlatformIntegration);
      const { fetchGitLabRepositoriesForUser } = await import('./gitlab-integration-helpers');
      const result = await fetchGitLabRepositoriesForUser('oauth/user');
      expect(result.repositories[0].repositoryReference.repository).toEqual({
        provider: 'gitlab',
        repositoryId: '42',
        instanceUrl: 'https://gitlab.com',
        fullName: project.full_name,
        defaultBranch: null,
      });
      expect(result.repositories[0].defaultBranch).toBeUndefined();
    });

    it('does not relabel fresh repositories after the integration is replaced', async () => {
      mockGetGitLabIntegration.mockResolvedValue({
        id: integrationId,
        repositories: [],
        metadata: { gitlab_instance_url: instanceUrl },
      } as unknown as PlatformIntegration);
      mockGetValidGitLabToken.mockResolvedValue('token');
      mockFetchGitLabProjects.mockImplementation(async () => {
        mockGetGitLabIntegration.mockResolvedValue({
          id: 'replacement',
          metadata: { gitlab_instance_url: 'https://other.example.com' },
        } as PlatformIntegration);
        return [project];
      });
      const { fetchGitLabRepositoriesForUser } = await import('./gitlab-integration-helpers');
      const result = await fetchGitLabRepositoriesForUser('oauth/user', true);
      expect(result.repositories[0].repositoryReference).toMatchObject({
        repository: { instanceUrl, repositoryId: '42' },
        authorization: { integrationId },
      });
    });

    it.each(owners)(
      'keeps same-name projects on the selected $type integration host',
      async owner => {
        mockGetGitLabIntegration.mockImplementation(
          async (_owner, selector) =>
            ({
              id: selector,
              repositories: [project],
              metadata: {
                gitlab_instance_url:
                  selector === integrationId ? instanceUrl : 'https://other.example.com/gitlab',
              },
            }) as PlatformIntegration
        );
        const helpers = await import('./gitlab-integration-helpers');
        const getHost =
          owner.type === 'user'
            ? helpers.getGitLabInstanceUrlForUser
            : helpers.getGitLabInstanceUrlForOrganization;
        expect(
          helpers.buildGitLabCloneUrl(project.full_name, await getHost(owner.id, integrationId))
        ).toBe('https://gitlab.example.com/Enterprise/Group/Subgroup/API.git');
        expect(
          helpers.buildGitLabCloneUrl(project.full_name, await getHost(owner.id, 'other'))
        ).toBe('https://other.example.com/gitlab/Group/Subgroup/API.git');
      }
    );

    it.each(owners)('rejects a stale $type selector instead of using gitlab.com', async owner => {
      mockGetGitLabIntegration.mockResolvedValue(null);
      const helpers = await import('./gitlab-integration-helpers');
      const getHost =
        owner.type === 'user'
          ? helpers.getGitLabInstanceUrlForUser
          : helpers.getGitLabInstanceUrlForOrganization;
      await expect(getHost(owner.id, integrationId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('rejects a changed configured host on an existing integration', async () => {
      mockGetGitLabIntegration.mockResolvedValue({
        id: integrationId,
        metadata: { gitlab_instance_url: 'https://other.example.com' },
      } as PlatformIntegration);
      const { getGitLabInstanceUrlForUser } = await import('./gitlab-integration-helpers');
      await expect(
        getGitLabInstanceUrlForUser('oauth/user', integrationId, instanceUrl)
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    });

    it('preserves the old discovery error when a provider page fails', async () => {
      mockGetGitLabIntegration.mockResolvedValue({
        id: integrationId,
        repositories: null,
        metadata: {},
      } as PlatformIntegration);
      mockGetValidGitLabToken.mockResolvedValue('token');
      mockFetchGitLabProjects.mockRejectedValue(new Error('page 2 failed'));
      const { fetchGitLabRepositoriesForUser } = await import('./gitlab-integration-helpers');
      await expect(fetchGitLabRepositoriesForUser('oauth/user', true)).rejects.toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to fetch GitLab repositories',
      });
    });

    it('distinguishes a connected empty repository list from no integration', async () => {
      mockGetGitLabIntegration.mockResolvedValue({
        id: integrationId,
        repositories: null,
        metadata: {},
      } as PlatformIntegration);
      mockGetValidGitLabToken.mockResolvedValue('token');
      mockFetchGitLabProjects.mockResolvedValue([]);
      const { fetchGitLabRepositoriesForUser } = await import('./gitlab-integration-helpers');
      await expect(fetchGitLabRepositoriesForUser('oauth/user')).resolves.toMatchObject({
        integrationInstalled: true,
        repositories: [],
      });
      mockGetGitLabIntegration.mockResolvedValue(null);
      await expect(fetchGitLabRepositoriesForUser('oauth/user')).resolves.toMatchObject({
        integrationInstalled: false,
        repositories: [],
      });
    });
  });
});
