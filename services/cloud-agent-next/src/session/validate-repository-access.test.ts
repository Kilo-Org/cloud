import { describe, expect, it, vi } from 'vitest';
import type { SessionRepositoryRequest } from './session-requests.js';
import {
  assertEnvironmentRepositoriesAccess,
  assertRepositoryAccessBeforeSessionCreation,
} from './validate-repository-access.js';

const repository = {
  type: 'bitbucket' as const,
  url: 'https://bitbucket.org/acme/repo.git',
  workspaceUuid: '123e4567-e89b-12d3-a456-426614174020',
  repositoryUuid: '123e4567-e89b-12d3-a456-426614174021',
};

describe('GitHub session creation preflight', () => {
  it('skips legacy GitHub repositories without an integration pin', async () => {
    const getTokenForRepo = vi.fn();

    await expect(
      assertRepositoryAccessBeforeSessionCreation({
        env: { GIT_TOKEN_SERVICE: { getTokenForRepo } } as never,
        userId: 'user-1',
        repository: { type: 'github', repo: 'acme/repo' },
      })
    ).resolves.toBeUndefined();
    expect(getTokenForRepo).not.toHaveBeenCalled();
  });

  it('preflights a pinned GitHub repository against the exact integration', async () => {
    const authorizeCloudAgentGitHubRepo = vi.fn().mockResolvedValue({
      success: true,
    });
    const orgId = '123e4567-e89b-12d3-a456-426614174030';
    const expectedIntegrationId = '123e4567-e89b-12d3-a456-426614174022';

    await expect(
      assertRepositoryAccessBeforeSessionCreation({
        env: { GIT_TOKEN_SERVICE: { authorizeCloudAgentGitHubRepo } } as never,
        userId: 'user-1',
        orgId,
        repository: {
          type: 'github',
          repo: 'acme/repo',
          githubIntegrationId: expectedIntegrationId,
        },
      })
    ).resolves.toBeUndefined();
    expect(authorizeCloudAgentGitHubRepo).toHaveBeenCalledWith({
      accessPurpose: 'workflow',
      githubRepo: 'acme/repo',
      userId: 'user-1',
      orgId,
      expectedIntegrationId,
    });
  });

  it('rejects an integration mismatch before session allocation', async () => {
    const authorizeCloudAgentGitHubRepo = vi.fn().mockResolvedValue({
      success: false,
      reason: 'integration_mismatch',
    });

    await expect(
      assertRepositoryAccessBeforeSessionCreation({
        env: { GIT_TOKEN_SERVICE: { authorizeCloudAgentGitHubRepo } } as never,
        userId: 'user-1',
        repository: {
          type: 'github',
          repo: 'acme/repo',
          githubIntegrationId: '123e4567-e89b-12d3-a456-426614174022',
        },
      })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'GitHub repository authorization failed (integration_mismatch)',
    });
  });
});

describe('Bitbucket session creation preflight', () => {
  it('validates organization sessions against the organization-owned integration', async () => {
    const getBitbucketToken = vi.fn().mockResolvedValue({ success: true, token: 'token' });
    const orgId = '123e4567-e89b-12d3-a456-426614174030';

    await expect(
      assertRepositoryAccessBeforeSessionCreation({
        env: { GIT_TOKEN_SERVICE: { getBitbucketToken } } as never,
        userId: 'user-1',
        orgId,
        repository,
      })
    ).resolves.toBeUndefined();
    expect(getBitbucketToken).toHaveBeenCalledWith({
      userId: 'user-1',
      orgId,
      workspaceUuid: repository.workspaceUuid,
      repositoryUuid: repository.repositoryUuid,
      repositoryUrl: repository.url,
    });
  });

  it('forwards an expected integration id when the repository carries one', async () => {
    const getBitbucketToken = vi.fn().mockResolvedValue({ success: true, token: 'token' });
    const orgId = '123e4567-e89b-12d3-a456-426614174030';
    const integrationId = '123e4567-e89b-12d3-a456-426614174022';

    await expect(
      assertRepositoryAccessBeforeSessionCreation({
        env: { GIT_TOKEN_SERVICE: { getBitbucketToken } } as never,
        userId: 'user-1',
        orgId,
        repository: { ...repository, bitbucketIntegrationId: integrationId },
      })
    ).resolves.toBeUndefined();
    expect(getBitbucketToken).toHaveBeenCalledWith({
      userId: 'user-1',
      orgId,
      expectedIntegrationId: integrationId,
      workspaceUuid: repository.workspaceUuid,
      repositoryUuid: repository.repositoryUuid,
      repositoryUrl: repository.url,
    });
  });

  it('rejects personal Bitbucket sessions before invoking the service binding', async () => {
    const getBitbucketToken = vi.fn().mockResolvedValue({ success: true, token: 'token' });

    await expect(
      assertRepositoryAccessBeforeSessionCreation({
        env: { GIT_TOKEN_SERVICE: { getBitbucketToken } } as never,
        userId: 'user-1',
        repository,
      })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Bitbucket repositories require an organization',
    });
    expect(getBitbucketToken).not.toHaveBeenCalled();
  });

  it('keeps insufficient workspace permissions distinguishable', async () => {
    const getBitbucketToken = vi.fn().mockResolvedValue({
      success: false,
      reason: 'insufficient_permissions',
    });

    await expect(
      assertRepositoryAccessBeforeSessionCreation({
        env: { GIT_TOKEN_SERVICE: { getBitbucketToken } } as never,
        userId: 'user-1',
        orgId: '123e4567-e89b-12d3-a456-426614174030',
        repository,
      })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Bitbucket repository authorization failed (insufficient_permissions)',
    });
  });

  it('reports temporary provider failures as service unavailable', async () => {
    const getBitbucketToken = vi.fn().mockResolvedValue({
      success: false,
      reason: 'temporarily_unavailable',
    });

    await expect(
      assertRepositoryAccessBeforeSessionCreation({
        env: { GIT_TOKEN_SERVICE: { getBitbucketToken } } as never,
        userId: 'user-1',
        orgId: '123e4567-e89b-12d3-a456-426614174030',
        repository,
      })
    ).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Bitbucket repository authorization failed (temporarily_unavailable)',
    });
  });

  it('reports an unavailable token-service binding as service unavailable', async () => {
    await expect(
      assertRepositoryAccessBeforeSessionCreation({
        env: {} as never,
        userId: 'user-1',
        orgId: '123e4567-e89b-12d3-a456-426614174030',
        repository,
      })
    ).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Bitbucket repository authorization failed (service_not_configured)',
    });
  });

  it('reports token-service RPC failures as service unavailable', async () => {
    const getBitbucketToken = vi.fn().mockRejectedValue(new Error('binding unavailable'));

    await expect(
      assertRepositoryAccessBeforeSessionCreation({
        env: { GIT_TOKEN_SERVICE: { getBitbucketToken } } as never,
        userId: 'user-1',
        orgId: '123e4567-e89b-12d3-a456-426614174030',
        repository,
      })
    ).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Bitbucket repository authorization failed (rpc_error)',
    });
  });
});

describe('environment repository preflight', () => {
  const orgId = '123e4567-e89b-12d3-a456-426614174030';
  const github = (repoFullName: string) => ({
    identity: { platform: 'github' as const, repoFullName },
    repoFullName,
    leaf: repoFullName.split('/')[1] ?? repoFullName,
  });
  const gitlab = {
    identity: { platform: 'gitlab' as const, cloneUrl: 'https://gitlab.com/group/sub/project.git' },
    repoFullName: 'group/sub/project',
    leaf: 'project',
  };
  const bitbucket = {
    identity: {
      platform: 'bitbucket' as const,
      workspaceUuid: repository.workspaceUuid,
      repositoryUuid: repository.repositoryUuid,
    },
    repoFullName: 'acme/repo',
    leaf: 'repo',
  };
  const integrationId = '123e4567-e89b-12d3-a456-426614174022';
  const pinnedLaunch = {
    type: 'github' as const,
    repo: 'acme/launch',
    githubIntegrationId: integrationId,
  };
  const unpinnedLaunch = { type: 'github' as const, repo: 'acme/launch' };
  const services = () => ({
    authorizeCloudAgentGitHubRepo: vi.fn().mockResolvedValue({ success: true }),
    getGitLabToken: vi.fn().mockResolvedValue({
      success: true,
      token: 'token',
      instanceUrl: 'https://gitlab.com',
      glabIsOAuth2: false,
    }),
    getBitbucketToken: vi.fn().mockResolvedValue({ success: true, token: 'token' }),
  });
  const check = (
    binding: ReturnType<typeof services>,
    environment: Parameters<typeof assertEnvironmentRepositoriesAccess>[0]['environment'],
    launch: SessionRepositoryRequest = pinnedLaunch
  ) =>
    assertEnvironmentRepositoriesAccess({
      env: { GIT_TOKEN_SERVICE: binding } as never,
      userId: 'user-1',
      orgId,
      repository: launch,
      environment,
    });

  it('authorizes every member of each platform and skips a launch repository that the launch check covers', async () => {
    const binding = services();

    await expect(
      check(binding, {
        repositories: [github('acme/launch'), github('acme/api'), gitlab, bitbucket],
      })
    ).resolves.toBeUndefined();

    // The pinned launch repository is not checked again. A member gets no pin, because it
    // may belong to another installation than the launch repository.
    expect(binding.authorizeCloudAgentGitHubRepo).toHaveBeenCalledTimes(1);
    expect(binding.authorizeCloudAgentGitHubRepo).toHaveBeenCalledWith({
      accessPurpose: 'workflow',
      githubRepo: 'acme/api',
      userId: 'user-1',
      orgId,
    });
    expect(binding.getGitLabToken).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        orgId,
        repositoryUrl: 'https://gitlab.com/group/sub/project.git',
      })
    );
    expect(binding.getBitbucketToken).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId,
        workspaceUuid: repository.workspaceUuid,
        repositoryUuid: repository.repositoryUuid,
        repositoryUrl: 'https://bitbucket.org/acme/repo.git',
      })
    );
  });

  it('authorizes a GitHub member with the purpose of the launch repository and no pin', async () => {
    const binding = services();

    await check(
      binding,
      { repositories: [github('acme/launch'), github('acme/api')] },
      {
        ...pinnedLaunch,
        githubAccessPurpose: 'agent',
      }
    );

    expect(binding.authorizeCloudAgentGitHubRepo).toHaveBeenCalledWith({
      accessPurpose: 'agent',
      githubRepo: 'acme/api',
      userId: 'user-1',
      orgId,
    });
  });

  it('authorizes a GitHub member of a GitLab launch with the default access and no pin', async () => {
    const binding = services();

    await check(
      binding,
      { repositories: [gitlab, github('acme/api')] },
      { type: 'gitlab', url: 'https://gitlab.com/group/sub/project.git' }
    );

    expect(binding.authorizeCloudAgentGitHubRepo).toHaveBeenCalledWith({
      accessPurpose: 'workflow',
      githubRepo: 'acme/api',
      userId: 'user-1',
      orgId,
    });
  });

  it('authorizes an unpinned GitHub launch repository as a member, and names it when it fails', async () => {
    const binding = services();
    binding.authorizeCloudAgentGitHubRepo.mockImplementation(
      async ({ githubRepo }: { githubRepo: string }) =>
        githubRepo === 'acme/launch'
          ? { success: false, reason: 'no_installation_found' }
          : { success: true }
    );

    await expect(
      check(binding, { repositories: [github('acme/launch'), github('acme/api')] }, unpinnedLaunch)
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message:
        'Repository acme/launch: GitHub repository authorization failed (no_installation_found)',
    });
    expect(binding.authorizeCloudAgentGitHubRepo).toHaveBeenCalledWith(
      expect.objectContaining({ githubRepo: 'acme/launch' })
    );
  });

  it('authorizes a GitLab launch repository as a member, since no launch check covers it', async () => {
    const binding = services();
    binding.getGitLabToken.mockResolvedValue({ success: false, reason: 'no_token' });

    await expect(
      check(
        binding,
        { repositories: [gitlab, github('acme/api')] },
        {
          type: 'gitlab',
          url: 'https://gitlab.com/group/sub/project.git',
        }
      )
    ).rejects.toMatchObject({
      message: 'Repository group/sub/project: GitLab repository authorization failed (no_token)',
    });
  });

  it('fails the start when one member is not authorized, and names that repository', async () => {
    const binding = services();
    binding.authorizeCloudAgentGitHubRepo.mockImplementation(
      async ({ githubRepo }: { githubRepo: string }) =>
        githubRepo === 'acme/denied'
          ? { success: false, reason: 'repository_not_installed' }
          : { success: true }
    );

    await expect(
      check(binding, { repositories: [github('acme/api'), github('acme/denied'), gitlab] })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message:
        'Repository acme/denied: GitHub repository authorization failed (repository_not_installed)',
    });
  });

  it('names the first failing member in environment order', async () => {
    const binding = services();
    binding.authorizeCloudAgentGitHubRepo.mockResolvedValue({
      success: false,
      reason: 'no_installation_found',
    });
    binding.getGitLabToken.mockResolvedValue({ success: false, reason: 'no_token' });

    await expect(
      check(binding, { repositories: [gitlab, github('acme/api')] })
    ).rejects.toMatchObject({
      message: 'Repository group/sub/project: GitLab repository authorization failed (no_token)',
    });
  });

  it('keeps an unavailable service distinct from a denial', async () => {
    const binding = services();
    binding.authorizeCloudAgentGitHubRepo.mockRejectedValue(new Error('unreachable'));

    await expect(check(binding, { repositories: [github('acme/api')] })).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: expect.stringContaining('acme/api'),
    });
  });

  it('requires an organization for a Bitbucket member, and names it', async () => {
    const binding = services();

    await expect(
      assertEnvironmentRepositoriesAccess({
        env: { GIT_TOKEN_SERVICE: binding } as never,
        userId: 'user-1',
        repository: pinnedLaunch,
        environment: { repositories: [bitbucket] },
      })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Repository acme/repo: Bitbucket repositories require an organization',
    });
    expect(binding.getBitbucketToken).not.toHaveBeenCalled();
  });

  it('checks nothing for a V1 environment or no environment', async () => {
    const binding = services();

    await expect(check(binding, {})).resolves.toBeUndefined();
    await expect(check(binding, undefined)).resolves.toBeUndefined();
    expect(binding.authorizeCloudAgentGitHubRepo).not.toHaveBeenCalled();
    expect(binding.getGitLabToken).not.toHaveBeenCalled();
    expect(binding.getBitbucketToken).not.toHaveBeenCalled();
  });
});
