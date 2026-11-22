import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { authorizeGitLabProject as AuthorizeGitLabProject } from './gitlab-project-permission';
import type { GitLabProjectAuthorization } from './gitlab-project-permission';

jest.mock('@/lib/cloud-agent/gitlab-integration-helpers', () => ({
  validateGitLabRepoAccessForUser: jest.fn(),
  getGitLabInstanceUrlForUser: jest.fn(),
}));

let mockValidateGitLabRepoAccessForUser: jest.MockedFunction<
  (userId: string, projectPath: string) => Promise<boolean>
>;
let mockGetGitLabInstanceUrlForUser: jest.MockedFunction<(userId: string) => Promise<string>>;
let authorizeGitLabProject: typeof AuthorizeGitLabProject;

function refusalMarkdown(result: GitLabProjectAuthorization): string {
  if (result.allowed) throw new Error('Expected the project to be refused');
  return result.markdown;
}

beforeAll(async () => {
  const gitlab = await import('@/lib/cloud-agent/gitlab-integration-helpers');
  mockValidateGitLabRepoAccessForUser = jest.mocked(gitlab.validateGitLabRepoAccessForUser);
  mockGetGitLabInstanceUrlForUser = jest.mocked(gitlab.getGitLabInstanceUrlForUser);
  authorizeGitLabProject = (await import('./gitlab-project-permission')).authorizeGitLabProject;
});

describe('authorizeGitLabProject', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockValidateGitLabRepoAccessForUser.mockResolvedValue(true);
    mockGetGitLabInstanceUrlForUser.mockResolvedValue('https://gitlab.com');
  });

  it('allows the conversation project when the run has no requesting account', async () => {
    await expect(
      authorizeGitLabProject({
        project: 'group/project',
        projectInstanceUrl: 'https://gitlab.com',
        threadRepository: ' Group/Project ',
      })
    ).resolves.toEqual({ allowed: true });
    expect(mockValidateGitLabRepoAccessForUser).not.toHaveBeenCalled();
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
    expect(mockValidateGitLabRepoAccessForUser).not.toHaveBeenCalled();
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
    mockGetGitLabInstanceUrlForUser.mockResolvedValue('https://gitlab.example.test/');

    await expect(
      authorizeGitLabProject({
        project: 'group/subgroup/project',
        projectInstanceUrl: 'https://gitlab.example.test',
        requesterUserId: 'user-1',
        threadRepository: 'other/thread',
      })
    ).resolves.toEqual({ allowed: true });
    expect(mockValidateGitLabRepoAccessForUser).toHaveBeenCalledWith(
      'user-1',
      'group/subgroup/project'
    );
    expect(mockGetGitLabInstanceUrlForUser).toHaveBeenCalledWith('user-1');
  });

  it('refuses a project the requester connection does not reach', async () => {
    mockValidateGitLabRepoAccessForUser.mockResolvedValue(false);

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
    expect(mockGetGitLabInstanceUrlForUser).not.toHaveBeenCalled();
  });

  it('refuses a reachable project when the requester connection is on another instance', async () => {
    mockGetGitLabInstanceUrlForUser.mockResolvedValue('https://gitlab.example.test');

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
    mockValidateGitLabRepoAccessForUser.mockRejectedValue(new Error('lookup failed'));

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
