import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { authorizeGitLabProject as AuthorizeGitLabProject } from './gitlab-project-permission';
import type { GitLabProjectAuthorization } from './gitlab-project-permission';

jest.mock('@/lib/cloud-agent/gitlab-integration-helpers', () => ({
  getGitLabInstanceUrlForUser: jest.fn(),
  getGitLabTokenForUser: jest.fn(),
}));

jest.mock('@/lib/integrations/platforms/gitlab/adapter', () => ({
  fetchGitLabProjectAccessLevel: jest.fn(),
  GITLAB_ACCESS_LEVELS: { GUEST: 10, REPORTER: 20, DEVELOPER: 30, MAINTAINER: 40, OWNER: 50 },
}));

let mockGetGitLabInstanceUrlForUser: jest.MockedFunction<(userId: string) => Promise<string>>;
let mockGetGitLabTokenForUser: jest.MockedFunction<(userId: string) => Promise<string | undefined>>;
let mockFetchGitLabProjectAccessLevel: jest.MockedFunction<
  (token: string, projectPath: string, instanceUrl?: string) => Promise<number | null>
>;
let authorizeGitLabProject: typeof AuthorizeGitLabProject;

beforeAll(async () => {
  const helpers = await import('@/lib/cloud-agent/gitlab-integration-helpers');
  mockGetGitLabInstanceUrlForUser = jest.mocked(helpers.getGitLabInstanceUrlForUser);
  mockGetGitLabTokenForUser = jest.mocked(helpers.getGitLabTokenForUser);
  const adapter = await import('@/lib/integrations/platforms/gitlab/adapter');
  mockFetchGitLabProjectAccessLevel = jest.mocked(adapter.fetchGitLabProjectAccessLevel);
  authorizeGitLabProject = (await import('./gitlab-project-permission')).authorizeGitLabProject;
});

function refusalMarkdown(result: GitLabProjectAuthorization): string {
  if (result.allowed) throw new Error('Expected the project to be refused');
  return result.markdown;
}

describe('authorizeGitLabProject', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetGitLabInstanceUrlForUser.mockResolvedValue('https://gitlab.com');
    mockGetGitLabTokenForUser.mockResolvedValue('user-token');
    mockFetchGitLabProjectAccessLevel.mockResolvedValue(30);
  });

  it('allows the conversation project when the run has no requesting account', async () => {
    await expect(
      authorizeGitLabProject({
        project: 'group/project',
        projectInstanceUrl: 'https://gitlab.com',
        threadRepository: ' Group/Project ',
      })
    ).resolves.toEqual({ allowed: true });
    expect(mockGetGitLabTokenForUser).not.toHaveBeenCalled();
    expect(mockFetchGitLabProjectAccessLevel).not.toHaveBeenCalled();
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
    expect(mockFetchGitLabProjectAccessLevel).not.toHaveBeenCalled();
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

  it('allows a project the requester holds Developer access to on the same instance', async () => {
    mockGetGitLabInstanceUrlForUser.mockResolvedValue('https://gitlab.example.test/');
    mockFetchGitLabProjectAccessLevel.mockResolvedValue(30);

    await expect(
      authorizeGitLabProject({
        project: 'group/subgroup/project',
        projectInstanceUrl: 'https://gitlab.example.test',
        requesterUserId: 'user-1',
        threadRepository: 'other/thread',
      })
    ).resolves.toEqual({ allowed: true });
    expect(mockFetchGitLabProjectAccessLevel).toHaveBeenCalledWith(
      'user-token',
      'group/subgroup/project',
      'https://gitlab.example.test/'
    );
  });

  it('allows a project the requester holds Maintainer access to', async () => {
    mockFetchGitLabProjectAccessLevel.mockResolvedValue(40);

    await expect(
      authorizeGitLabProject({
        project: 'group/project',
        projectInstanceUrl: 'https://gitlab.com',
        requesterUserId: 'user-1',
      })
    ).resolves.toEqual({ allowed: true });
  });

  it('refuses a project the requester only holds Reporter access to with the write-access copy', async () => {
    mockFetchGitLabProjectAccessLevel.mockResolvedValue(20);

    const markdown = refusalMarkdown(
      await authorizeGitLabProject({
        project: 'group/project',
        projectInstanceUrl: 'https://gitlab.com',
        requesterUserId: 'user-1',
        threadRepository: 'group/project',
      })
    );

    expect(markdown).toContain('`group/project`');
    expect(markdown).toContain('write access');
    expect(markdown).toContain('Developer access');
  });

  it('refuses a project whose access level cannot be read', async () => {
    mockFetchGitLabProjectAccessLevel.mockResolvedValue(null);

    const markdown = refusalMarkdown(
      await authorizeGitLabProject({
        project: 'group/project',
        projectInstanceUrl: 'https://gitlab.com',
        requesterUserId: 'user-1',
        threadRepository: 'group/project',
      })
    );

    expect(markdown).toContain('write access');
  });

  it('refuses a project when the requester connection is on another instance without reading its access level', async () => {
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
    expect(mockFetchGitLabProjectAccessLevel).not.toHaveBeenCalled();
  });

  it('refuses a project when the requester connection differs only by base path', async () => {
    mockGetGitLabInstanceUrlForUser.mockResolvedValue('https://gitlab.example.test/team-b');

    const markdown = refusalMarkdown(
      await authorizeGitLabProject({
        project: 'group/project',
        projectInstanceUrl: 'https://gitlab.example.test/team-a',
        requesterUserId: 'user-1',
      })
    );

    expect(markdown).toContain('the GitLab instance your connection uses');
    expect(mockFetchGitLabProjectAccessLevel).not.toHaveBeenCalled();
  });

  it('refuses a project when the requester has no GitLab token', async () => {
    mockGetGitLabTokenForUser.mockResolvedValue(undefined);

    const markdown = refusalMarkdown(
      await authorizeGitLabProject({
        project: 'group/project',
        projectInstanceUrl: 'https://gitlab.com',
        requesterUserId: 'user-1',
        threadRepository: 'group/project',
      })
    );

    expect(markdown).toContain('GitLab connection in Kilo Code settings');
    expect(mockFetchGitLabProjectAccessLevel).not.toHaveBeenCalled();
  });

  it('propagates an access level lookup error', async () => {
    mockFetchGitLabProjectAccessLevel.mockRejectedValue(new Error('lookup failed'));

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
