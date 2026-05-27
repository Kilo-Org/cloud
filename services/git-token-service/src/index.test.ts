import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveGitLabRuntimeToken } from './gitlab-runtime-token-resolver.js';
import type { AuthorizedGitLabIntegration } from './gitlab-lookup-service.js';

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
