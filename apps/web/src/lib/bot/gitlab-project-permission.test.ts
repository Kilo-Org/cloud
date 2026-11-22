import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { TRPCError } from '@trpc/server';
import type { PlatformIntegration } from '@kilocode/db/schema';
import { PLATFORM } from '@/lib/integrations/core/constants';
import type { authorizeGitLabProject as AuthorizeGitLabProject } from './gitlab-project-permission';
import type { GitLabProjectAuthorization } from './gitlab-project-permission';
import type { getIntegrationForOwner as GetIntegrationForOwner } from '@/lib/integrations/db/platform-integrations';
import type { isPlatformIntegrationHealthy as IsPlatformIntegrationHealthy } from '@/lib/integrations/core/health';
import type { getValidGitLabToken as GetValidGitLabToken } from '@/lib/integrations/gitlab-service';

jest.mock('@/lib/integrations/db/platform-integrations', () => ({
  getIntegrationForOwner: jest.fn(),
}));

jest.mock('@/lib/integrations/core/health', () => ({
  isPlatformIntegrationHealthy: jest.fn(),
}));

jest.mock('@/lib/integrations/gitlab-service', () => ({
  getValidGitLabToken: jest.fn(),
}));

jest.mock('@/lib/integrations/platforms/gitlab/adapter', () => ({
  fetchGitLabProjectAccessLevel: jest.fn(),
  GITLAB_ACCESS_LEVELS: { GUEST: 10, REPORTER: 20, DEVELOPER: 30, MAINTAINER: 40, OWNER: 50 },
  // The credential refusal classification checks this class, so the mock keeps
  // the real one instead of an undefined binding.
  GitLabAuthenticationError: jest.requireActual<{
    GitLabAuthenticationError: unknown;
  }>('@/lib/integrations/platforms/gitlab/adapter').GitLabAuthenticationError,
}));

// The production lookup always answers a row or null; the declared type omits the
// null, so the test mock names it explicitly to model "no connection".
let mockGetIntegrationForOwner: jest.MockedFunction<
  (...args: Parameters<typeof GetIntegrationForOwner>) => Promise<PlatformIntegration | null>
>;
let mockIsPlatformIntegrationHealthy: jest.MockedFunction<typeof IsPlatformIntegrationHealthy>;
let mockGetValidGitLabToken: jest.MockedFunction<typeof GetValidGitLabToken>;
let mockFetchGitLabProjectAccessLevel: jest.MockedFunction<
  (token: string, projectPath: string, instanceUrl?: string) => Promise<number | null>
>;
let authorizeGitLabProject: typeof AuthorizeGitLabProject;

beforeAll(async () => {
  const platformIntegrations = await import('@/lib/integrations/db/platform-integrations');
  mockGetIntegrationForOwner = jest.mocked(platformIntegrations.getIntegrationForOwner);
  const health = await import('@/lib/integrations/core/health');
  mockIsPlatformIntegrationHealthy = jest.mocked(health.isPlatformIntegrationHealthy);
  const gitlabService = await import('@/lib/integrations/gitlab-service');
  mockGetValidGitLabToken = jest.mocked(gitlabService.getValidGitLabToken);
  const adapter = await import('@/lib/integrations/platforms/gitlab/adapter');
  mockFetchGitLabProjectAccessLevel = jest.mocked(adapter.fetchGitLabProjectAccessLevel);
  authorizeGitLabProject = (await import('./gitlab-project-permission')).authorizeGitLabProject;
});

/** A GitLab connection row whose stored instance is `instanceUrl`. */
function gitlabConnection(instanceUrl: string | null = 'https://gitlab.com'): PlatformIntegration {
  return {
    id: 'gitlab-integration-1',
    metadata: instanceUrl === null ? null : { gitlab_instance_url: instanceUrl },
  } as PlatformIntegration;
}

function refusalMarkdown(result: GitLabProjectAuthorization): string {
  if (result.allowed) throw new Error('Expected the project to be refused');
  return result.markdown;
}

describe('authorizeGitLabProject', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetIntegrationForOwner.mockResolvedValue(gitlabConnection());
    mockIsPlatformIntegrationHealthy.mockReturnValue(true);
    mockGetValidGitLabToken.mockResolvedValue('requester-token');
    mockFetchGitLabProjectAccessLevel.mockResolvedValue(30);
  });

  it('allows a personally owned connection project without reading an access level', async () => {
    mockFetchGitLabProjectAccessLevel.mockResolvedValue(20);

    await expect(
      authorizeGitLabProject({
        project: 'group/project',
        projectInstanceUrl: 'https://gitlab.com',
        organizationOwned: false,
        requesterUserId: 'user-1',
      })
    ).resolves.toEqual({ allowed: true });
    expect(mockGetIntegrationForOwner).not.toHaveBeenCalled();
    expect(mockFetchGitLabProjectAccessLevel).not.toHaveBeenCalled();
  });

  it('refuses an organization project when the run has no requesting account', async () => {
    const markdown = refusalMarkdown(
      await authorizeGitLabProject({
        project: 'group/project',
        projectInstanceUrl: 'https://gitlab.com',
        organizationOwned: true,
      })
    );

    expect(markdown).toContain('`group/project`');
    expect(markdown).toContain('GitLab connection in Kilo Code settings');
    expect(mockGetIntegrationForOwner).not.toHaveBeenCalled();
    expect(mockGetValidGitLabToken).not.toHaveBeenCalled();
    expect(mockFetchGitLabProjectAccessLevel).not.toHaveBeenCalled();
  });

  it('allows a project the requester holds Developer access to on the same instance', async () => {
    mockGetIntegrationForOwner.mockResolvedValue(gitlabConnection('https://gitlab.example.test/'));
    mockFetchGitLabProjectAccessLevel.mockResolvedValue(30);

    await expect(
      authorizeGitLabProject({
        project: 'group/subgroup/project',
        projectInstanceUrl: 'https://gitlab.example.test',
        organizationOwned: true,
        requesterUserId: 'user-1',
      })
    ).resolves.toEqual({ allowed: true });
    expect(mockGetIntegrationForOwner).toHaveBeenCalledWith(
      { type: 'user', id: 'user-1' },
      PLATFORM.GITLAB
    );
    expect(mockGetValidGitLabToken).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'gitlab-integration-1' }),
      { userId: 'user-1' }
    );
    expect(mockFetchGitLabProjectAccessLevel).toHaveBeenCalledWith(
      'requester-token',
      'group/subgroup/project',
      'https://gitlab.example.test'
    );
  });

  it('allows a project the requester holds Maintainer access to', async () => {
    mockFetchGitLabProjectAccessLevel.mockResolvedValue(40);

    await expect(
      authorizeGitLabProject({
        project: 'group/project',
        projectInstanceUrl: 'https://gitlab.com',
        organizationOwned: true,
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
        organizationOwned: true,
        requesterUserId: 'user-1',
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
        organizationOwned: true,
        requesterUserId: 'user-1',
      })
    );

    expect(markdown).toContain('write access');
  });

  it('refuses a project when the requester connection is on another instance without reading its access level', async () => {
    mockGetIntegrationForOwner.mockResolvedValue(gitlabConnection('https://gitlab.example.test'));

    const markdown = refusalMarkdown(
      await authorizeGitLabProject({
        project: 'group/project',
        projectInstanceUrl: 'https://gitlab.com',
        organizationOwned: true,
        requesterUserId: 'user-1',
      })
    );

    expect(markdown).toContain('`group/project`');
    expect(markdown).toContain('the GitLab instance your connection uses');
    expect(mockFetchGitLabProjectAccessLevel).not.toHaveBeenCalled();
  });

  it('refuses a project when the requester connection differs only by base path', async () => {
    mockGetIntegrationForOwner.mockResolvedValue(
      gitlabConnection('https://gitlab.example.test/team-b')
    );

    const markdown = refusalMarkdown(
      await authorizeGitLabProject({
        project: 'group/project',
        projectInstanceUrl: 'https://gitlab.example.test/team-a',
        organizationOwned: true,
        requesterUserId: 'user-1',
      })
    );

    expect(markdown).toContain('the GitLab instance your connection uses');
    expect(mockFetchGitLabProjectAccessLevel).not.toHaveBeenCalled();
  });

  it('refuses with the access answer when the credential is definitively unavailable', async () => {
    mockGetValidGitLabToken.mockRejectedValue(
      new TRPCError({ code: 'NOT_FOUND', message: 'GitLab integration not found' })
    );

    const markdown = refusalMarkdown(
      await authorizeGitLabProject({
        project: 'group/project',
        projectInstanceUrl: 'https://gitlab.com',
        organizationOwned: true,
        requesterUserId: 'user-1',
      })
    );

    expect(markdown).toContain('GitLab connection in Kilo Code settings');
    expect(mockFetchGitLabProjectAccessLevel).not.toHaveBeenCalled();
  });

  it('propagates a temporarily unavailable credential so the caller can offer a retry', async () => {
    const failure = new TRPCError({
      code: 'SERVICE_UNAVAILABLE',
      message: 'GitLab credentials are temporarily unavailable',
    });
    mockGetValidGitLabToken.mockRejectedValue(failure);

    await expect(
      authorizeGitLabProject({
        project: 'group/project',
        projectInstanceUrl: 'https://gitlab.com',
        organizationOwned: true,
        requesterUserId: 'user-1',
      })
    ).rejects.toBe(failure);
    expect(mockFetchGitLabProjectAccessLevel).not.toHaveBeenCalled();
  });

  it('propagates a rejected request instead of reporting it as this access', async () => {
    const failure = new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Invalid GitLab credential request',
    });
    mockGetValidGitLabToken.mockRejectedValue(failure);

    await expect(
      authorizeGitLabProject({
        project: 'group/project',
        projectInstanceUrl: 'https://gitlab.com',
        organizationOwned: true,
        requesterUserId: 'user-1',
      })
    ).rejects.toBe(failure);
    expect(mockFetchGitLabProjectAccessLevel).not.toHaveBeenCalled();
  });

  it('propagates a connection that changed while its credential resolved', async () => {
    const failure = new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'GitLab integration changed while resolving credentials',
    });
    mockGetValidGitLabToken.mockRejectedValue(failure);

    await expect(
      authorizeGitLabProject({
        project: 'group/project',
        projectInstanceUrl: 'https://gitlab.com',
        organizationOwned: true,
        requesterUserId: 'user-1',
      })
    ).rejects.toBe(failure);
    expect(mockFetchGitLabProjectAccessLevel).not.toHaveBeenCalled();
  });

  it('propagates an untyped credential failure instead of reporting it as this access', async () => {
    const failure = new Error('socket hang up');
    mockGetValidGitLabToken.mockRejectedValue(failure);

    await expect(
      authorizeGitLabProject({
        project: 'group/project',
        projectInstanceUrl: 'https://gitlab.com',
        organizationOwned: true,
        requesterUserId: 'user-1',
      })
    ).rejects.toBe(failure);
    expect(mockFetchGitLabProjectAccessLevel).not.toHaveBeenCalled();
  });

  it('refuses a project when the requester has no GitLab connection', async () => {
    mockGetIntegrationForOwner.mockResolvedValue(null);

    const markdown = refusalMarkdown(
      await authorizeGitLabProject({
        project: 'group/project',
        projectInstanceUrl: 'https://gitlab.com',
        organizationOwned: true,
        requesterUserId: 'user-1',
      })
    );

    expect(markdown).toContain('GitLab connection in Kilo Code settings');
    expect(mockGetValidGitLabToken).not.toHaveBeenCalled();
    expect(mockFetchGitLabProjectAccessLevel).not.toHaveBeenCalled();
  });

  it('refuses a project when the requester connection is not healthy', async () => {
    mockIsPlatformIntegrationHealthy.mockReturnValue(false);

    const markdown = refusalMarkdown(
      await authorizeGitLabProject({
        project: 'group/project',
        projectInstanceUrl: 'https://gitlab.com',
        organizationOwned: true,
        requesterUserId: 'user-1',
      })
    );

    expect(markdown).toContain('GitLab connection in Kilo Code settings');
    expect(mockGetValidGitLabToken).not.toHaveBeenCalled();
    expect(mockFetchGitLabProjectAccessLevel).not.toHaveBeenCalled();
  });

  it('refuses a project when the requester credential is refused', async () => {
    mockGetValidGitLabToken.mockRejectedValue(
      new TRPCError({ code: 'UNAUTHORIZED', message: 'GitLab integration must be reconnected' })
    );

    const markdown = refusalMarkdown(
      await authorizeGitLabProject({
        project: 'group/project',
        projectInstanceUrl: 'https://gitlab.com',
        organizationOwned: true,
        requesterUserId: 'user-1',
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
        organizationOwned: true,
        requesterUserId: 'user-1',
      })
    ).rejects.toThrow('lookup failed');
  });

  it('refuses instead of throwing when the project instance URL is malformed', async () => {
    const markdown = refusalMarkdown(
      await authorizeGitLabProject({
        project: 'group/project',
        projectInstanceUrl: 'not a url',
        organizationOwned: true,
        requesterUserId: 'user-1',
      })
    );

    expect(markdown).toContain('`group/project`');
  });
});
