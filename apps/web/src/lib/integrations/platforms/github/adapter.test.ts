import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { PlatformIntegration } from '@kilocode/db/schema';
import type { Owner } from '@/lib/integrations/core/types';
import type * as Adapter from './adapter';
import type * as Helpers from '@/lib/cloud-agent/github-integration-helpers';

const repository = {
  id: 42,
  name: 'API',
  full_name: 'acme/API',
  private: true,
  archived: false,
  created_at: '2026-08-01T00:00:00Z',
  default_branch: 'release/Case',
};
type ProviderRepository = Omit<typeof repository, 'default_branch'> & {
  default_branch?: string | null;
};
const mockListRepositories =
  jest.fn<() => Promise<{ data: { repositories: ProviderRepository[] } }>>();
const mockGetRepository = jest.fn<() => Promise<{ data: ProviderRepository }>>();
const mockListBranches = jest.fn<() => Promise<{ data: { name: string }[] }>>();
const mockGetIntegration =
  jest.fn<(owner: Owner, integrationId: string) => Promise<PlatformIntegration | null>>();

jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn(() => ({
    apps: { listReposAccessibleToInstallation: mockListRepositories },
    repos: { get: mockGetRepository, listBranches: mockListBranches },
  })),
}));
jest.mock('@octokit/auth-app', () => ({
  createAppAuth: () => async () => ({ token: 'test-installation-token', expiresAt: null }),
}));
jest.mock('./app-selector', () => ({
  getGitHubAppCredentials: () => ({ appId: 'test-app', privateKey: 'test-key' }),
}));
jest.mock('@/lib/utils.server', () => ({}));
jest.mock('@/lib/integrations/db/platform-integrations', () => ({
  getGitHubIntegrationById: mockGetIntegration,
}));
jest.mock('@/lib/integrations/platforms/github/adapter', () =>
  jest.requireActual<typeof Adapter>('./adapter')
);
jest.mock('@/components/cloud-agent/demo-config', () => ({}));

let fetchGitHubRepositories: typeof Adapter.fetchGitHubRepositories;
let fetchGitHubBranches: typeof Adapter.fetchGitHubBranches;
let listGitHubRepositoryBranches: typeof Helpers.listGitHubRepositoryBranches;

beforeAll(async () => {
  ({ fetchGitHubRepositories, fetchGitHubBranches } = await import('./adapter'));
  ({ listGitHubRepositoryBranches } = await import('@/lib/cloud-agent/github-integration-helpers'));
});

beforeEach(() => {
  jest.clearAllMocks();
  mockListRepositories.mockResolvedValue({ data: { repositories: [repository] } });
  mockGetRepository.mockResolvedValue({ data: repository });
  mockListBranches.mockResolvedValue({
    data: [{ name: 'feature/Case' }, { name: 'release/Case' }],
  });
  mockGetIntegration.mockResolvedValue({
    id: 'integration-1',
    platform: 'github',
    platform_installation_id: 'installation-1',
    github_app_type: 'standard',
    integration_status: 'active',
    suspended_at: null,
    auth_invalid_at: null,
    repositories: [repository],
  } as PlatformIntegration);
});

describe('GitHub discovery adapter', () => {
  it('retains the provider default alongside legacy repository fields', async () => {
    await expect(fetchGitHubRepositories('installation-1')).resolves.toEqual([
      {
        id: 42,
        name: 'API',
        full_name: 'acme/API',
        private: true,
        created_at: repository.created_at,
        default_branch: 'release/Case',
      },
    ]);
  });

  it.each([undefined, null])('does not guess an unavailable provider default: %s', async value => {
    mockListRepositories.mockResolvedValue({
      data: { repositories: [{ ...repository, default_branch: value }] },
    });
    const repositories = await fetchGitHubRepositories('installation-1');
    expect(repositories[0]).toMatchObject({ id: 42, full_name: 'acme/API' });
    expect(repositories[0].default_branch).toBeUndefined();
  });
});

describe('GitHub branch identity', () => {
  it.each<Owner>([
    { type: 'user', id: 'oauth/user' },
    { type: 'org', id: 'organization-1' },
  ])('rejects a live same-name replacement under a cached $type identity', async owner => {
    mockGetRepository.mockResolvedValue({ data: { ...repository, id: 99 } });
    await expect(
      listGitHubRepositoryBranches(owner, {
        repository: {
          provider: 'github',
          instanceUrl: 'https://github.com',
          repositoryId: '42',
          fullName: 'acme/API',
          defaultBranch: 'release/Case',
        },
        authorization: { kind: 'ownerIntegration', owner, integrationId: 'integration-1' },
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'GitHub repository not found' });
  });

  it('returns case-preserving branches for the pinned live repository', async () => {
    await expect(
      fetchGitHubBranches('installation-1', 'acme/API', 'standard', '42')
    ).resolves.toEqual([
      { name: 'feature/Case', isDefault: false },
      { name: 'release/Case', isDefault: true },
    ]);
  });

  it.each(['standard', 'lite'] as const)('preserves an unpinned %s caller', async appType => {
    mockGetRepository.mockResolvedValue({ data: { ...repository, id: 99 } });
    await expect(fetchGitHubBranches('installation-1', 'acme/API', appType)).resolves.toEqual([
      { name: 'feature/Case', isDefault: false },
      { name: 'release/Case', isDefault: true },
    ]);
  });

  it('returns an empty branch list for an empty repository', async () => {
    mockListBranches.mockResolvedValue({ data: [] });
    await expect(
      fetchGitHubBranches('installation-1', 'acme/API', 'standard', '42')
    ).resolves.toEqual([]);
  });

  it('does not invent a default when the provider has none', async () => {
    mockGetRepository.mockResolvedValue({ data: { ...repository, default_branch: null } });
    await expect(
      fetchGitHubBranches('installation-1', 'acme/API', 'standard', '42')
    ).resolves.toEqual([
      { name: 'feature/Case', isDefault: false },
      { name: 'release/Case', isDefault: false },
    ]);
  });

  it('preserves a later-page failure instead of returning incomplete branches', async () => {
    const error = new Error('GitHub page unavailable');
    mockListBranches
      .mockResolvedValueOnce({
        data: Array.from({ length: 100 }, (_, i) => ({ name: `branch-${i}` })),
      })
      .mockRejectedValueOnce(error);
    await expect(fetchGitHubBranches('installation-1', 'acme/API', 'standard', '42')).rejects.toBe(
      error
    );
  });
});
