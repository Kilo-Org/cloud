import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  WorkerEntrypoint: class WorkerEntrypoint {
    constructor(_ctx: unknown, _env: unknown) {}
  },
}));

import { GitHubTokenService } from './github-token-service.js';
import type { AuthorizedGitLabIntegration } from './gitlab-lookup-service.js';
import { resolveGitLabRuntimeToken } from './gitlab-runtime-token-resolver.js';
import { GitTokenRPCEntrypoint } from './index.js';
import { InstallationLookupService } from './installation-lookup-service.js';

const integration: AuthorizedGitLabIntegration = {
  integrationId: '123e4567-e89b-12d3-a456-426614174011',
  metadata: {
    access_token: 'human-integration-token',
    gitlab_instance_url: 'https://gitlab.example.com/gitlab',
    project_tokens: { '42': { token: 'project-bot-token' } },
  },
};

function createDependencies(options: { integrations?: AuthorizedGitLabIntegration[] } = {}) {
  const lookupService = {
    findGitLabIntegration: vi.fn().mockResolvedValue({ success: true, ...integration }),
    findAuthorizedGitLabIntegrations: vi.fn().mockResolvedValue({
      success: true,
      integrations: options.integrations ?? [integration],
    }),
  };
  const tokenService = {
    getToken: vi.fn().mockResolvedValue({
      success: true,
      token: 'human-integration-token',
      instanceUrl: 'https://gitlab.example.com/gitlab',
    }),
  };
  return { lookupService, tokenService };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('resolveGitLabRuntimeToken', () => {
  it('preserves ordinary integration token behavior and OAuth CLI mode', async () => {
    const dependencies = createDependencies();

    await expect(resolveGitLabRuntimeToken({ userId: 'user_123' }, dependencies)).resolves.toEqual({
      success: true,
      token: 'human-integration-token',
      instanceUrl: 'https://gitlab.example.com/gitlab',
      glabIsOAuth2: true,
    });
    expect(dependencies.lookupService.findGitLabIntegration).toHaveBeenCalledWith({
      userId: 'user_123',
    });
    expect(dependencies.lookupService.findAuthorizedGitLabIntegrations).not.toHaveBeenCalled();
    expect(dependencies.tokenService.getToken).toHaveBeenCalledOnce();
  });

  it('returns the stored project token for an exact review-origin repository match', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ id: 42 }));
    vi.stubGlobal('fetch', fetchMock);
    const dependencies = createDependencies();

    await expect(
      resolveGitLabRuntimeToken(
        {
          userId: 'user_123',
          repositoryUrl: 'https://gitlab.example.com/gitlab/team/repo.git',
          createdOnPlatform: 'code-review',
        },
        dependencies
      )
    ).resolves.toEqual({
      success: true,
      token: 'project-bot-token',
      instanceUrl: 'https://gitlab.example.com/gitlab',
      glabIsOAuth2: false,
    });
    expect(dependencies.tokenService.getToken).toHaveBeenCalledWith(
      integration.integrationId,
      integration.metadata
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'https://gitlab.example.com/gitlab/api/v4/projects/team%2Frepo',
      { headers: { Authorization: 'Bearer human-integration-token' } }
    );
  });

  it('fails closed when review-origin repository context is missing or malformed', async () => {
    const dependencies = createDependencies();

    await expect(
      resolveGitLabRuntimeToken(
        { userId: 'user_123', createdOnPlatform: 'code-review' },
        dependencies
      )
    ).resolves.toEqual({ success: false, reason: 'repository_url_required' });
    await expect(
      resolveGitLabRuntimeToken(
        {
          userId: 'user_123',
          repositoryUrl: 'not-a-url',
          createdOnPlatform: 'code-review',
        },
        dependencies
      )
    ).resolves.toEqual({ success: false, reason: 'invalid_repository_url' });
    expect(dependencies.lookupService.findAuthorizedGitLabIntegrations).not.toHaveBeenCalled();
    expect(dependencies.tokenService.getToken).not.toHaveBeenCalled();
  });

  it('fails closed for unmatched authorized instance candidates', async () => {
    const unmatched = createDependencies({
      integrations: [
        {
          ...integration,
          metadata: { ...integration.metadata, gitlab_instance_url: 'https://other.example.com' },
        },
      ],
    });
    await expect(
      resolveGitLabRuntimeToken(
        {
          userId: 'user_123',
          repositoryUrl: 'https://gitlab.example.com/gitlab/team/repo.git',
          createdOnPlatform: 'code-review',
        },
        unmatched
      )
    ).resolves.toEqual({ success: false, reason: 'no_matching_integration' });
    expect(unmatched.tokenService.getToken).not.toHaveBeenCalled();
  });

  it('returns the unique project token when multiple integrations match but only one owns the project', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(Response.json({ id: 42 })));
    vi.stubGlobal('fetch', fetchMock);
    const integrationWithoutProjectToken: AuthorizedGitLabIntegration = {
      ...integration,
      integrationId: 'another-integration',
      metadata: {
        ...integration.metadata,
        project_tokens: { '99': { token: 'other-project-token' } },
      },
    };
    const dependencies = createDependencies({
      integrations: [integrationWithoutProjectToken, integration],
    });

    await expect(
      resolveGitLabRuntimeToken(
        {
          userId: 'user_123',
          repositoryUrl: 'https://gitlab.example.com/gitlab/team/repo.git',
          createdOnPlatform: 'code-review',
        },
        dependencies
      )
    ).resolves.toEqual({
      success: true,
      token: 'project-bot-token',
      instanceUrl: 'https://gitlab.example.com/gitlab',
      glabIsOAuth2: false,
    });
    expect(dependencies.tokenService.getToken).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('uses a matched project token when another matching integration token fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => Promise.resolve(Response.json({ id: 42 })))
    );
    const failingIntegration: AuthorizedGitLabIntegration = {
      ...integration,
      integrationId: 'failing-integration',
      metadata: {
        ...integration.metadata,
        project_tokens: { '42': { token: 'failing-project-token' } },
      },
    };
    const dependencies = createDependencies({
      integrations: [failingIntegration, integration],
    });
    dependencies.tokenService.getToken.mockImplementation(integrationId =>
      integrationId === failingIntegration.integrationId
        ? Promise.resolve({ success: false, reason: 'token_expired_no_refresh' })
        : Promise.resolve({
            success: true,
            token: 'human-integration-token',
            instanceUrl: 'https://gitlab.example.com/gitlab',
          })
    );

    await expect(
      resolveGitLabRuntimeToken(
        {
          userId: 'user_123',
          repositoryUrl: 'https://gitlab.example.com/gitlab/team/repo.git',
          createdOnPlatform: 'code-review',
        },
        dependencies
      )
    ).resolves.toEqual({
      success: true,
      token: 'project-bot-token',
      instanceUrl: 'https://gitlab.example.com/gitlab',
      glabIsOAuth2: false,
    });
  });

  it('skips project lookup for matching integrations without stored project tokens', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(Response.json({ id: 42 })));
    vi.stubGlobal('fetch', fetchMock);
    const integrationWithoutProjectTokens: AuthorizedGitLabIntegration = {
      ...integration,
      integrationId: 'another-integration',
      metadata: {
        access_token: integration.metadata.access_token,
        gitlab_instance_url: integration.metadata.gitlab_instance_url,
      },
    };
    const dependencies = createDependencies({
      integrations: [integrationWithoutProjectTokens, integration],
    });

    await expect(
      resolveGitLabRuntimeToken(
        {
          userId: 'user_123',
          repositoryUrl: 'https://gitlab.example.com/gitlab/team/repo.git',
          createdOnPlatform: 'code-review',
        },
        dependencies
      )
    ).resolves.toEqual({
      success: true,
      token: 'project-bot-token',
      instanceUrl: 'https://gitlab.example.com/gitlab',
      glabIsOAuth2: false,
    });
    expect(dependencies.tokenService.getToken).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('fails closed when multiple matching integrations own the resolved project token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => Promise.resolve(Response.json({ id: 42 })))
    );
    const ambiguous = createDependencies({
      integrations: [
        integration,
        {
          ...integration,
          integrationId: 'another-integration',
          metadata: {
            ...integration.metadata,
            project_tokens: { '42': { token: 'duplicate-project-bot-token' } },
          },
        },
      ],
    });
    await expect(
      resolveGitLabRuntimeToken(
        {
          userId: 'user_123',
          repositoryUrl: 'https://gitlab.example.com/gitlab/team/repo.git',
          createdOnPlatform: 'code-review',
        },
        ambiguous
      )
    ).resolves.toEqual({ success: false, reason: 'ambiguous_integration' });
    expect(ambiguous.tokenService.getToken).toHaveBeenCalledTimes(2);
  });

  it('does not fall back to the integration token when project resolution or storage fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ id: 99 })));
    const dependencies = createDependencies();
    const reviewContext = {
      userId: 'user_123',
      repositoryUrl: 'https://gitlab.example.com/gitlab/team/repo.git',
      createdOnPlatform: 'code-review',
    };

    await expect(resolveGitLabRuntimeToken(reviewContext, dependencies)).resolves.toEqual({
      success: false,
      reason: 'no_project_token',
    });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
    await expect(resolveGitLabRuntimeToken(reviewContext, dependencies)).resolves.toEqual({
      success: false,
      reason: 'project_lookup_failed',
    });
  });
});

describe('GitTokenRPCEntrypoint', () => {
  it('mints repository-scoped tokens after resolving an authorized installation', async () => {
    vi.spyOn(InstallationLookupService.prototype, 'findInstallationId').mockResolvedValue({
      success: true,
      installationId: '123',
      accountLogin: 'old-owner',
      githubAppType: 'lite',
    });
    const getTokenForRepo = vi
      .spyOn(GitHubTokenService.prototype, 'getTokenForRepo')
      .mockResolvedValue('scoped-token');
    const getToken = vi
      .spyOn(GitHubTokenService.prototype, 'getToken')
      .mockResolvedValue('installation-wide-token');
    const rpc = new GitTokenRPCEntrypoint({} as ExecutionContext, {} as CloudflareEnv);

    const result = await rpc.getTokenForRepo({
      githubRepo: 'renamed-owner/repository',
      userId: 'user-1',
    });

    expect(result).toEqual({
      success: true,
      token: 'scoped-token',
      installationId: '123',
      accountLogin: 'old-owner',
      appType: 'lite',
    });
    expect(getTokenForRepo).toHaveBeenCalledWith('123', 'repository', 'lite');
    expect(getToken).not.toHaveBeenCalled();
  });

  it('repairs stale login metadata after a lookup miss before minting a token', async () => {
    const findInstallationId = vi
      .spyOn(InstallationLookupService.prototype, 'findInstallationId')
      .mockResolvedValueOnce({ success: false, reason: 'no_installation_found' })
      .mockResolvedValueOnce({
        success: true,
        installationId: '123',
        accountLogin: 'renamed-owner',
        githubAppType: 'standard',
      });
    vi.spyOn(InstallationLookupService.prototype, 'findRefreshCandidates').mockResolvedValue({
      success: true,
      candidates: [
        {
          integrationId: 'integration-1',
          installationId: '123',
          accountLogin: 'old-owner',
          githubAppType: 'standard',
        },
      ],
    });
    const updateAccountLogin = vi
      .spyOn(InstallationLookupService.prototype, 'updateAccountLogin')
      .mockResolvedValue(true);
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(
      GitHubTokenService.prototype,
      'refreshInstallationAccountLoginIfDue'
    ).mockResolvedValue('renamed-owner');
    const getTokenForRepo = vi
      .spyOn(GitHubTokenService.prototype, 'getTokenForRepo')
      .mockResolvedValue('scoped-token');
    const rpc = new GitTokenRPCEntrypoint({} as ExecutionContext, {} as CloudflareEnv);

    const result = await rpc.getTokenForRepo({
      githubRepo: 'renamed-owner/repository',
      userId: 'user-1',
    });

    expect(result).toMatchObject({ success: true, token: 'scoped-token' });
    expect(updateAccountLogin).toHaveBeenCalledWith('integration-1', 'renamed-owner');
    expect(consoleLog).toHaveBeenCalledWith(
      JSON.stringify({
        message: 'Repaired GitHub installation account login after token lookup miss',
        integrationId: 'integration-1',
        installationId: '123',
        appType: 'standard',
      })
    );
    expect(JSON.stringify(consoleLog.mock.calls)).not.toContain('old-owner');
    expect(JSON.stringify(consoleLog.mock.calls)).not.toContain('renamed-owner');
    expect(findInstallationId).toHaveBeenCalledTimes(2);
    expect(getTokenForRepo).toHaveBeenCalledWith('123', 'repository', 'standard');
  });

  it('warns instead of reporting success when a repaired integration no longer exists', async () => {
    vi.spyOn(InstallationLookupService.prototype, 'findInstallationId').mockResolvedValue({
      success: false,
      reason: 'no_installation_found',
    });
    vi.spyOn(InstallationLookupService.prototype, 'findRefreshCandidates').mockResolvedValue({
      success: true,
      candidates: [
        {
          integrationId: 'integration-1',
          installationId: '123',
          accountLogin: 'old-owner',
          githubAppType: 'standard',
        },
      ],
    });
    vi.spyOn(InstallationLookupService.prototype, 'updateAccountLogin').mockResolvedValue(false);
    vi.spyOn(
      GitHubTokenService.prototype,
      'refreshInstallationAccountLoginIfDue'
    ).mockResolvedValue('renamed-owner');
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rpc = new GitTokenRPCEntrypoint({} as ExecutionContext, {} as CloudflareEnv);

    const result = await rpc.getTokenForRepo({
      githubRepo: 'renamed-owner/repository',
      userId: 'user-1',
    });

    expect(result).toEqual({ success: false, reason: 'no_installation_found' });
    expect(consoleLog).not.toHaveBeenCalled();
    expect(consoleWarn).toHaveBeenCalledWith(
      JSON.stringify({
        message: 'GitHub installation login repair found no integration row to update',
        integrationId: 'integration-1',
        installationId: '123',
        appType: 'standard',
      })
    );
    expect(JSON.stringify(consoleWarn.mock.calls)).not.toContain('old-owner');
    expect(JSON.stringify(consoleWarn.mock.calls)).not.toContain('renamed-owner');
  });

  it('does not mint when refreshed metadata identifies a different repository owner', async () => {
    vi.spyOn(InstallationLookupService.prototype, 'findInstallationId').mockResolvedValue({
      success: false,
      reason: 'no_installation_found',
    });
    vi.spyOn(InstallationLookupService.prototype, 'findRefreshCandidates').mockResolvedValue({
      success: true,
      candidates: [
        {
          integrationId: 'integration-1',
          installationId: '123',
          accountLogin: 'old-owner',
          githubAppType: 'standard',
        },
      ],
    });
    const updateAccountLogin = vi
      .spyOn(InstallationLookupService.prototype, 'updateAccountLogin')
      .mockResolvedValue(true);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(
      GitHubTokenService.prototype,
      'refreshInstallationAccountLoginIfDue'
    ).mockResolvedValue('different-owner');
    const getTokenForRepo = vi.spyOn(GitHubTokenService.prototype, 'getTokenForRepo');
    const rpc = new GitTokenRPCEntrypoint({} as ExecutionContext, {} as CloudflareEnv);

    const result = await rpc.getTokenForRepo({
      githubRepo: 'requested-owner/repository',
      userId: 'user-1',
    });

    expect(result).toEqual({ success: false, reason: 'no_installation_found' });
    expect(updateAccountLogin).toHaveBeenCalledWith('integration-1', 'different-owner');
    expect(getTokenForRepo).not.toHaveBeenCalled();
  });

  it('fails closed without metadata repair when exact owner selection is ambiguous', async () => {
    vi.spyOn(InstallationLookupService.prototype, 'findInstallationId').mockResolvedValue({
      success: false,
      reason: 'ambiguous_installation',
    });
    const findRefreshCandidates = vi.spyOn(
      InstallationLookupService.prototype,
      'findRefreshCandidates'
    );
    const getTokenForRepo = vi.spyOn(GitHubTokenService.prototype, 'getTokenForRepo');
    const rpc = new GitTokenRPCEntrypoint({} as ExecutionContext, {} as CloudflareEnv);

    const result = await rpc.getTokenForRepo({
      githubRepo: 'requested-owner/repository',
      userId: 'user-1',
    });

    expect(result).toEqual({ success: false, reason: 'no_installation_found' });
    expect(findRefreshCandidates).not.toHaveBeenCalled();
    expect(getTokenForRepo).not.toHaveBeenCalled();
  });

  it('does not mint a token for an invalid repository path', async () => {
    const getTokenForRepo = vi.spyOn(GitHubTokenService.prototype, 'getTokenForRepo');
    const rpc = new GitTokenRPCEntrypoint(
      {} as ExecutionContext,
      {
        HYPERDRIVE: { connectionString: 'postgres://test' },
      } as CloudflareEnv
    );

    const result = await rpc.getTokenForRepo({
      githubRepo: 'owner/repository/extra',
      userId: 'user-1',
    });

    expect(result).toEqual({ success: false, reason: 'invalid_repo_format' });
    expect(getTokenForRepo).not.toHaveBeenCalled();
  });

  it('does not fall back to an installation-wide token when scoped minting fails', async () => {
    vi.spyOn(InstallationLookupService.prototype, 'findInstallationId').mockResolvedValue({
      success: true,
      installationId: '123',
      accountLogin: 'old-owner',
      githubAppType: 'standard',
    });
    vi.spyOn(GitHubTokenService.prototype, 'getTokenForRepo').mockRejectedValue(
      new Error('repository not accessible')
    );
    const getToken = vi.spyOn(GitHubTokenService.prototype, 'getToken');
    const rpc = new GitTokenRPCEntrypoint({} as ExecutionContext, {} as CloudflareEnv);

    await expect(
      rpc.getTokenForRepo({ githubRepo: 'renamed-owner/repository', userId: 'user-1' })
    ).rejects.toThrow('repository not accessible');
    expect(getToken).not.toHaveBeenCalled();
  });
});
