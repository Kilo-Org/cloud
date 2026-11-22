import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { authorizeGitLabProject as AuthorizeGitLabProject } from './gitlab-project-permission';
import type { GitLabProjectAuthorization } from './gitlab-project-permission';

jest.mock('@/lib/cloud-agent/gitlab-integration-helpers', () => ({
  fetchGitLabRepositoriesForUser: jest.fn(),
}));

let mockFetchGitLabRepositoriesForUser: jest.MockedFunction<
  (
    userId: string,
    forceRefresh?: boolean
  ) => Promise<{
    integrationInstalled: boolean;
    repositories: { id: number; name: string; fullName: string; private: boolean }[];
    instanceUrl?: string;
  }>
>;
let authorizeGitLabProject: typeof AuthorizeGitLabProject;

function refusalMarkdown(result: GitLabProjectAuthorization): string {
  if (result.allowed) throw new Error('Expected the project to be refused');
  return result.markdown;
}

beforeAll(async () => {
  const gitlab = await import('@/lib/cloud-agent/gitlab-integration-helpers');
  mockFetchGitLabRepositoriesForUser = jest.mocked(gitlab.fetchGitLabRepositoriesForUser);
  authorizeGitLabProject = (await import('./gitlab-project-permission')).authorizeGitLabProject;
});

describe('authorizeGitLabProject', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchGitLabRepositoriesForUser.mockResolvedValue({
      integrationInstalled: true,
      repositories: [{ id: 1, name: 'project', fullName: 'group/project', private: true }],
      instanceUrl: 'https://gitlab.com',
    });
  });

  it('allows the conversation project when the run has no requesting account', async () => {
    await expect(
      authorizeGitLabProject({
        project: 'group/project',
        projectInstanceUrl: 'https://gitlab.com',
        threadRepository: ' Group/Project ',
      })
    ).resolves.toEqual({ allowed: true });
    expect(mockFetchGitLabRepositoriesForUser).not.toHaveBeenCalled();
  });

  it('refuses another project when the run has no requesting account', async () => {
    const markdown = refusalMarkdown(
      await authorizeGitLabProject({
        project: 'group/other',
        projectInstanceUrl: 'https://gitlab.com',
        threadRepository: 'group/project',
      })
    );

    expect(markdown).toContain('`group/other`');
    expect(markdown).toContain('GitLab connection in Kilo Code settings');
    expect(mockFetchGitLabRepositoriesForUser).not.toHaveBeenCalled();
  });

  it('refuses a project when the run has no requesting account and no conversation project', async () => {
    const markdown = refusalMarkdown(
      await authorizeGitLabProject({
        project: 'group/project',
        projectInstanceUrl: 'https://gitlab.com',
        threadRepository: null,
      })
    );

    expect(markdown).toContain('`group/project`');
  });

  it('allows a project the requester connection reaches on the same instance', async () => {
    mockFetchGitLabRepositoriesForUser.mockResolvedValue({
      integrationInstalled: true,
      repositories: [{ id: 2, name: 'project', fullName: 'group/subgroup/project', private: true }],
      instanceUrl: 'https://gitlab.example.test/',
    });

    await expect(
      authorizeGitLabProject({
        project: 'group/subgroup/project',
        projectInstanceUrl: 'https://gitlab.example.test',
        requesterUserId: 'user-1',
        threadRepository: 'other/thread',
      })
    ).resolves.toEqual({ allowed: true });
    expect(mockFetchGitLabRepositoriesForUser).toHaveBeenCalledWith('user-1', false);
    expect(mockFetchGitLabRepositoriesForUser).toHaveBeenCalledWith('user-1', false);
  });

  it('refuses a project the requester connection does not reach', async () => {
    mockFetchGitLabRepositoriesForUser.mockResolvedValue({
      integrationInstalled: true,
      repositories: [{ id: 1, name: 'project', fullName: 'group/other', private: true }],
      instanceUrl: 'https://gitlab.com',
    });

    const markdown = refusalMarkdown(
      await authorizeGitLabProject({
        project: 'group/project',
        projectInstanceUrl: 'https://gitlab.com',
        requesterUserId: 'user-1',
        threadRepository: 'group/project',
      })
    );

    expect(markdown).toContain('`group/project`');
    expect(markdown).toContain('GitLab connection in Kilo Code settings');
    expect(mockFetchGitLabRepositoriesForUser).toHaveBeenCalledTimes(1);
  });

  it('refuses a reachable project when the requester connection is on another instance', async () => {
    mockFetchGitLabRepositoriesForUser.mockResolvedValue({
      integrationInstalled: true,
      repositories: [{ id: 1, name: 'project', fullName: 'group/project', private: true }],
      instanceUrl: 'https://gitlab.example.test',
    });

    const markdown = refusalMarkdown(
      await authorizeGitLabProject({
        project: 'group/project',
        projectInstanceUrl: 'https://gitlab.com',
        requesterUserId: 'user-1',
      })
    );

    expect(markdown).toContain('`group/project`');
    expect(markdown).toContain('the GitLab instance your connection uses');
  });

  it('propagates a failed requester lookup', async () => {
    mockFetchGitLabRepositoriesForUser.mockRejectedValue(new Error('lookup failed'));

    await expect(
      authorizeGitLabProject({
        project: 'group/project',
        projectInstanceUrl: 'https://gitlab.com',
        requesterUserId: 'user-1',
      })
    ).rejects.toThrow('lookup failed');
  });

  it('refuses instead of throwing when the project instance URL is malformed', async () => {
    const markdown = refusalMarkdown(
      await authorizeGitLabProject({
        project: 'group/project',
        projectInstanceUrl: 'not a url',
        requesterUserId: 'user-1',
      })
    );

    expect(markdown).toContain('`group/project`');
  });
});
