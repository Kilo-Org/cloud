import { describe, expect, it, vi } from 'vitest';
import { assertRepositoryAccessBeforeSessionCreation } from './validate-repository-access.js';

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
    const getTokenForRepo = vi.fn().mockResolvedValue({
      success: true,
      token: 'token',
      installationId: '123',
      integrationId: '123e4567-e89b-12d3-a456-426614174022',
      integrationOwner: { type: 'org', id: '123e4567-e89b-12d3-a456-426614174030' },
      accountLogin: 'acme',
      appType: 'standard',
    });
    const orgId = '123e4567-e89b-12d3-a456-426614174030';
    const expectedIntegrationId = '123e4567-e89b-12d3-a456-426614174022';

    await expect(
      assertRepositoryAccessBeforeSessionCreation({
        env: { GIT_TOKEN_SERVICE: { getTokenForRepo } } as never,
        userId: 'user-1',
        orgId,
        repository: {
          type: 'github',
          repo: 'acme/repo',
          githubIntegrationId: expectedIntegrationId,
        },
      })
    ).resolves.toEqual({
      kind: 'resolved',
      integrationId: expectedIntegrationId,
      integrationOwner: { type: 'org', id: orgId },
      instanceUrl: 'https://github.com',
    });
    expect(getTokenForRepo).toHaveBeenCalledWith({
      githubRepo: 'acme/repo',
      userId: 'user-1',
      orgId,
      expectedIntegrationId,
    });
  });

  it.each(['pin', 'resolved-owner'] as const)(
    'returns a retryable compatibility error for an old producer with a %s',
    async selection => {
      const integrationId = '123e4567-e89b-12d3-a456-426614174022';
      const getTokenForRepo = vi.fn().mockResolvedValue({
        success: true,
        token: 'old-token',
        installationId: '123',
        accountLogin: 'acme',
        appType: 'standard',
      });
      await expect(
        assertRepositoryAccessBeforeSessionCreation({
          env: { GIT_TOKEN_SERVICE: { getTokenForRepo } } as never,
          userId: 'user-1',
          orgId: 'billing-org',
          repository: {
            type: 'github',
            repo: 'acme/repo',
            ...(selection === 'pin'
              ? { githubIntegrationId: integrationId }
              : {
                  resolvedIdentity: {
                    kind: 'resolved',
                    integrationId,
                    integrationOwner: { type: 'user', id: 'user-1' },
                    instanceUrl: 'https://github.com',
                  },
                }),
          },
        })
      ).rejects.toMatchObject({
        code: 'SERVICE_UNAVAILABLE',
        message: 'GitHub repository authorization failed (service_compatibility_error)',
      });
    }
  );

  it('rejects an integration mismatch before session allocation', async () => {
    const getTokenForRepo = vi.fn().mockResolvedValue({
      success: false,
      reason: 'integration_mismatch',
    });

    await expect(
      assertRepositoryAccessBeforeSessionCreation({
        env: { GIT_TOKEN_SERVICE: { getTokenForRepo } } as never,
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

describe('GitLab session creation preflight', () => {
  const pin = '123e4567-e89b-12d3-a456-426614174022';
  const url = 'https://gitlab.example.com/gitlab/group/sub/repo.git';

  it.each([
    { orgId: undefined, gitlabIntegrationId: undefined },
    { orgId: undefined, gitlabIntegrationId: pin },
    { orgId: 'org-1', gitlabIntegrationId: undefined },
    { orgId: 'org-1', gitlabIntegrationId: pin },
  ])('resolves exact owner, URL, and optional pin %j', async ({ orgId, gitlabIntegrationId }) => {
    const getGitLabToken = vi.fn(
      async (params: { orgId?: string; expectedIntegrationId?: string; repositoryUrl?: string }) =>
        params.orgId === orgId &&
        params.expectedIntegrationId === gitlabIntegrationId &&
        params.repositoryUrl === url
          ? {
              success: true,
              token: 'private-token',
              instanceUrl: 'https://gitlab.example.com/gitlab',
              integrationId: pin,
              glabIsOAuth2: true,
            }
          : { success: false, reason: 'integration_mismatch' }
    );
    const result = await assertRepositoryAccessBeforeSessionCreation({
      env: { GIT_TOKEN_SERVICE: { getGitLabToken } } as never,
      userId: 'oauth/user',
      orgId,
      repository: { type: 'gitlab', url, gitlabIntegrationId },
    });
    expect(result).toEqual({
      kind: 'resolved',
      integrationId: pin,
      integrationOwner: orgId ? { type: 'org', id: orgId } : { type: 'user', id: 'oauth/user' },
      instanceUrl: 'https://gitlab.example.com/gitlab',
    });
    expect(JSON.stringify(result)).not.toContain('private-token');
  });

  it.each([
    ['integration_mismatch', 'BAD_REQUEST'],
    ['ambiguous_integration', 'BAD_REQUEST'],
    ['no_integration_found', 'BAD_REQUEST'],
    ['not_authorized', 'BAD_REQUEST'],
    ['no_project_token', 'BAD_REQUEST'],
    ['token_refresh_failed', 'SERVICE_UNAVAILABLE'],
    ['project_lookup_failed', 'SERVICE_UNAVAILABLE'],
    ['service_not_configured', 'SERVICE_UNAVAILABLE'],
    ['rpc_error', 'SERVICE_UNAVAILABLE'],
    ['database_not_configured', 'SERVICE_UNAVAILABLE'],
  ])('preserves %s as %s', async (reason, code) => {
    await expect(
      assertRepositoryAccessBeforeSessionCreation({
        env: {
          GIT_TOKEN_SERVICE: {
            getGitLabToken: vi.fn().mockResolvedValue({ success: false, reason }),
          },
        } as never,
        userId: 'user-1',
        repository: { type: 'gitlab', url, gitlabIntegrationId: pin },
      })
    ).rejects.toMatchObject({
      code,
      message: `GitLab repository authorization failed (${reason})`,
    });
  });
});

describe('Bitbucket session creation preflight', () => {
  it('validates organization sessions against the organization-owned integration', async () => {
    const getBitbucketToken = vi.fn().mockResolvedValue({
      success: true,
      token: 'token',
      integrationId: '123e4567-e89b-12d3-a456-426614174022',
    });
    const orgId = '123e4567-e89b-12d3-a456-426614174030';

    await expect(
      assertRepositoryAccessBeforeSessionCreation({
        env: { GIT_TOKEN_SERVICE: { getBitbucketToken } } as never,
        userId: 'user-1',
        orgId,
        repository,
      })
    ).resolves.toEqual({
      kind: 'resolved',
      integrationId: '123e4567-e89b-12d3-a456-426614174022',
      integrationOwner: { type: 'org', id: orgId },
      instanceUrl: 'https://bitbucket.org',
    });
    expect(getBitbucketToken).toHaveBeenCalledWith({
      userId: 'user-1',
      orgId,
      workspaceUuid: repository.workspaceUuid,
      repositoryUuid: repository.repositoryUuid,
      repositoryUrl: repository.url,
    });
  });

  it('forwards an expected integration id when the repository carries one', async () => {
    const getBitbucketToken = vi.fn().mockResolvedValue({
      success: true,
      token: 'token',
      integrationId: '123e4567-e89b-12d3-a456-426614174022',
    });
    const orgId = '123e4567-e89b-12d3-a456-426614174030';
    const integrationId = '123e4567-e89b-12d3-a456-426614174022';

    await expect(
      assertRepositoryAccessBeforeSessionCreation({
        env: { GIT_TOKEN_SERVICE: { getBitbucketToken } } as never,
        userId: 'user-1',
        orgId,
        repository: { ...repository, bitbucketIntegrationId: integrationId },
      })
    ).resolves.toEqual({
      kind: 'resolved',
      integrationId: '123e4567-e89b-12d3-a456-426614174022',
      integrationOwner: { type: 'org', id: orgId },
      instanceUrl: 'https://bitbucket.org',
    });
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
    const getBitbucketToken = vi.fn().mockResolvedValue({
      success: true,
      token: 'token',
      integrationId: '123e4567-e89b-12d3-a456-426614174022',
    });

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

  it('rejects a stale Bitbucket pin without selecting a replacement', async () => {
    await expect(
      assertRepositoryAccessBeforeSessionCreation({
        env: {
          GIT_TOKEN_SERVICE: {
            getBitbucketToken: vi
              .fn()
              .mockResolvedValue({ success: false, reason: 'integration_mismatch' }),
          },
        } as never,
        userId: 'user-1',
        orgId: '123e4567-e89b-12d3-a456-426614174030',
        repository: {
          ...repository,
          bitbucketIntegrationId: '123e4567-e89b-12d3-a456-426614174022',
        },
      })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Bitbucket repository authorization failed (integration_mismatch)',
    });
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
