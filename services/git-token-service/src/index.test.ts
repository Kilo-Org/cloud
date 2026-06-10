import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as GitLabLookupServiceModule from './gitlab-lookup-service.js';

const serviceMocks = vi.hoisted(() => ({
  findInstallationId: vi.fn(),
  findManagedInstallationForRepo: vi.fn(),
  findRefreshCandidates: vi.fn(),
  updateAccountLogin: vi.fn(),
  getToken: vi.fn(),
  getTokenForRepo: vi.fn(),
  refreshInstallationAccountLoginIfDue: vi.fn(),
  selectUserAuthorization: vi.fn(),
  findGitLabIntegration: vi.fn(),
  findAuthorizedGitLabIntegrations: vi.fn(),
  getGitLabToken: vi.fn(),
}));

vi.mock('cloudflare:workers', () => ({
  WorkerEntrypoint: class WorkerEntrypoint {
    env: unknown;

    constructor(_ctx: unknown, env: unknown) {
      this.env = env;
    }
  },
}));

vi.mock('./github-token-service.js', () => ({
  GitHubTokenService: class GitHubTokenService {
    getToken = serviceMocks.getToken;
    getTokenForRepo = serviceMocks.getTokenForRepo;
    refreshInstallationAccountLoginIfDue = serviceMocks.refreshInstallationAccountLoginIfDue;
  },
}));

vi.mock('./installation-lookup-service.js', () => ({
  InstallationLookupService: class InstallationLookupService {
    findInstallationId = serviceMocks.findInstallationId;
    findManagedInstallationForRepo = serviceMocks.findManagedInstallationForRepo;
    findRefreshCandidates = serviceMocks.findRefreshCandidates;
    updateAccountLogin = serviceMocks.updateAccountLogin;
  },
}));

vi.mock('./github-user-authorization-service.js', () => ({
  GitHubUserAuthorizationService: class GitHubUserAuthorizationService {
    selectUserAuthorization = serviceMocks.selectUserAuthorization;
  },
}));

vi.mock('./gitlab-lookup-service.js', async importOriginal => {
  const actual = await importOriginal<typeof GitLabLookupServiceModule>();
  return {
    ...actual,
    GitLabLookupService: class GitLabLookupService {
      findGitLabIntegration = serviceMocks.findGitLabIntegration;
      findAuthorizedGitLabIntegrations = serviceMocks.findAuthorizedGitLabIntegrations;
    },
  };
});

vi.mock('./gitlab-token-service.js', () => ({
  GitLabTokenService: class GitLabTokenService {
    getToken = serviceMocks.getGitLabToken;
  },
}));

import type { AuthorizedGitLabIntegration } from './gitlab-lookup-service.js';
import { resolveGitLabRuntimeToken } from './gitlab-runtime-token-resolver.js';
import { GitTokenRPCEntrypoint } from './index.js';

const integration: AuthorizedGitLabIntegration = {
  integrationId: '123e4567-e89b-12d3-a456-426614174011',
  integrationType: 'oauth',
  accountId: '42',
  accountLogin: 'octocat',
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

function createService(): GitTokenRPCEntrypoint {
  return new GitTokenRPCEntrypoint(
    {} as ExecutionContext,
    {
      GITHUB_APP_SLUG: 'kiloconnect',
      GITHUB_APP_BOT_USER_ID: '240665456',
      SCM_SESSION_CAPABILITY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    } as unknown as CloudflareEnv
  );
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
      integrationId: integration.integrationId,
      source: { type: 'integration' },
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
      integrationId: integration.integrationId,
      source: {
        type: 'project',
        projectId: 42,
        tokenDigest: '3f4dff81e5f3e75d64343bfe237db23397715d8fbccbb1e035fb20a6d15f4603',
      },
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
      integrationId: integration.integrationId,
      source: {
        type: 'project',
        projectId: 42,
        tokenDigest: '3f4dff81e5f3e75d64343bfe237db23397715d8fbccbb1e035fb20a6d15f4603',
      },
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
      integrationId: integration.integrationId,
      source: {
        type: 'project',
        projectId: 42,
        tokenDigest: '3f4dff81e5f3e75d64343bfe237db23397715d8fbccbb1e035fb20a6d15f4603',
      },
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
      integrationId: integration.integrationId,
      source: {
        type: 'project',
        projectId: 42,
        tokenDigest: '3f4dff81e5f3e75d64343bfe237db23397715d8fbccbb1e035fb20a6d15f4603',
      },
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

describe('GitTokenRPCEntrypoint.getTokenForRepo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('mints repository-scoped tokens after resolving an authorized installation', async () => {
    serviceMocks.findInstallationId.mockResolvedValue({
      success: true,
      installationId: '123',
      accountLogin: 'old-owner',
      githubAppType: 'lite',
    });
    serviceMocks.getTokenForRepo.mockResolvedValue('scoped-token');
    serviceMocks.getToken.mockResolvedValue('installation-wide-token');

    const result = await createService().getTokenForRepo({
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
    expect(serviceMocks.getTokenForRepo).toHaveBeenCalledWith('123', 'repository', 'lite');
    expect(serviceMocks.getToken).not.toHaveBeenCalled();
  });

  it('repairs stale login metadata after a lookup miss before minting a token', async () => {
    serviceMocks.findInstallationId
      .mockResolvedValueOnce({ success: false, reason: 'no_installation_found' })
      .mockResolvedValueOnce({
        success: true,
        installationId: '123',
        accountLogin: 'renamed-owner',
        githubAppType: 'standard',
      });
    serviceMocks.findRefreshCandidates.mockResolvedValue({
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
    serviceMocks.updateAccountLogin.mockResolvedValue(true);
    serviceMocks.refreshInstallationAccountLoginIfDue.mockResolvedValue('renamed-owner');
    serviceMocks.getTokenForRepo.mockResolvedValue('scoped-token');
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await createService().getTokenForRepo({
      githubRepo: 'renamed-owner/repository',
      userId: 'user-1',
    });

    expect(result).toMatchObject({ success: true, token: 'scoped-token' });
    expect(serviceMocks.updateAccountLogin).toHaveBeenCalledWith('integration-1', 'renamed-owner');
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
    expect(serviceMocks.findInstallationId).toHaveBeenCalledTimes(2);
    expect(serviceMocks.getTokenForRepo).toHaveBeenCalledWith('123', 'repository', 'standard');
  });

  it('warns instead of reporting success when a repaired integration no longer exists', async () => {
    serviceMocks.findInstallationId.mockResolvedValue({
      success: false,
      reason: 'no_installation_found',
    });
    serviceMocks.findRefreshCandidates.mockResolvedValue({
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
    serviceMocks.updateAccountLogin.mockResolvedValue(false);
    serviceMocks.refreshInstallationAccountLoginIfDue.mockResolvedValue('renamed-owner');
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await createService().getTokenForRepo({
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
    serviceMocks.findInstallationId.mockResolvedValue({
      success: false,
      reason: 'no_installation_found',
    });
    serviceMocks.findRefreshCandidates.mockResolvedValue({
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
    serviceMocks.updateAccountLogin.mockResolvedValue(true);
    serviceMocks.refreshInstallationAccountLoginIfDue.mockResolvedValue('different-owner');
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await createService().getTokenForRepo({
      githubRepo: 'requested-owner/repository',
      userId: 'user-1',
    });

    expect(result).toEqual({ success: false, reason: 'no_installation_found' });
    expect(serviceMocks.updateAccountLogin).toHaveBeenCalledWith(
      'integration-1',
      'different-owner'
    );
    expect(serviceMocks.getTokenForRepo).not.toHaveBeenCalled();
  });

  it('fails closed without metadata repair when exact owner selection is ambiguous', async () => {
    serviceMocks.findInstallationId.mockResolvedValue({
      success: false,
      reason: 'ambiguous_installation',
    });

    const result = await createService().getTokenForRepo({
      githubRepo: 'requested-owner/repository',
      userId: 'user-1',
    });

    expect(result).toEqual({ success: false, reason: 'no_installation_found' });
    expect(serviceMocks.findRefreshCandidates).not.toHaveBeenCalled();
    expect(serviceMocks.getTokenForRepo).not.toHaveBeenCalled();
  });

  it('does not mint a token for an invalid repository path', async () => {
    serviceMocks.findInstallationId.mockResolvedValue({
      success: false,
      reason: 'invalid_repo_format',
    });

    const result = await createService().getTokenForRepo({
      githubRepo: 'owner/repository/extra',
      userId: 'user-1',
    });

    expect(result).toEqual({ success: false, reason: 'invalid_repo_format' });
    expect(serviceMocks.getTokenForRepo).not.toHaveBeenCalled();
  });

  it('does not fall back to an installation-wide token when scoped minting fails', async () => {
    serviceMocks.findInstallationId.mockResolvedValue({
      success: true,
      installationId: '123',
      accountLogin: 'old-owner',
      githubAppType: 'standard',
    });
    serviceMocks.getTokenForRepo.mockRejectedValueOnce(new Error('repository not accessible'));

    await expect(
      createService().getTokenForRepo({ githubRepo: 'renamed-owner/repository', userId: 'user-1' })
    ).rejects.toThrow('repository not accessible');
    expect(serviceMocks.getToken).not.toHaveBeenCalled();
  });
});

const outboundContainerId = 'outbound-container-1';

describe('GitTokenRPCEntrypoint GitHub session capability RPCs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serviceMocks.findManagedInstallationForRepo.mockResolvedValue({
      success: true,
      installationId: '123',
      accountLogin: 'acme',
      githubAppType: 'standard',
      repoName: 'repo',
      permissions: { contents: 'write', pull_requests: 'write' },
    });
    serviceMocks.getTokenForRepo.mockResolvedValue('installation-token');
    serviceMocks.selectUserAuthorization.mockResolvedValue({
      selected: true,
      token: 'user-token',
      gitAuthor: { name: 'octocat', email: '1+octocat@users.noreply.github.com' },
    });
  });

  it('issues an opaque GitHub capability while preserving non-secret attribution metadata', async () => {
    const result = await createService().issueGitHubSessionCapability({
      githubRepo: 'Acme/Repo',
      userId: 'user_1',
      outboundContainerId,
      allowUserAuthorization: true,
    });

    expect(result).toMatchObject({
      success: true,
      source: 'user',
      installationId: '123',
      accountLogin: 'acme',
      appType: 'standard',
      gitAuthor: { name: 'octocat' },
    });
    if (!result.success) throw new Error('Expected successful issuance');
    expect(result.capability).toMatch(/^kgh2\./);
    expect(JSON.stringify(result)).not.toContain('user-token');
    expect(result).not.toHaveProperty('githubToken');
  });

  it('does not expose an installation token in an installation-source issuance result', async () => {
    const result = await createService().issueGitHubSessionCapability({
      githubRepo: 'acme/repo',
      userId: 'user_1',
      outboundContainerId,
    });

    expect(result).toMatchObject({ success: true, source: 'installation' });
    if (!result.success) throw new Error('Expected successful issuance');
    expect(JSON.stringify(result)).not.toContain('installation-token');
    expect(result.capability).not.toContain('installation-token');
    expect(result).not.toHaveProperty('githubToken');
    expect(result).not.toHaveProperty('token');
  });

  it('returns a sanitized declared failure when capability key configuration is invalid', async () => {
    const service = new GitTokenRPCEntrypoint(
      {} as ExecutionContext,
      {
        GITHUB_APP_SLUG: 'kiloconnect',
        GITHUB_APP_BOT_USER_ID: '240665456',
        SCM_SESSION_CAPABILITY_ENCRYPTION_KEY: 'not-a-valid-key',
      } as unknown as CloudflareEnv
    );

    await expect(
      service.issueGitHubSessionCapability({
        githubRepo: 'acme/repo',
        userId: 'user_1',
        outboundContainerId,
      })
    ).resolves.toEqual({ success: false, reason: 'capability_configuration_error' });
  });

  it('does not redeem a capability from another outbound container or resolve authorization', async () => {
    const service = createService();
    const issued = await service.issueGitHubSessionCapability({
      githubRepo: 'acme/repo',
      userId: 'user_1',
      outboundContainerId,
    });
    if (!issued.success) throw new Error('Expected successful issuance');
    serviceMocks.findManagedInstallationForRepo.mockClear();
    serviceMocks.getTokenForRepo.mockClear();

    await expect(
      service.redeemGitHubSessionCapability({
        capability: issued.capability,
        outboundContainerId: 'another-outbound-container',
        requestMethod: 'GET',
        requestUrl: 'https://github.com/acme/repo.git/info/refs?service=git-upload-pack',
      })
    ).resolves.toEqual({ success: false, reason: 'container_mismatch' });
    expect(serviceMocks.findManagedInstallationForRepo).not.toHaveBeenCalled();
    expect(serviceMocks.getTokenForRepo).not.toHaveBeenCalled();
  });

  it('does not redeem a bound capability without an outbound container or resolve authorization', async () => {
    const service = createService();
    const issued = await service.issueGitHubSessionCapability({
      githubRepo: 'acme/repo',
      userId: 'user_1',
      outboundContainerId,
    });
    if (!issued.success) throw new Error('Expected successful issuance');
    serviceMocks.findManagedInstallationForRepo.mockClear();
    serviceMocks.getTokenForRepo.mockClear();

    await expect(
      service.redeemGitHubSessionCapability({
        capability: issued.capability,
        requestMethod: 'GET',
        requestUrl: 'https://github.com/acme/repo.git/info/refs?service=git-upload-pack',
      })
    ).resolves.toEqual({ success: false, reason: 'container_mismatch' });
    expect(serviceMocks.findManagedInstallationForRepo).not.toHaveBeenCalled();
    expect(serviceMocks.getTokenForRepo).not.toHaveBeenCalled();
  });

  it('temporarily issues and redeems a legacy unbound GitHub capability for an old caller', async () => {
    const service = createService();
    const issued = await service.issueGitHubSessionCapability({
      githubRepo: 'acme/repo',
      userId: 'user_1',
    });
    if (!issued.success) throw new Error('Expected successful issuance');
    expect(issued.capability).toMatch(/^kgh1\./);
    serviceMocks.getTokenForRepo.mockClear();

    await expect(
      service.redeemGitHubSessionCapability({
        capability: issued.capability,
        requestMethod: 'GET',
        requestUrl: 'https://github.com/acme/repo.git/info/refs?service=git-upload-pack',
      })
    ).resolves.toEqual({
      success: true,
      authorization: `Basic ${Buffer.from('x-access-token:installation-token').toString('base64')}`,
    });
    expect(serviceMocks.getTokenForRepo).toHaveBeenCalledOnce();
  });

  it('rejects tampered capabilities before resolving any upstream authorization', async () => {
    const service = createService();
    const issued = await service.issueGitHubSessionCapability({
      githubRepo: 'acme/repo',
      userId: 'user_1',
      outboundContainerId,
    });
    if (!issued.success) throw new Error('Expected successful issuance');
    serviceMocks.findManagedInstallationForRepo.mockClear();
    serviceMocks.getTokenForRepo.mockClear();

    const changedOffset = issued.capability.lastIndexOf('.') + 4;
    const changedCharacter = issued.capability[changedOffset] === 'A' ? 'B' : 'A';
    const tamperedCapability = `${issued.capability.slice(0, changedOffset)}${changedCharacter}${issued.capability.slice(changedOffset + 1)}`;
    await expect(
      service.redeemGitHubSessionCapability({
        capability: tamperedCapability,
        outboundContainerId,
        requestMethod: 'GET',
        requestUrl: 'https://github.com/acme/repo.git/info/refs?service=git-upload-pack',
      })
    ).resolves.toEqual({ success: false, reason: 'invalid_capability' });
    expect(serviceMocks.findManagedInstallationForRepo).not.toHaveBeenCalled();
    expect(serviceMocks.getTokenForRepo).not.toHaveBeenCalled();
  });

  it.each([
    ['GET', 'https://github.com/Acme/Repo.git/info/refs?service=git-upload-pack'],
    ['GET', 'https://github.com/acme/repo.git/info/refs?service=git-receive-pack'],
    ['POST', 'https://github.com/acme/repo.git/git-upload-pack'],
    ['POST', 'https://github.com/acme/repo.git/git-receive-pack'],
  ] as const)(
    'redeems an installation-pinned capability for %s Git URL %s',
    async (requestMethod, requestUrl) => {
      const service = createService();
      const issued = await service.issueGitHubSessionCapability({
        githubRepo: 'Acme/Repo',
        userId: 'user_1',
        outboundContainerId,
      });
      if (!issued.success) throw new Error('Expected successful issuance');
      serviceMocks.getTokenForRepo.mockClear();

      const redemption = await service.redeemGitHubSessionCapability({
        capability: issued.capability,
        outboundContainerId,
        requestMethod,
        requestUrl,
      });

      expect(redemption).toEqual({
        success: true,
        authorization: `Basic ${Buffer.from('x-access-token:installation-token').toString('base64')}`,
      });
      expect(serviceMocks.selectUserAuthorization).not.toHaveBeenCalled();
      expect(serviceMocks.getTokenForRepo).toHaveBeenCalledOnce();
    }
  );

  it('returns a sanitized failure when installation token generation fails during redemption', async () => {
    const service = createService();
    const issued = await service.issueGitHubSessionCapability({
      githubRepo: 'acme/repo',
      userId: 'user_1',
      outboundContainerId,
    });
    if (!issued.success) throw new Error('Expected successful issuance');
    serviceMocks.getTokenForRepo.mockRejectedValueOnce(
      new Error('provider rejected installation token: raw-provider-detail')
    );

    const redemption = await service.redeemGitHubSessionCapability({
      capability: issued.capability,
      outboundContainerId,
      requestMethod: 'GET',
      requestUrl: 'https://github.com/acme/repo.git/info/refs?service=git-upload-pack',
    });

    expect(redemption).toEqual({ success: false, reason: 'source_unavailable' });
    expect(JSON.stringify(redemption)).not.toContain('raw-provider-detail');
    expect(JSON.stringify(redemption)).not.toContain('provider rejected');
  });

  it.each([
    'https://github.com/acme/repo.git/info/lfs/objects/batch',
    'https://github.com/acme/repo.git/info/lfs/locks/verify',
  ])('redeems an installation-pinned capability for exact LFS control URL %s', async requestUrl => {
    const service = createService();
    const issued = await service.issueGitHubSessionCapability({
      githubRepo: 'acme/repo',
      userId: 'user_1',
      outboundContainerId,
    });
    if (!issued.success) throw new Error('Expected successful issuance');
    serviceMocks.getTokenForRepo.mockClear();

    const redemption = await service.redeemGitHubSessionCapability({
      capability: issued.capability,
      outboundContainerId,
      requestMethod: 'POST',
      requestUrl,
    });

    expect(redemption).toEqual({
      success: true,
      authorization: `Basic ${Buffer.from('x-access-token:installation-token').toString('base64')}`,
    });
    expect(serviceMocks.getTokenForRepo).toHaveBeenCalledOnce();
  });

  it.each([
    ['GET', 'https://github.com/acme/repo.git/info/lfs/objects/batch', 'invalid_upstream_request'],
    [
      'POST',
      'https://github.com/acme/repo.git/info/lfs/objects/batch?operation=upload',
      'invalid_upstream_request',
    ],
    ['POST', 'https://github.com/acme/other.git/info/lfs/objects/batch', 'repository_mismatch'],
    ['POST', 'https://github.com/acme/repo.git/info/lfs/locks', 'invalid_upstream_request'],
  ] as const)(
    'rejects unsupported LFS control request %s %s',
    async (requestMethod, requestUrl, reason) => {
      const service = createService();
      const issued = await service.issueGitHubSessionCapability({
        githubRepo: 'acme/repo',
        userId: 'user_1',
        outboundContainerId,
      });
      if (!issued.success) throw new Error('Expected successful issuance');
      serviceMocks.getTokenForRepo.mockClear();

      await expect(
        service.redeemGitHubSessionCapability({
          capability: issued.capability,
          outboundContainerId,
          requestMethod,
          requestUrl,
        })
      ).resolves.toEqual({ success: false, reason });
      expect(serviceMocks.getTokenForRepo).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['POST', 'https://api.github.com/repos/acme/repo/issues/42/comments'],
    ['PATCH', 'https://api.github.com/repos/acme/repo/issues/comments/123'],
    ['POST', 'https://api.github.com/repos/acme/repo/pulls/42/reviews'],
  ] as const)(
    'redeems a user-pinned capability for review API request %s %s',
    async (requestMethod, requestUrl) => {
      const service = createService();
      const issued = await service.issueGitHubSessionCapability({
        githubRepo: 'acme/repo',
        userId: 'user_1',
        outboundContainerId,
        allowUserAuthorization: true,
      });
      if (!issued.success) throw new Error('Expected successful issuance');
      serviceMocks.selectUserAuthorization.mockClear();
      serviceMocks.selectUserAuthorization.mockResolvedValueOnce({
        selected: true,
        token: 'refreshed-user-token',
        gitAuthor: { name: 'octocat', email: '1+octocat@users.noreply.github.com' },
      });

      const redemption = await service.redeemGitHubSessionCapability({
        capability: issued.capability,
        outboundContainerId,
        requestMethod,
        requestUrl,
      });

      expect(redemption).toEqual({ success: true, authorization: 'Bearer refreshed-user-token' });
      expect(serviceMocks.selectUserAuthorization).toHaveBeenCalledOnce();
    }
  );

  it('redeems a user-pinned capability for its pull-request REST diff endpoint', async () => {
    const service = createService();
    const issued = await service.issueGitHubSessionCapability({
      githubRepo: 'acme/repo',
      userId: 'user_1',
      outboundContainerId,
      allowUserAuthorization: true,
    });
    if (!issued.success) throw new Error('Expected successful issuance');
    serviceMocks.selectUserAuthorization.mockClear();

    await expect(
      service.redeemGitHubSessionCapability({
        capability: issued.capability,
        outboundContainerId,
        requestMethod: 'GET',
        requestUrl: 'https://api.github.com/repos/acme/repo/pulls/42',
      })
    ).resolves.toEqual({ success: true, authorization: 'Bearer user-token' });
    expect(serviceMocks.selectUserAuthorization).toHaveBeenCalledOnce();
  });

  it.each([
    'https://api.github.com/user/repos',
    'https://api.github.com/repos/acme/other/issues/42/comments',
    'https://api.github.com/graphql',
  ])(
    'does not redeem a GitHub capability for an API request outside its repository: %s',
    async requestUrl => {
      const service = createService();
      const issued = await service.issueGitHubSessionCapability({
        githubRepo: 'acme/repo',
        userId: 'user_1',
        outboundContainerId,
        allowUserAuthorization: true,
      });
      if (!issued.success) throw new Error('Expected successful issuance');
      serviceMocks.selectUserAuthorization.mockClear();

      await expect(
        service.redeemGitHubSessionCapability({
          capability: issued.capability,
          outboundContainerId,
          requestMethod: 'POST',
          requestUrl,
        })
      ).resolves.toEqual({ success: false, reason: 'repository_mismatch' });
      expect(serviceMocks.selectUserAuthorization).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['GET', 'https://github.com/acme/other.git/info/refs?service=git-upload-pack'],
    ['POST', 'https://github.com/acme/other.git/git-receive-pack'],
  ] as const)(
    'does not redeem a selected-user capability for another Git repository via %s %s',
    async (requestMethod, requestUrl) => {
      const service = createService();
      const issued = await service.issueGitHubSessionCapability({
        githubRepo: 'acme/repo',
        userId: 'user_1',
        outboundContainerId,
        allowUserAuthorization: true,
      });
      if (!issued.success) throw new Error('Expected successful issuance');
      expect(issued.source).toBe('user');
      serviceMocks.selectUserAuthorization.mockClear();

      await expect(
        service.redeemGitHubSessionCapability({
          capability: issued.capability,
          outboundContainerId,
          requestMethod,
          requestUrl,
        })
      ).resolves.toEqual({ success: false, reason: 'repository_mismatch' });
      expect(serviceMocks.selectUserAuthorization).not.toHaveBeenCalled();
    }
  );

  it.each([
    [
      'GET',
      'http://github.com/acme/repo.git/info/refs?service=git-upload-pack',
      'invalid_upstream_url',
    ],
    [
      'GET',
      'https://attacker@github.com/acme/repo.git/info/refs?service=git-upload-pack',
      'invalid_upstream_url',
    ],
    [
      'GET',
      'https://github.com.evil.example/acme/repo.git/info/refs?service=git-upload-pack',
      'upstream_host_not_allowed',
    ],
    [
      'GET',
      'https://gitlab.com/acme/repo.git/info/refs?service=git-upload-pack',
      'upstream_host_not_allowed',
    ],
    [
      'GET',
      'https://github.com/acme/other.git/info/refs?service=git-upload-pack',
      'repository_mismatch',
    ],
    ['GET', 'https://github.com/acme/repo/settings', 'invalid_upstream_request'],
    ['GET', 'https://github.com/acme/repo.git/info/refs', 'invalid_upstream_request'],
    [
      'POST',
      'https://github.com/acme/repo.git/info/refs?service=git-upload-pack',
      'invalid_upstream_request',
    ],
    ['GET', 'https://github.com/acme/repo.git/git-receive-pack', 'invalid_upstream_request'],
    ['CONNECT', 'https://api.github.com/user/repos', 'invalid_upstream_request'],
    ['PATCH', 'https://api.github.com/repos/acme/repo/pulls/42', 'invalid_upstream_request'],
    ['PUT', 'https://api.github.com/repos/acme/repo/pulls/42/merge', 'invalid_upstream_request'],
    ['GET', 'https://api.github.com/repos/acme/repo/actions/variables', 'invalid_upstream_request'],
    [
      'POST',
      'https://api.github.com/repos/acme/repo/issues/42%2F..%2F43/comments',
      'invalid_upstream_url',
    ],
  ] as const)(
    'rejects unsafe upstream request %s %s without forwarding authorization',
    async (requestMethod, requestUrl, reason) => {
      const service = createService();
      const issued = await service.issueGitHubSessionCapability({
        githubRepo: 'acme/repo',
        userId: 'user_1',
        outboundContainerId,
      });
      if (!issued.success) throw new Error('Expected successful issuance');
      serviceMocks.getTokenForRepo.mockClear();

      await expect(
        service.redeemGitHubSessionCapability({
          capability: issued.capability,
          outboundContainerId,
          requestMethod,
          requestUrl,
        })
      ).resolves.toEqual({ success: false, reason });
      expect(serviceMocks.getTokenForRepo).not.toHaveBeenCalled();
    }
  );

  it('rejects user-source redemption rather than falling back to installation authorization', async () => {
    const service = createService();
    const issued = await service.issueGitHubSessionCapability({
      githubRepo: 'acme/repo',
      userId: 'user_1',
      outboundContainerId,
      allowUserAuthorization: true,
    });
    if (!issued.success) throw new Error('Expected successful issuance');
    serviceMocks.selectUserAuthorization.mockResolvedValueOnce({
      selected: false,
      reason: 'no_user_authorization',
    });
    serviceMocks.getTokenForRepo.mockClear();

    await expect(
      service.redeemGitHubSessionCapability({
        capability: issued.capability,
        outboundContainerId,
        requestMethod: 'GET',
        requestUrl: 'https://api.github.com/repos/acme/repo/pulls/42',
      })
    ).resolves.toEqual({ success: false, reason: 'source_unavailable' });
    expect(serviceMocks.getTokenForRepo).not.toHaveBeenCalled();
  });

  it('rejects a user capability if selected attribution identity changes before redemption', async () => {
    const service = createService();
    const issued = await service.issueGitHubSessionCapability({
      githubRepo: 'acme/repo',
      userId: 'user_1',
      outboundContainerId,
      allowUserAuthorization: true,
    });
    if (!issued.success) throw new Error('Expected successful issuance');
    serviceMocks.selectUserAuthorization.mockResolvedValueOnce({
      selected: true,
      token: 'refreshed-other-user-token',
      gitAuthor: { name: 'another-user', email: '2+another-user@users.noreply.github.com' },
    });

    await expect(
      service.redeemGitHubSessionCapability({
        capability: issued.capability,
        outboundContainerId,
        requestMethod: 'GET',
        requestUrl: 'https://api.github.com/repos/acme/repo/pulls/42',
      })
    ).resolves.toEqual({ success: false, reason: 'identity_mismatch' });
  });

  it('rejects an installation capability if the resolved installation identity changes', async () => {
    const service = createService();
    const issued = await service.issueGitHubSessionCapability({
      githubRepo: 'acme/repo',
      userId: 'user_1',
      outboundContainerId,
    });
    if (!issued.success) throw new Error('Expected successful issuance');
    serviceMocks.findManagedInstallationForRepo.mockResolvedValueOnce({
      success: true,
      installationId: '456',
      accountLogin: 'acme',
      githubAppType: 'standard',
      repoName: 'repo',
      permissions: { contents: 'write', pull_requests: 'write' },
    });

    await expect(
      service.redeemGitHubSessionCapability({
        capability: issued.capability,
        outboundContainerId,
        requestMethod: 'GET',
        requestUrl: 'https://github.com/acme/repo.git/info/refs?service=git-upload-pack',
      })
    ).resolves.toEqual({ success: false, reason: 'identity_mismatch' });
  });

  it('requires the outbound handler to redeem redirected requests again before forwarding auth', async () => {
    const service = createService();
    const issued = await service.issueGitHubSessionCapability({
      githubRepo: 'acme/repo',
      userId: 'user_1',
      outboundContainerId,
    });
    if (!issued.success) throw new Error('Expected successful issuance');

    await expect(
      service.redeemGitHubSessionCapability({
        capability: issued.capability,
        outboundContainerId,
        requestMethod: 'GET',
        requestUrl: 'https://redirect.example.com/acme/repo.git/info/refs?service=git-upload-pack',
      })
    ).resolves.toEqual({ success: false, reason: 'upstream_host_not_allowed' });
  });
});

describe('GitTokenRPCEntrypoint GitLab session capability RPCs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serviceMocks.findGitLabIntegration.mockResolvedValue({
      success: true,
      integrationId: 'ef2eb5c7-27ce-4f43-b6d3-8f282abc145c',
      integrationType: 'oauth',
      accountId: '42',
      accountLogin: 'octocat',
      metadata: {
        access_token: 'gitlab-oauth-token',
        auth_type: 'oauth',
      },
    });
    serviceMocks.getGitLabToken.mockResolvedValue({
      success: true,
      token: 'gitlab-oauth-token',
      instanceUrl: 'https://gitlab.com',
    });
  });

  it.each([
    ['https://gitlab.com/acme/widgets.git', 'https://gitlab.com', 'gitlab.com', 'acme/widgets'],
    [
      'https://gitlab.example.com/acme/platform/widgets.git',
      'https://gitlab.example.com',
      'gitlab.example.com',
      'acme/platform/widgets',
    ],
  ])(
    'issues an opaque GitLab capability for %s',
    async (gitUrl, instanceUrl, instanceHost, projectPath) => {
      serviceMocks.findGitLabIntegration.mockResolvedValueOnce({
        success: true,
        integrationId: 'ef2eb5c7-27ce-4f43-b6d3-8f282abc145c',
        integrationType: 'oauth',
        accountId: '42',
        accountLogin: 'octocat',
        metadata: {
          access_token: 'gitlab-oauth-token',
          auth_type: 'oauth',
          ...(instanceUrl !== 'https://gitlab.com' ? { gitlab_instance_url: instanceUrl } : {}),
        },
      });
      serviceMocks.getGitLabToken.mockResolvedValueOnce({
        success: true,
        token: 'gitlab-oauth-token',
        instanceUrl,
      });

      const result = await createService().issueGitLabSessionCapability({
        gitUrl,
        userId: 'user_1',
        outboundContainerId,
      });

      expect(result).toMatchObject({
        success: true,
        instanceOrigin: instanceUrl,
        instanceHost,
        projectPath,
        integrationId: 'ef2eb5c7-27ce-4f43-b6d3-8f282abc145c',
        authType: 'oauth',
        identity: { accountId: '42', accountLogin: 'octocat' },
      });
      if (!result.success) throw new Error('Expected successful issuance');
      expect(result.capability).toMatch(/^kgl2\./);
      expect(JSON.stringify(result)).not.toContain('gitlab-oauth-token');
      expect(result).not.toHaveProperty('token');
    }
  );

  it('does not redeem a capability from another outbound container or resolve its source', async () => {
    const service = createService();
    const issued = await service.issueGitLabSessionCapability({
      gitUrl: 'https://gitlab.com/acme/widgets.git',
      userId: 'user_1',
      outboundContainerId,
    });
    if (!issued.success) throw new Error('Expected successful issuance');
    serviceMocks.findGitLabIntegration.mockClear();
    serviceMocks.getGitLabToken.mockClear();

    await expect(
      service.redeemGitLabSessionCapability({
        capability: issued.capability,
        outboundContainerId: 'another-outbound-container',
        requestMethod: 'GET',
        requestUrl: 'https://gitlab.com/api/v4/projects',
      })
    ).resolves.toEqual({ success: false, reason: 'container_mismatch' });
    expect(serviceMocks.findGitLabIntegration).not.toHaveBeenCalled();
    expect(serviceMocks.getGitLabToken).not.toHaveBeenCalled();
  });

  it('does not redeem a bound capability without an outbound container or resolve its source', async () => {
    const service = createService();
    const issued = await service.issueGitLabSessionCapability({
      gitUrl: 'https://gitlab.com/acme/widgets.git',
      userId: 'user_1',
      outboundContainerId,
    });
    if (!issued.success) throw new Error('Expected successful issuance');
    serviceMocks.findGitLabIntegration.mockClear();
    serviceMocks.getGitLabToken.mockClear();

    await expect(
      service.redeemGitLabSessionCapability({
        capability: issued.capability,
        requestMethod: 'GET',
        requestUrl: 'https://gitlab.com/api/v4/projects',
      })
    ).resolves.toEqual({ success: false, reason: 'container_mismatch' });
    expect(serviceMocks.findGitLabIntegration).not.toHaveBeenCalled();
    expect(serviceMocks.getGitLabToken).not.toHaveBeenCalled();
  });

  it('temporarily issues and redeems a legacy unbound GitLab capability for an old caller', async () => {
    const service = createService();
    const issued = await service.issueGitLabSessionCapability({
      gitUrl: 'https://gitlab.com/acme/widgets.git',
      userId: 'user_1',
    });
    if (!issued.success) throw new Error('Expected successful issuance');
    expect(issued.capability).toMatch(/^kgl1\./);
    serviceMocks.findGitLabIntegration.mockClear();
    serviceMocks.getGitLabToken.mockResolvedValueOnce({
      success: true,
      token: 'refreshed-gitlab-token',
      instanceUrl: 'https://gitlab.com',
    });

    await expect(
      service.redeemGitLabSessionCapability({
        capability: issued.capability,
        requestMethod: 'GET',
        requestUrl: 'https://gitlab.com/api/v4/projects/acme%2Fwidgets/merge_requests/42/changes',
      })
    ).resolves.toEqual({
      success: true,
      headers: { authorization: 'Bearer refreshed-gitlab-token' },
    });
    expect(serviceMocks.findGitLabIntegration).toHaveBeenCalledOnce();
    expect(serviceMocks.getGitLabToken).toHaveBeenCalledTimes(2);
  });

  it('issues an opaque project-source capability for a code-review repository without exposing its token', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ id: 42 })));
    serviceMocks.findAuthorizedGitLabIntegrations.mockResolvedValueOnce({
      success: true,
      integrations: [
        {
          integrationId: 'ef2eb5c7-27ce-4f43-b6d3-8f282abc145c',
          metadata: {
            access_token: 'gitlab-oauth-token',
            auth_type: 'oauth',
            project_tokens: { '42': { token: 'project-access-token' } },
          },
        },
      ],
    });
    serviceMocks.findGitLabIntegration.mockResolvedValueOnce({
      success: true,
      integrationId: 'ef2eb5c7-27ce-4f43-b6d3-8f282abc145c',
      integrationType: 'oauth',
      accountId: '42',
      accountLogin: 'octocat',
      metadata: {
        access_token: 'gitlab-oauth-token',
        auth_type: 'oauth',
        project_tokens: { '42': { token: 'project-access-token' } },
      },
    });

    const result = await createService().issueGitLabSessionCapability({
      gitUrl: 'https://gitlab.com/acme/widgets.git',
      userId: 'user_1',
      outboundContainerId,
      createdOnPlatform: 'code-review',
    });

    expect(result).toMatchObject({
      success: true,
      source: {
        type: 'project',
        projectId: 42,
        tokenDigest: 'f30b0bf364d41460c0119e521d2af8ae7eeacca9745981678d58b07b13c94edf',
      },
      glabIsOAuth2: false,
    });
    if (!result.success) throw new Error('Expected successful issuance');
    expect(result.capability).toMatch(/^kgl2\./);
    expect(JSON.stringify(result)).not.toContain('project-access-token');
    expect(result).not.toHaveProperty('token');
  });

  it.each([
    [
      'GET',
      'https://gitlab.com/api/v4/projects/42/merge_requests/42/changes',
      { 'PRIVATE-TOKEN': 'project-access-token' },
    ],
    [
      'GET',
      'https://gitlab.com/acme/widgets.git/info/refs?service=git-upload-pack',
      { authorization: `Basic ${Buffer.from('oauth2:project-access-token').toString('base64')}` },
    ],
  ] as const)(
    'redeems a project-source capability server-side for %s %s',
    async (requestMethod, requestUrl, headers) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ id: 42 })));
      const projectIntegration = {
        success: true as const,
        integrationId: 'ef2eb5c7-27ce-4f43-b6d3-8f282abc145c',
        integrationType: 'oauth',
        accountId: '42',
        accountLogin: 'octocat',
        metadata: {
          access_token: 'gitlab-oauth-token',
          auth_type: 'oauth' as const,
          project_tokens: { '42': { token: 'project-access-token' } },
        },
      };
      serviceMocks.findAuthorizedGitLabIntegrations.mockResolvedValueOnce({
        success: true,
        integrations: [projectIntegration],
      });
      serviceMocks.findGitLabIntegration.mockResolvedValue(projectIntegration);
      const service = createService();
      const issued = await service.issueGitLabSessionCapability({
        gitUrl: 'https://gitlab.com/acme/widgets.git',
        userId: 'user_1',
        outboundContainerId,
        createdOnPlatform: 'code-review',
      });
      if (!issued.success) throw new Error('Expected successful issuance');
      serviceMocks.getGitLabToken.mockClear();

      await expect(
        service.redeemGitLabSessionCapability({
          capability: issued.capability,
          outboundContainerId,
          requestMethod,
          requestUrl,
        })
      ).resolves.toEqual({ success: true, headers });
      expect(serviceMocks.getGitLabToken).not.toHaveBeenCalled();
    }
  );

  it('fails closed when a project-source capability token is rotated', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ id: 42 })));
    const projectIntegration = {
      success: true as const,
      integrationId: 'ef2eb5c7-27ce-4f43-b6d3-8f282abc145c',
      integrationType: 'oauth',
      accountId: '42',
      accountLogin: 'octocat',
      metadata: {
        access_token: 'gitlab-oauth-token',
        auth_type: 'oauth' as const,
        project_tokens: { '42': { token: 'project-access-token' } },
      },
    };
    serviceMocks.findAuthorizedGitLabIntegrations.mockResolvedValueOnce({
      success: true,
      integrations: [projectIntegration],
    });
    serviceMocks.findGitLabIntegration.mockResolvedValueOnce(projectIntegration);
    const service = createService();
    const issued = await service.issueGitLabSessionCapability({
      gitUrl: 'https://gitlab.com/acme/widgets.git',
      userId: 'user_1',
      outboundContainerId,
      createdOnPlatform: 'code-review',
    });
    if (!issued.success) throw new Error('Expected successful issuance');
    serviceMocks.findGitLabIntegration.mockResolvedValueOnce({
      ...projectIntegration,
      metadata: {
        ...projectIntegration.metadata,
        project_tokens: { '42': { token: 'rotated-project-access-token' } },
      },
    });

    await expect(
      service.redeemGitLabSessionCapability({
        capability: issued.capability,
        outboundContainerId,
        requestMethod: 'GET',
        requestUrl: 'https://gitlab.com/api/v4/projects/42/merge_requests/42/changes',
      })
    ).resolves.toEqual({ success: false, reason: 'source_unavailable' });
  });

  it.each([
    [
      'GET',
      'https://gitlab.com/acme/widgets.git/info/refs?service=git-upload-pack',
      { authorization: `Basic ${Buffer.from('oauth2:refreshed-gitlab-pat').toString('base64')}` },
    ],
    [
      'GET',
      'https://gitlab.com/api/v4/projects/acme%2Fwidgets/merge_requests/42/changes',
      { authorization: 'Bearer refreshed-gitlab-pat' },
    ],
  ] as const)(
    'redeems an ordinary PAT-source capability server-side for %s %s',
    async (requestMethod, requestUrl, headers) => {
      serviceMocks.findGitLabIntegration.mockResolvedValue({
        success: true,
        integrationId: 'ef2eb5c7-27ce-4f43-b6d3-8f282abc145c',
        integrationType: 'pat',
        accountId: '42',
        accountLogin: 'octocat',
        metadata: { access_token: 'gitlab-pat-token', auth_type: 'pat' },
      });
      serviceMocks.getGitLabToken.mockResolvedValueOnce({
        success: true,
        token: 'gitlab-pat-token',
        instanceUrl: 'https://gitlab.com',
      });
      const service = createService();
      const issued = await service.issueGitLabSessionCapability({
        gitUrl: 'https://gitlab.com/acme/widgets.git',
        userId: 'user_1',
        outboundContainerId,
      });
      if (!issued.success) throw new Error('Expected successful issuance');
      serviceMocks.getGitLabToken.mockResolvedValueOnce({
        success: true,
        token: 'refreshed-gitlab-pat',
        instanceUrl: 'https://gitlab.com',
      });

      await expect(
        service.redeemGitLabSessionCapability({
          capability: issued.capability,
          outboundContainerId,
          requestMethod,
          requestUrl,
        })
      ).resolves.toEqual({ success: true, headers });
    }
  );

  it.each([
    [
      'GET',
      'https://gitlab.example.com:8443/gitlab/acme/platform/widgets.git/info/refs?service=git-upload-pack',
      {
        authorization: `Basic ${Buffer.from('oauth2:refreshed-self-managed-token').toString('base64')}`,
      },
    ],
    [
      'GET',
      'https://gitlab.example.com:8443/gitlab/api/v4/projects/acme%2Fplatform%2Fwidgets/merge_requests/42/changes',
      { authorization: 'Bearer refreshed-self-managed-token' },
    ],
  ] as const)(
    'issues and redeems a nested self-managed GitLab capability for %s %s',
    async (requestMethod, requestUrl, headers) => {
      serviceMocks.findGitLabIntegration.mockResolvedValue({
        success: true,
        integrationId: 'ef2eb5c7-27ce-4f43-b6d3-8f282abc145c',
        integrationType: 'oauth',
        accountId: '42',
        accountLogin: 'octocat',
        metadata: {
          access_token: 'self-managed-token',
          auth_type: 'oauth',
          gitlab_instance_url: 'https://gitlab.example.com:8443/gitlab',
        },
      });
      serviceMocks.getGitLabToken.mockResolvedValueOnce({
        success: true,
        token: 'self-managed-token',
        instanceUrl: 'https://gitlab.example.com:8443/gitlab',
      });
      const service = createService();
      const issued = await service.issueGitLabSessionCapability({
        gitUrl: 'https://gitlab.example.com:8443/gitlab/acme/platform/widgets.git',
        userId: 'user_1',
        outboundContainerId,
      });
      if (!issued.success) throw new Error('Expected successful issuance');
      serviceMocks.getGitLabToken.mockResolvedValueOnce({
        success: true,
        token: 'refreshed-self-managed-token',
        instanceUrl: 'https://gitlab.example.com:8443/gitlab',
      });

      await expect(
        service.redeemGitLabSessionCapability({
          capability: issued.capability,
          outboundContainerId,
          requestMethod,
          requestUrl,
        })
      ).resolves.toEqual({ success: true, headers });
    }
  );

  it.each([
    ['https://gitlab.example.com:8443/api/v4/projects/42/issues', 'invalid_upstream_request'],
    [
      'https://gitlab.example.com:8443/acme/platform/widgets.git/info/refs?service=git-upload-pack',
      'repository_mismatch',
    ],
  ] as const)('rejects self-managed base-path escape %s', async (requestUrl, reason) => {
    serviceMocks.findGitLabIntegration.mockResolvedValue({
      success: true,
      integrationId: 'ef2eb5c7-27ce-4f43-b6d3-8f282abc145c',
      integrationType: 'oauth',
      accountId: '42',
      accountLogin: 'octocat',
      metadata: {
        access_token: 'self-managed-token',
        auth_type: 'oauth',
        gitlab_instance_url: 'https://gitlab.example.com:8443/gitlab',
      },
    });
    serviceMocks.getGitLabToken.mockResolvedValueOnce({
      success: true,
      token: 'self-managed-token',
      instanceUrl: 'https://gitlab.example.com:8443/gitlab',
    });
    const service = createService();
    const issued = await service.issueGitLabSessionCapability({
      gitUrl: 'https://gitlab.example.com:8443/gitlab/acme/platform/widgets.git',
      userId: 'user_1',
      outboundContainerId,
    });
    if (!issued.success) throw new Error('Expected successful issuance');
    serviceMocks.findGitLabIntegration.mockClear();

    await expect(
      service.redeemGitLabSessionCapability({
        capability: issued.capability,
        outboundContainerId,
        requestMethod: 'GET',
        requestUrl,
      })
    ).resolves.toEqual({ success: false, reason });
    expect(serviceMocks.findGitLabIntegration).not.toHaveBeenCalled();
  });

  it.each([
    [
      'https://sibling.example.com/acme/platform/widgets.git/info/refs?service=git-upload-pack',
      'upstream_origin_not_allowed',
    ],
    [
      'https://gitlab.example.com/acme/platform/sibling.git/info/refs?service=git-upload-pack',
      'repository_mismatch',
    ],
  ] as const)('rejects self-managed sibling scope %s', async (requestUrl, reason) => {
    serviceMocks.findGitLabIntegration.mockResolvedValue({
      success: true,
      integrationId: 'ef2eb5c7-27ce-4f43-b6d3-8f282abc145c',
      integrationType: 'oauth',
      accountId: '42',
      accountLogin: 'octocat',
      metadata: {
        access_token: 'self-managed-token',
        auth_type: 'oauth',
        gitlab_instance_url: 'https://gitlab.example.com',
      },
    });
    serviceMocks.getGitLabToken.mockResolvedValueOnce({
      success: true,
      token: 'self-managed-token',
      instanceUrl: 'https://gitlab.example.com',
    });
    const service = createService();
    const issued = await service.issueGitLabSessionCapability({
      gitUrl: 'https://gitlab.example.com/acme/platform/widgets.git',
      userId: 'user_1',
      outboundContainerId,
    });
    if (!issued.success) throw new Error('Expected successful issuance');
    serviceMocks.findGitLabIntegration.mockClear();

    await expect(
      service.redeemGitLabSessionCapability({
        capability: issued.capability,
        outboundContainerId,
        requestMethod: 'GET',
        requestUrl,
      })
    ).resolves.toEqual({ success: false, reason });
    expect(serviceMocks.findGitLabIntegration).not.toHaveBeenCalled();
  });

  it('returns a sanitized declared failure when the capability key is invalid', async () => {
    const service = new GitTokenRPCEntrypoint(
      {} as ExecutionContext,
      {
        SCM_SESSION_CAPABILITY_ENCRYPTION_KEY: 'not-a-valid-key',
      } as unknown as CloudflareEnv
    );

    await expect(
      service.issueGitLabSessionCapability({
        gitUrl: 'https://gitlab.com/acme/widgets.git',
        userId: 'user_1',
        outboundContainerId,
      })
    ).resolves.toEqual({ success: false, reason: 'capability_configuration_error' });
  });

  it('does not expose a PAT during issuance', async () => {
    serviceMocks.findGitLabIntegration.mockResolvedValue({
      success: true,
      integrationId: 'ef2eb5c7-27ce-4f43-b6d3-8f282abc145c',
      integrationType: 'pat',
      accountId: '42',
      accountLogin: 'octocat',
      metadata: { access_token: 'gitlab-pat-token', auth_type: 'pat' },
    });
    serviceMocks.getGitLabToken.mockResolvedValueOnce({
      success: true,
      token: 'gitlab-pat-token',
      instanceUrl: 'https://gitlab.com',
    });

    const result = await createService().issueGitLabSessionCapability({
      gitUrl: 'https://gitlab.com/acme/widgets.git',
      userId: 'user_1',
      outboundContainerId,
    });

    expect(result).toMatchObject({ success: true, authType: 'pat' });
    expect(JSON.stringify(result)).not.toContain('gitlab-pat-token');
  });

  it.each([
    ['GET', 'https://gitlab.com/acme/widgets.git/info/refs?service=git-upload-pack', 'Basic'],
    ['GET', 'https://gitlab.com/acme/widgets.git/info/refs?service=git-receive-pack', 'Basic'],
    ['POST', 'https://gitlab.com/acme/widgets.git/git-upload-pack', 'Basic'],
    ['POST', 'https://gitlab.com/acme/widgets.git/git-receive-pack', 'Basic'],
    ['POST', 'https://gitlab.com/acme/widgets.git/info/lfs/objects/batch', 'Basic'],
    ['POST', 'https://gitlab.com/acme/widgets.git/info/lfs/locks/verify', 'Basic'],
    [
      'GET',
      'https://gitlab.com/api/v4/projects/acme%2Fwidgets/merge_requests/42/changes',
      'Bearer',
    ],
    ['POST', 'https://gitlab.com/api/v4/projects/acme%2Fwidgets/merge_requests/42/notes', 'Bearer'],
    [
      'PUT',
      'https://gitlab.com/api/v4/projects/acme%2Fwidgets/merge_requests/42/notes/123',
      'Bearer',
    ],
    [
      'POST',
      'https://gitlab.com/api/v4/projects/acme%2Fwidgets/merge_requests/42/discussions',
      'Bearer',
    ],
  ] as const)('redeems allowed GitLab request %s %s', async (requestMethod, requestUrl, scheme) => {
    const service = createService();
    const issued = await service.issueGitLabSessionCapability({
      gitUrl: 'https://gitlab.com/acme/widgets.git',
      userId: 'user_1',
      outboundContainerId,
    });
    if (!issued.success) throw new Error('Expected successful issuance');
    serviceMocks.findGitLabIntegration.mockClear();
    serviceMocks.getGitLabToken.mockResolvedValueOnce({
      success: true,
      token: 'refreshed-gitlab-token',
      instanceUrl: 'https://gitlab.com',
    });

    const result = await service.redeemGitLabSessionCapability({
      capability: issued.capability,
      outboundContainerId,
      requestMethod,
      requestUrl,
    });

    const authorization =
      scheme === 'Basic'
        ? `Basic ${Buffer.from('oauth2:refreshed-gitlab-token').toString('base64')}`
        : 'Bearer refreshed-gitlab-token';
    expect(result).toEqual({ success: true, headers: { authorization } });
    expect(serviceMocks.findGitLabIntegration).toHaveBeenCalledWith(
      { userId: 'user_1' },
      'ef2eb5c7-27ce-4f43-b6d3-8f282abc145c'
    );
  });

  it.each([
    ['GET', 'https://gitlab.com/api/v4/projects?membership=true', 'invalid_upstream_request'],
    ['POST', 'https://gitlab.com/api/graphql', 'invalid_upstream_request'],
    ['GET', 'https://gitlab.com/api/v4/projects/acme%2Fother/issues', 'repository_mismatch'],
  ] as const)(
    'does not redeem a GitLab capability for an API request outside its project: %s %s',
    async (requestMethod, requestUrl, reason) => {
      const service = createService();
      const issued = await service.issueGitLabSessionCapability({
        gitUrl: 'https://gitlab.com/acme/widgets.git',
        userId: 'user_1',
        outboundContainerId,
      });
      if (!issued.success) throw new Error('Expected successful issuance');
      serviceMocks.findGitLabIntegration.mockClear();

      await expect(
        service.redeemGitLabSessionCapability({
          capability: issued.capability,
          outboundContainerId,
          requestMethod,
          requestUrl,
        })
      ).resolves.toEqual({ success: false, reason });
      expect(serviceMocks.findGitLabIntegration).not.toHaveBeenCalled();
    }
  );

  it.each([
    [
      'GET',
      'https://other.example.com/acme/widgets.git/info/refs?service=git-upload-pack',
      'upstream_origin_not_allowed',
    ],
    [
      'GET',
      'https://gitlab.com/acme/other.git/info/refs?service=git-upload-pack',
      'repository_mismatch',
    ],
    ['GET', 'https://gitlab.com/acme/widgets/settings', 'invalid_upstream_request'],
    ['GET', 'https://gitlab.com/oauth/authorize', 'invalid_upstream_request'],
    ['GET', 'https://gitlab.com/users/sign_in', 'invalid_upstream_request'],
    [
      'GET',
      'https://gitlab.com/acme%2Fwidgets.git/info/refs?service=git-upload-pack',
      'invalid_upstream_url',
    ],
    ['CONNECT', 'https://gitlab.com/api/v4/projects', 'invalid_upstream_request'],
    [
      'GET',
      'https://gitlab.com/api/v4/projects/acme%2Fwidgets/variables',
      'invalid_upstream_request',
    ],
    [
      'PUT',
      'https://gitlab.com/api/v4/projects/acme%2Fwidgets/merge_requests/42/merge',
      'invalid_upstream_request',
    ],
  ] as const)('rejects unsafe GitLab request %s %s', async (requestMethod, requestUrl, reason) => {
    const service = createService();
    const issued = await service.issueGitLabSessionCapability({
      gitUrl: 'https://gitlab.com/acme/widgets.git',
      userId: 'user_1',
      outboundContainerId,
    });
    if (!issued.success) throw new Error('Expected successful issuance');
    serviceMocks.findGitLabIntegration.mockClear();

    await expect(
      service.redeemGitLabSessionCapability({
        capability: issued.capability,
        outboundContainerId,
        requestMethod,
        requestUrl,
      })
    ).resolves.toEqual({ success: false, reason });
    expect(serviceMocks.findGitLabIntegration).not.toHaveBeenCalled();
  });

  it('fails closed if the pinned GitLab integration disappears', async () => {
    const service = createService();
    const issued = await service.issueGitLabSessionCapability({
      gitUrl: 'https://gitlab.com/acme/widgets.git',
      userId: 'user_1',
      outboundContainerId,
    });
    if (!issued.success) throw new Error('Expected successful issuance');
    serviceMocks.findGitLabIntegration.mockResolvedValueOnce({
      success: false,
      reason: 'no_integration_found',
    });
    serviceMocks.getGitLabToken.mockClear();

    await expect(
      service.redeemGitLabSessionCapability({
        capability: issued.capability,
        outboundContainerId,
        requestMethod: 'GET',
        requestUrl: 'https://gitlab.com/api/v4/projects/acme%2Fwidgets/merge_requests/42/changes',
      })
    ).resolves.toEqual({ success: false, reason: 'source_unavailable' });
    expect(serviceMocks.getGitLabToken).not.toHaveBeenCalled();
  });

  it('fails closed if the pinned GitLab integration source identity drifts', async () => {
    const service = createService();
    const issued = await service.issueGitLabSessionCapability({
      gitUrl: 'https://gitlab.com/acme/widgets.git',
      userId: 'user_1',
      outboundContainerId,
    });
    if (!issued.success) throw new Error('Expected successful issuance');
    serviceMocks.findGitLabIntegration.mockResolvedValueOnce({
      success: true,
      integrationId: 'ef2eb5c7-27ce-4f43-b6d3-8f282abc145c',
      integrationType: 'pat',
      accountId: '42',
      accountLogin: 'octocat',
      metadata: { access_token: 'gitlab-pat-token', auth_type: 'pat' },
    });

    await expect(
      service.redeemGitLabSessionCapability({
        capability: issued.capability,
        outboundContainerId,
        requestMethod: 'GET',
        requestUrl: 'https://gitlab.com/api/v4/projects/acme%2Fwidgets/merge_requests/42/changes',
      })
    ).resolves.toEqual({ success: false, reason: 'identity_mismatch' });
    expect(serviceMocks.getGitLabToken).toHaveBeenCalledOnce();
  });
});
