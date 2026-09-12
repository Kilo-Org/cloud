import { describe, expect, it, beforeEach } from '@jest/globals';
import type { PlatformIntegration } from '@kilocode/db/schema';
import { listProviderRepositoryBranches } from './provider-branch-listing';

const mockGetIntegrationForOwner = jest.fn();
const mockGetIntegrationsByOrganization = jest.fn();
const mockGetValidGitLabToken = jest.fn();
const mockFetchGitLabBranches = jest.fn();
const mockListGitHubBranches = jest.fn();

jest.mock('@/lib/integrations/db/platform-integrations', () => ({
  getIntegrationForOwner: (...args: unknown[]) => mockGetIntegrationForOwner(...args),
  getIntegrationsByOrganization: (...args: unknown[]) => mockGetIntegrationsByOrganization(...args),
}));

jest.mock('@/lib/integrations/github-apps-service', () => ({
  listBranches: (...args: unknown[]) => mockListGitHubBranches(...args),
}));

jest.mock('@/lib/integrations/gitlab-service', () => ({
  getValidGitLabToken: (...args: unknown[]) => mockGetValidGitLabToken(...args),
}));

jest.mock('@/lib/integrations/platforms/gitlab/adapter', () => ({
  fetchGitLabBranches: (...args: unknown[]) => mockFetchGitLabBranches(...args),
}));

jest.mock('@/lib/utils.server', () => ({
  logExceptInTest: () => {},
  warnExceptInTest: () => {},
}));

const integrationRow = {
  id: 'intg_1',
  platform: 'gitlab',
  integration_status: 'active',
  owned_by_user_id: 'user_1',
  owned_by_organization_id: null,
  metadata: { gitlab_instance_url: 'https://gitlab.example.com' },
  repositories: [{ id: 7, name: 'repo', full_name: 'group/repo', private: true }],
} as unknown as PlatformIntegration;

beforeEach(() => {
  jest.clearAllMocks();
  mockGetIntegrationForOwner.mockResolvedValue(integrationRow);
  mockGetValidGitLabToken.mockResolvedValue('glpat-mock-token');
  mockFetchGitLabBranches.mockResolvedValue([
    { name: 'main', default: true, protected: true },
    { name: 'feature/deploy', default: false, protected: false },
  ]);
});

describe('listProviderRepositoryBranches (gitlab)', () => {
  it('authorizes the project against the integration repository cache before listing', async () => {
    const listing = await listProviderRepositoryBranches({
      platform: 'gitlab',
      userId: 'user_1',
      repositoryFullName: 'group/repo',
    });

    expect(listing).toEqual({
      defaultBranch: 'main',
      branches: ['main', 'feature/deploy'],
    });
    expect(mockFetchGitLabBranches).toHaveBeenCalledWith(
      'glpat-mock-token',
      'group/repo',
      'https://gitlab.example.com'
    );
  });

  it('refuses a project outside the connected repositories before any provider call', async () => {
    await expect(
      listProviderRepositoryBranches({
        platform: 'gitlab',
        userId: 'user_1',
        repositoryFullName: 'other/project',
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(mockGetValidGitLabToken).not.toHaveBeenCalled();
    expect(mockFetchGitLabBranches).not.toHaveBeenCalled();
  });
});
