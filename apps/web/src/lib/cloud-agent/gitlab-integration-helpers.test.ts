import { describe, expect, it, jest, beforeAll, beforeEach } from '@jest/globals';
import type { PlatformIntegration } from '@kilocode/db/schema';
import type { Owner } from '@/lib/integrations/core/types';
import type { RepositoryReadOptions } from '@/lib/integrations/core/repository-read-limits';
import type { buildGitLabCloneUrl as BuildGitLabCloneUrl } from './gitlab-integration-helpers';

let buildGitLabCloneUrl: typeof BuildGitLabCloneUrl;

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
  jest.fn<
    (
      accessToken: string,
      instanceUrl: string,
      options?: RepositoryReadOptions
    ) => Promise<unknown[]>
  >();

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

jest.mock('dns/promises', () => ({
  lookup: jest.fn(),
}));

beforeAll(async () => {
  ({ buildGitLabCloneUrl } = await import('./gitlab-integration-helpers'));
});

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

describe.each(['personal', 'organization'] as const)('bounded GitLab %s reads', scope => {
  const repositories = Array.from({ length: 60 }, (_, id) => ({
    id,
    name: `repo-${id}`,
    full_name: `group/repo-${id}`,
    private: false,
  }));
  const integration = (overrides: Partial<PlatformIntegration> = {}) =>
    ({
      id: 'integration-1',
      platform: 'gitlab',
      integration_status: 'active',
      suspended_at: null,
      auth_invalid_at: null,
      metadata: {},
      repositories,
      repositories_synced_at: '2026-06-25 18:00:00+00',
      ...overrides,
    }) as PlatformIntegration;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetValidGitLabToken.mockReset().mockResolvedValue('valid-token');
    mockFetchGitLabProjects.mockReset();
    mockUpdateRepositoriesForIntegration.mockReset();
  });

  function configure(value: PlatformIntegration | null) {
    mockGetIntegrationForOwner.mockResolvedValue(value);
    mockGetIntegrationForOrganization.mockResolvedValue(value);
  }

  async function read(
    forceRefresh = false,
    options: RepositoryReadOptions | undefined = { bounded: true }
  ) {
    const helpers = await import('./gitlab-integration-helpers');
    return scope === 'personal'
      ? helpers.fetchGitLabRepositoriesForUser('oauth/member', forceRefresh, options)
      : helpers.fetchGitLabRepositoriesForOrganization(
          'org-123',
          'oauth/member',
          forceRefresh,
          options
        );
  }

  it.each([
    ['absent', null, 'not_connected'],
    ['empty', integration({ repositories: [] }), 'available'],
    ['suspended', integration({ suspended_at: '2026-06-25 18:00:00+00' }), 'suspended'],
    [
      'auth-invalid',
      integration({ auth_invalid_at: '2026-06-25 18:00:00+00' }),
      'reconnect_required',
    ],
    ['inactive', integration({ integration_status: 'pending' }), 'misconfigured'],
    [
      'malformed URL',
      integration({ metadata: { gitlab_instance_url: 'not a URL' } }),
      'misconfigured',
    ],
    [
      'private URL',
      integration({ metadata: { gitlab_instance_url: 'https://127.0.0.1' } }),
      'misconfigured',
    ],
    [
      'unsafe hostname',
      integration({ metadata: { gitlab_instance_url: 'https://gitlab.local' } }),
      'misconfigured',
    ],
    [
      'invalid URL',
      integration({ metadata: { gitlab_instance_url: 'https://user:password@gitlab.com' } }),
      'misconfigured',
    ],
  ] as const)('keeps %s distinct without fetching', async (_label, value, status) => {
    configure(value);
    await expect(read()).resolves.toMatchObject({
      status,
      integrationInstalled: value !== null,
      repositories: [],
    });
    expect(mockGetValidGitLabToken).not.toHaveBeenCalled();
    expect(mockFetchGitLabProjects).not.toHaveBeenCalled();
  });

  it('caps a cached list before checking repository IDs', async () => {
    const cached = [...repositories];
    cached[50] = {
      ...cached[50],
      get id(): number {
        throw new Error('Past the bound');
      },
    };
    configure(integration({ repositories: cached }));
    const result = await read();
    expect(result.status).toBe('available');
    expect(result.repositories).toHaveLength(50);
    expect(result.repositories.at(-1)?.fullName).toBe('group/repo-49');
  });

  it.each([false, true])(
    'preserves the complete cache and legacy behavior on refresh=%s',
    async forceRefresh => {
      const value = integration({
        repositories: forceRefresh ? repositories : null,
        repositories_synced_at: forceRefresh ? '2026-06-25 18:00:00+00' : null,
      });
      configure(value);
      mockUpdateRepositoriesForIntegration.mockImplementation(async (_id, saved) => {
        value.repositories = saved as PlatformIntegration['repositories'];
      });
      mockFetchGitLabProjects.mockImplementation(async (_token, _url, options) => {
        if (!options?.bounded || !options.signal) throw new Error('Unbounded transport');
        return repositories.slice(0, 50);
      });
      const result = await read(forceRefresh);
      expect(result.status).toBe('available');
      expect(result.repositories).toHaveLength(50);
      mockFetchGitLabProjects.mockResolvedValue(repositories);
      const legacy = await read(false, { bounded: false });
      expect(legacy.repositories).toHaveLength(60);
      expect(legacy).not.toHaveProperty('status');
    }
  );

  it.each([
    ['UNAUTHORIZED', 'reconnect_required'],
    ['INTERNAL_SERVER_ERROR', 'temporarily_unavailable'],
  ] as const)(
    'keeps credential rejection separate from temporary failure',
    async (code, status) => {
      const { TRPCError } = await import('@trpc/server');
      configure(integration({ repositories: null }));
      mockGetValidGitLabToken.mockRejectedValue(
        new TRPCError({ code, message: 'provider details' })
      );
      await expect(read()).resolves.toEqual({
        status,
        integrationInstalled: true,
        repositories: [],
        syncedAt: null,
      });
    }
  );

  it('does not expose a raw project-fetch failure', async () => {
    configure(integration({ repositories: null }));
    mockFetchGitLabProjects.mockRejectedValue(new Error('secret provider response'));
    await expect(read()).resolves.toEqual({
      status: 'temporarily_unavailable',
      integrationInstalled: true,
      repositories: [],
      syncedAt: null,
    });
  });

  describe('self-hosted DNS failures', () => {
    beforeEach(async () => {
      const { lookup } = await import('dns/promises');
      const { buildGitLabUrl, resolveGitLabUrlSafely } =
        await import('@/lib/integrations/platforms/gitlab/instance-url');
      jest
        .mocked(lookup)
        .mockReset()
        .mockRejectedValue(
          Object.assign(new Error('getaddrinfo EAI_AGAIN gitlab.example.com'), {
            code: 'EAI_AGAIN',
          })
        );
      configure(
        integration({
          metadata: { gitlab_instance_url: 'https://gitlab.example.com' },
          repositories: null,
        })
      );
      mockFetchGitLabProjects.mockImplementation(async (_token, instanceUrl) => {
        await resolveGitLabUrlSafely(buildGitLabUrl(instanceUrl, '/api/v4/projects'));
        return [];
      });
    });

    it('reports transient lookup failure without exposing resolver details', async () => {
      await expect(read()).resolves.toEqual({
        status: 'temporarily_unavailable',
        integrationInstalled: true,
        repositories: [],
        syncedAt: null,
      });
    });

    it('keeps private DNS answers misconfigured', async () => {
      const { lookup } = await import('dns/promises');
      jest.mocked(lookup).mockResolvedValueOnce([{ address: '192.168.1.10', family: 4 }]);
      await expect(read()).resolves.toEqual({
        status: 'misconfigured',
        integrationInstalled: true,
        repositories: [],
        syncedAt: null,
      });
    });

    it('preserves the legacy failure when bounded options are omitted', async () => {
      const helpers = await import('./gitlab-integration-helpers');
      const result =
        scope === 'personal'
          ? helpers.fetchGitLabRepositoriesForUser('oauth/member')
          : helpers.fetchGitLabRepositoriesForOrganization('org-123', 'oauth/member');
      await expect(result).rejects.toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to fetch GitLab repositories',
      });
    });
  });

  it('stops before project fetching when credential retrieval exceeds the deadline', async () => {
    jest.useFakeTimers();
    try {
      configure(integration({ repositories: null }));
      const token = Promise.withResolvers<string>();
      mockGetValidGitLabToken.mockReturnValue(token.promise);
      const result = read();
      await jest.advanceTimersByTimeAsync(30_000);
      await expect(result).resolves.toMatchObject({
        status: 'temporarily_unavailable',
        repositories: [],
      });
      token.resolve('late-token');
      await Promise.resolve();
      expect(mockFetchGitLabProjects).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});
