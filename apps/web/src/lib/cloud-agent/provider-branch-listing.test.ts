import { describe, expect, it, beforeEach } from '@jest/globals';
import type { PlatformIntegration } from '@kilocode/db/schema';
import { GitLabBranchesFetchError } from '@/lib/integrations/platforms/gitlab/adapter';
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
  ...jest.requireActual('@/lib/integrations/platforms/gitlab/adapter'),
  fetchGitLabBranches: (...args: unknown[]) => mockFetchGitLabBranches(...args),
}));

jest.mock('@kilocode/web-shared/lib/utils.server', () => ({
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
      truncated: false,
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

/** Octokit's RequestError carries the refusal status; the personal path reads only that. */
function githubRefusal(status: number, message = 'GitHub refused the request') {
  return Object.assign(new Error(message), { status });
}

describe('listProviderRepositoryBranches (github refusals)', () => {
  const githubIntegration = {
    ...integrationRow,
    platform: 'github',
  } as unknown as PlatformIntegration;

  beforeEach(() => {
    mockGetIntegrationForOwner.mockResolvedValue(githubIntegration);
  });

  it('maps a blocked repository (403) to FORBIDDEN instead of a 500', async () => {
    mockListGitHubBranches.mockRejectedValue(githubRefusal(403, 'Repository access blocked'));

    await expect(
      listProviderRepositoryBranches({
        platform: 'github',
        userId: 'user_1',
        repositoryFullName: 'blocked/repo',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('keeps a secondary-rate-limited 403 retryable instead of FORBIDDEN', async () => {
    mockListGitHubBranches.mockRejectedValue(
      githubRefusal(403, 'You have exceeded a secondary rate limit.')
    );

    await expect(
      listProviderRepositoryBranches({
        platform: 'github',
        userId: 'user_1',
        repositoryFullName: 'octocat/hello',
      })
    ).rejects.toMatchObject({ code: 'BAD_GATEWAY' });
  });

  it('keeps a primary-rate-limited 403 retryable', async () => {
    mockListGitHubBranches.mockRejectedValue(
      Object.assign(new Error('API rate limit exceeded'), {
        status: 403,
        response: { headers: { 'x-ratelimit-remaining': '0' } },
      })
    );

    await expect(
      listProviderRepositoryBranches({
        platform: 'github',
        userId: 'user_1',
        repositoryFullName: 'octocat/hello',
      })
    ).rejects.toMatchObject({ code: 'BAD_GATEWAY' });
  });

  it('maps a missing repository (404) to NOT_FOUND instead of a 500', async () => {
    mockListGitHubBranches.mockRejectedValue(githubRefusal(404, 'Not Found'));

    await expect(
      listProviderRepositoryBranches({
        platform: 'github',
        userId: 'user_1',
        repositoryFullName: 'missing/repo',
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('leaves a server-side GitHub failure (5xx) untouched', async () => {
    const failure = githubRefusal(500, 'Server Error');
    mockListGitHubBranches.mockRejectedValue(failure);

    await expect(
      listProviderRepositoryBranches({
        platform: 'github',
        userId: 'user_1',
        repositoryFullName: 'octocat/hello',
      })
    ).rejects.toBe(failure);
  });

  it('returns the listing when GitHub accepts the request', async () => {
    mockListGitHubBranches.mockResolvedValue({
      branches: [
        { name: 'main', isDefault: true },
        { name: 'dev', isDefault: false },
      ],
    });

    const listing = await listProviderRepositoryBranches({
      platform: 'github',
      userId: 'user_1',
      repositoryFullName: 'octocat/hello',
    });

    expect(listing).toEqual({ defaultBranch: 'main', branches: ['main', 'dev'], truncated: false });
  });
});

describe('listProviderRepositoryBranches (gitlab refusals)', () => {
  it('maps a personal 403 from GitLab to FORBIDDEN instead of a 500', async () => {
    mockFetchGitLabBranches.mockRejectedValue(
      new GitLabBranchesFetchError(403, 'GitLab branches fetch failed: 403')
    );

    await expect(
      listProviderRepositoryBranches({
        platform: 'gitlab',
        userId: 'user_1',
        repositoryFullName: 'group/repo',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('maps a refused credential to the reconnect state', async () => {
    mockFetchGitLabBranches.mockRejectedValue(
      new GitLabBranchesFetchError(401, 'GitLab branches fetch failed: 401')
    );

    await expect(
      listProviderRepositoryBranches({
        platform: 'gitlab',
        userId: 'user_1',
        repositoryFullName: 'group/repo',
      })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('maps an organization connection 403 to the reconnect state', async () => {
    mockFetchGitLabBranches.mockRejectedValue(
      new GitLabBranchesFetchError(403, 'GitLab branches fetch failed: 403')
    );

    await expect(
      listProviderRepositoryBranches({
        platform: 'gitlab',
        userId: 'user_1',
        organizationId: 'org_1',
        repositoryFullName: 'group/repo',
      })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('maps a 404 from GitLab to NOT_FOUND instead of a 500', async () => {
    mockFetchGitLabBranches.mockRejectedValue(
      new GitLabBranchesFetchError(404, 'GitLab branches fetch failed: 404')
    );

    await expect(
      listProviderRepositoryBranches({
        platform: 'gitlab',
        userId: 'user_1',
        repositoryFullName: 'group/repo',
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('maps any other GitLab failure to a retryable BAD_GATEWAY', async () => {
    mockFetchGitLabBranches.mockRejectedValue(
      new GitLabBranchesFetchError(500, 'GitLab branches fetch failed: 500')
    );

    await expect(
      listProviderRepositoryBranches({
        platform: 'gitlab',
        userId: 'user_1',
        repositoryFullName: 'group/repo',
      })
    ).rejects.toMatchObject({ code: 'BAD_GATEWAY' });
  });
});
