import { describe, expect, it, beforeEach } from '@jest/globals';
import type { PlatformIntegration } from '@kilocode/db/schema';
import { GitLabBranchesFetchError } from '@/lib/integrations/platforms/gitlab/adapter';
import { getProviderBranchHead, listProviderRepositoryBranches } from './provider-branch-listing';

const mockGetIntegrationForOwner = jest.fn();
const mockGetIntegrationsByOrganization = jest.fn();
const mockGetValidGitLabToken = jest.fn();
const mockFetchGitLabBranches = jest.fn();
const mockListGitHubBranches = jest.fn();
const mockGetGitHubIntegrationById = jest.fn();
const mockFetchGitHubBranchHead = jest.fn();
const mockFetchGitLabBranchHead = jest.fn();

jest.mock('@/lib/integrations/db/platform-integrations', () => ({
  getIntegrationForOwner: (...args: unknown[]) => mockGetIntegrationForOwner(...args),
  getIntegrationsByOrganization: (...args: unknown[]) => mockGetIntegrationsByOrganization(...args),
  getGitHubIntegrationById: (...args: unknown[]) => mockGetGitHubIntegrationById(...args),
}));

jest.mock('@/lib/cloud-agent/github-branch-ops', () => ({
  fetchGitHubBranchHead: (...args: unknown[]) => mockFetchGitHubBranchHead(...args),
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
  fetchGitLabBranchHead: (...args: unknown[]) => mockFetchGitLabBranchHead(...args),
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

  it('keeps a 429 refusal retryable', async () => {
    mockListGitHubBranches.mockRejectedValue(githubRefusal(429, 'Too Many Requests'));

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

/** One healthy organization GitHub installation; `id` orders the walk. */
function organizationInstallation(id: string, cachedRepository: string | null) {
  return {
    ...integrationRow,
    id,
    platform: 'github',
    suspended_at: null,
    auth_invalid_at: null,
    repositories: cachedRepository
      ? [{ id: 1, name: cachedRepository.split('/')[1], full_name: cachedRepository }]
      : [],
  } as unknown as PlatformIntegration;
}

describe('listProviderRepositoryBranches (organization github installations)', () => {
  const listing = {
    branches: [
      { name: 'main', isDefault: true },
      { name: 'release', isDefault: false },
    ],
  };

  // The cache decides the order: the installation that lists the repository
  // goes first, so an unchanged expectation on the first call pins the walk.
  beforeEach(() => {
    mockGetIntegrationsByOrganization.mockResolvedValue([
      organizationInstallation('intg_first', 'octocat/hello'),
      organizationInstallation('intg_second', null),
    ]);
  });

  it('ends retryable when every installation is rate-limited', async () => {
    mockListGitHubBranches.mockRejectedValue(
      githubRefusal(403, 'You have exceeded a secondary rate limit.')
    );

    await expect(
      listProviderRepositoryBranches({
        platform: 'github',
        userId: 'user_1',
        organizationId: 'org_1',
        repositoryFullName: 'octocat/hello',
      })
    ).rejects.toMatchObject({
      code: 'BAD_GATEWAY',
      message: 'GitHub is limiting requests. Try again in a moment.',
    });
    expect(mockListGitHubBranches).toHaveBeenCalledTimes(2);
  });

  it('recovers from a rate-limited installation that a later one can still list', async () => {
    mockListGitHubBranches
      .mockRejectedValueOnce(githubRefusal(403, 'You have exceeded a secondary rate limit.'))
      .mockResolvedValueOnce(listing);

    await expect(
      listProviderRepositoryBranches({
        platform: 'github',
        userId: 'user_1',
        organizationId: 'org_1',
        repositoryFullName: 'octocat/hello',
      })
    ).resolves.toEqual({
      defaultBranch: 'main',
      branches: ['main', 'release'],
      truncated: false,
    });
    expect(mockListGitHubBranches).toHaveBeenCalledTimes(2);
  });

  it('ends retryable when the primary rate limit is exhausted', async () => {
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
        organizationId: 'org_1',
        repositoryFullName: 'octocat/hello',
      })
    ).rejects.toMatchObject({ code: 'BAD_GATEWAY' });
    expect(mockListGitHubBranches).toHaveBeenCalledTimes(2);
  });

  it('treats a 429 refusal as the retryable state, not an unreachable installation', async () => {
    mockListGitHubBranches.mockRejectedValue(githubRefusal(429, 'Too Many Requests'));

    await expect(
      listProviderRepositoryBranches({
        platform: 'github',
        userId: 'user_1',
        organizationId: 'org_1',
        repositoryFullName: 'octocat/hello',
      })
    ).rejects.toMatchObject({ code: 'BAD_GATEWAY' });
    expect(mockListGitHubBranches).toHaveBeenCalledTimes(2);
  });

  it('prefers the retryable state over the install message when one installation is limited', async () => {
    mockListGitHubBranches
      .mockRejectedValueOnce(githubRefusal(404, 'Not Found'))
      .mockRejectedValueOnce(githubRefusal(429, 'Too Many Requests'));

    await expect(
      listProviderRepositoryBranches({
        platform: 'github',
        userId: 'user_1',
        organizationId: 'org_1',
        repositoryFullName: 'octocat/hello',
      })
    ).rejects.toMatchObject({ code: 'BAD_GATEWAY' });
    expect(mockListGitHubBranches).toHaveBeenCalledTimes(2);
  });

  it('still walks past a permission 403 and keeps the install message when every installation refuses', async () => {
    mockListGitHubBranches.mockRejectedValue(githubRefusal(403, 'Repository access blocked'));

    await expect(
      listProviderRepositoryBranches({
        platform: 'github',
        userId: 'user_1',
        organizationId: 'org_1',
        repositoryFullName: 'octocat/hello',
      })
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message:
        'This repository is not available in any connected GitHub installation. Install the GitHub App on the account that owns it.',
    });
    expect(mockListGitHubBranches).toHaveBeenCalledTimes(2);
  });

  it('still falls through a 404 to the installation that can list the repository', async () => {
    mockListGitHubBranches
      .mockRejectedValueOnce(githubRefusal(404, 'Not Found'))
      .mockResolvedValueOnce(listing);

    await expect(
      listProviderRepositoryBranches({
        platform: 'github',
        userId: 'user_1',
        organizationId: 'org_1',
        repositoryFullName: 'octocat/hello',
      })
    ).resolves.toEqual({
      defaultBranch: 'main',
      branches: ['main', 'release'],
      truncated: false,
    });
    expect(mockListGitHubBranches).toHaveBeenCalledTimes(2);
  });
});

describe('getProviderBranchHead', () => {
  const githubIntegration = {
    ...integrationRow,
    id: 'intg_github_exact',
    platform: 'github',
    platform_installation_id: 'install_1',
    github_app_type: 'standard',
    suspended_at: null,
    auth_invalid_at: null,
    github_disconnected_at: null,
    repositories: [{ id: 1, name: 'repo', full_name: 'acme/repo', private: true }],
  } as unknown as PlatformIntegration;

  it('uses the exact supplied integration instead of reselecting by repository', async () => {
    mockGetGitHubIntegrationById.mockResolvedValue(githubIntegration);
    mockFetchGitHubBranchHead.mockResolvedValue({ sha: 'a'.repeat(40) });

    await expect(
      getProviderBranchHead({
        platform: 'github',
        userId: 'user_1',
        repositoryFullName: 'acme/repo',
        branch: 'feat',
        githubIntegrationId: 'intg_github_exact',
      })
    ).resolves.toEqual({ sha: 'a'.repeat(40) });

    expect(mockGetGitHubIntegrationById).toHaveBeenCalledWith(
      { type: 'user', id: 'user_1' },
      'intg_github_exact'
    );
    expect(mockGetIntegrationForOwner).not.toHaveBeenCalled();
    expect(mockFetchGitHubBranchHead).toHaveBeenCalledWith(
      expect.objectContaining({
        installationId: 'install_1',
        expectedIntegrationId: 'intg_github_exact',
        branch: 'feat',
        purpose: 'agent',
      })
    );
  });

  it('returns the explicit missing state for an unpushed branch', async () => {
    mockGetGitHubIntegrationById.mockResolvedValue(githubIntegration);
    mockFetchGitHubBranchHead.mockResolvedValue(null);

    await expect(
      getProviderBranchHead({
        platform: 'github',
        userId: 'user_1',
        repositoryFullName: 'acme/repo',
        branch: 'feat',
        githubIntegrationId: 'intg_github_exact',
      })
    ).resolves.toEqual({ missing: true });
  });

  it('maps a missing GitLab branch to missing rather than a provider default', async () => {
    mockFetchGitLabBranchHead.mockResolvedValue(null);
    mockGetValidGitLabToken.mockResolvedValue('glpat-mock-token');

    await expect(
      getProviderBranchHead({
        platform: 'gitlab',
        userId: 'user_1',
        repositoryFullName: 'group/repo',
        branch: 'feat',
      })
    ).resolves.toEqual({ missing: true });
  });
});
