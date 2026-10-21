/**
 * @jest-environment node
 */

const mockListBranches = jest.fn();
const mockListReposAccessibleToInstallation = jest.fn();
const mockGetRepo = jest.fn();
const mockListReviewComments = jest.fn();

jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation(() => ({
    apps: { listReposAccessibleToInstallation: mockListReposAccessibleToInstallation },
    repos: { get: mockGetRepo, listBranches: mockListBranches },
    pulls: { listReviewComments: mockListReviewComments },
  })),
}));
jest.mock('@octokit/auth-app', () => ({
  createAppAuth: () => async () => ({
    token: 'installation-token',
    expiresAt: '2099-01-01T00:00:00Z',
  }),
}));
jest.mock('./app-selector', () => ({
  getGitHubAppCredentials: () => ({ appId: '1', privateKey: 'test' }),
}));
jest.mock('../../github/runtime-authorization', () => ({
  assertGitHubInstallationRuntimeAuthorized: jest.fn(async () => undefined),
}));
jest.mock('@kilocode/web-shared/lib/utils.server', () => ({
  logExceptInTest: jest.fn(),
  warnExceptInTest: jest.fn(),
}));

import { warnExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import {
  fetchGitHubBranches,
  fetchGitHubRepositories,
  fetchGitHubRepositoriesForMaintenance,
  fetchPRInlineComments,
} from './adapter';

function branchPage(page: number, count: number, link?: string) {
  return {
    data: Array.from({ length: count }, (_, index) => ({ name: `branch-${page}-${index}` })),
    headers: link ? { link } : {},
  };
}

function repoPage(page: number, count: number, archivedCount = 0, link?: string) {
  return {
    data: {
      repositories: Array.from({ length: count }, (_, index) => ({
        id: page * 1000 + index,
        name: `repo-${page}-${index}`,
        full_name: `acme/repo-${page}-${index}`,
        private: false,
        archived: index < archivedCount,
        created_at: '2024-01-01T00:00:00Z',
      })),
    },
    headers: link ? { link } : {},
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('fetchGitHubBranches pagination bounds', () => {
  it('stops at a fixed page count when the provider keeps returning full pages', async () => {
    mockGetRepo.mockResolvedValue({ data: { default_branch: 'main' } });
    mockListBranches.mockImplementation(async ({ page }: { page: number }) =>
      branchPage(page, 100)
    );

    const branches = await fetchGitHubBranches('123456', 'acme/repo');

    expect(mockListBranches).toHaveBeenCalledTimes(10);
    expect(branches).toHaveLength(1000);
    expect(branches[0]).toEqual({ name: 'branch-1-0', isDefault: false });
    expect(warnExceptInTest).toHaveBeenCalledTimes(1);
  });

  it('stops on a short page without reaching the ceiling and marks the default branch', async () => {
    mockGetRepo.mockResolvedValue({ data: { default_branch: 'branch-2-0' } });
    mockListBranches
      .mockImplementationOnce(async () => branchPage(1, 100))
      .mockImplementationOnce(async () => branchPage(2, 3));

    const branches = await fetchGitHubBranches('123456', 'acme/repo');

    expect(mockListBranches).toHaveBeenCalledTimes(2);
    expect(branches).toHaveLength(103);
    expect(branches.find(branch => branch.isDefault)).toEqual({
      name: 'branch-2-0',
      isDefault: true,
    });
    expect(warnExceptInTest).not.toHaveBeenCalled();
  });

  it('warns only when a full page at the ceiling still has a next page', async () => {
    mockGetRepo.mockResolvedValue({ data: { default_branch: 'main' } });
    mockListBranches.mockImplementation(async ({ page }: { page: number }) =>
      branchPage(
        page,
        100,
        page < 10
          ? `<https://api.github.com/x?page=${page + 1}>; rel="next"`
          : '<https://api.github.com/x?page=1>; rel="first"'
      )
    );

    await fetchGitHubBranches('123456', 'acme/repo');
    expect(mockListBranches).toHaveBeenCalledTimes(10);
    // The final page reports no next page, so nothing was dropped.
    expect(warnExceptInTest).not.toHaveBeenCalled();

    jest.clearAllMocks();
    mockGetRepo.mockResolvedValue({ data: { default_branch: 'main' } });
    mockListBranches.mockImplementation(async ({ page }: { page: number }) =>
      branchPage(page, 100, `<https://api.github.com/x?page=${page + 1}>; rel="next"`)
    );

    await fetchGitHubBranches('123456', 'acme/repo');
    expect(warnExceptInTest).toHaveBeenCalledTimes(1);
  });
});

describe('fetchGitHubRepositories pagination bounds', () => {
  it('stops at a fixed page count when the provider keeps returning full pages', async () => {
    mockListReposAccessibleToInstallation.mockImplementation(async ({ page }: { page: number }) =>
      repoPage(page, 100)
    );

    const repositories = await fetchGitHubRepositories('123456');

    expect(mockListReposAccessibleToInstallation).toHaveBeenCalledTimes(50);
    expect(repositories).toHaveLength(5000);
    expect(warnExceptInTest).toHaveBeenCalledTimes(1);
  });

  it('stops on a short page and still drops archived repositories', async () => {
    mockListReposAccessibleToInstallation
      .mockImplementationOnce(async () => repoPage(1, 100))
      .mockImplementationOnce(async () => repoPage(2, 3, 1));

    const repositories = await fetchGitHubRepositories('123456');

    expect(mockListReposAccessibleToInstallation).toHaveBeenCalledTimes(2);
    expect(repositories).toHaveLength(102);
    expect(repositories.map(repository => repository.full_name)).not.toContain('acme/repo-2-0');
    expect(warnExceptInTest).not.toHaveBeenCalled();
  });

  it('bounds the maintenance listing with the same ceiling', async () => {
    mockListReposAccessibleToInstallation.mockImplementation(async ({ page }: { page: number }) =>
      repoPage(page, 100)
    );

    const repositories = await fetchGitHubRepositoriesForMaintenance('123456', 'standard');

    expect(mockListReposAccessibleToInstallation).toHaveBeenCalledTimes(50);
    expect(repositories).toHaveLength(5000);
    expect(warnExceptInTest).toHaveBeenCalledTimes(1);
  });
});

function commentPage(page: number, count: number, link?: string) {
  return {
    data: Array.from({ length: count }, (_, index) => ({
      id: page * 1000 + index,
      path: `src/file-${index}.ts`,
      line: index % 2 === 0 ? index + 1 : null,
      body: `comment-${page}-${index}`,
      position: index % 2 === 0 ? 1 : null,
      user: { login: 'reviewer' },
    })),
    headers: link ? { link } : {},
  };
}

describe('fetchPRInlineComments pagination bounds', () => {
  it('stops at a fixed page count when the provider keeps returning full pages', async () => {
    mockListReviewComments.mockImplementation(async ({ page }: { page: number }) =>
      commentPage(page, 100)
    );

    const comments = await fetchPRInlineComments('123456', 'acme', 'repo', 7);

    expect(mockListReviewComments).toHaveBeenCalledTimes(5);
    expect(comments).toHaveLength(500);
    expect(comments[0]).toEqual({
      id: 1000,
      path: 'src/file-0.ts',
      line: 1,
      body: 'comment-1-0',
      isOutdated: false,
      user: { login: 'reviewer' },
    });
    expect(comments[1]).toEqual({
      id: 1001,
      path: 'src/file-1.ts',
      line: null,
      body: 'comment-1-1',
      isOutdated: true,
      user: { login: 'reviewer' },
    });
    expect(warnExceptInTest).toHaveBeenCalledTimes(1);
  });

  it('stops on a short page without reaching the ceiling', async () => {
    mockListReviewComments
      .mockImplementationOnce(async () => commentPage(1, 100))
      .mockImplementationOnce(async () => commentPage(2, 4));

    const comments = await fetchPRInlineComments('123456', 'acme', 'repo', 7);

    expect(mockListReviewComments).toHaveBeenCalledTimes(2);
    expect(comments).toHaveLength(104);
    expect(warnExceptInTest).not.toHaveBeenCalled();
  });

  it('warns only when a full page at the ceiling still has a next page', async () => {
    mockListReviewComments.mockImplementation(async ({ page }: { page: number }) =>
      commentPage(
        page,
        100,
        page < 5
          ? `<https://api.github.com/x?page=${page + 1}>; rel="next"`
          : '<https://api.github.com/x?page=1>; rel="first"'
      )
    );

    await fetchPRInlineComments('123456', 'acme', 'repo', 7);
    expect(mockListReviewComments).toHaveBeenCalledTimes(5);
    expect(warnExceptInTest).not.toHaveBeenCalled();

    jest.clearAllMocks();
    mockListReviewComments.mockImplementation(async ({ page }: { page: number }) =>
      commentPage(page, 100, `<https://api.github.com/x?page=${page + 1}>; rel="next"`)
    );

    await fetchPRInlineComments('123456', 'acme', 'repo', 7);
    expect(warnExceptInTest).toHaveBeenCalledTimes(1);
  });
});
