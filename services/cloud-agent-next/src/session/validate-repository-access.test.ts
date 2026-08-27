import { describe, expect, it, vi } from 'vitest';
import {
  assertRepositoryAccessBeforeSessionCreation,
  canonicalizeRepositoryBeforeSessionCreation,
} from './validate-repository-access.js';
import { sessionCreateIntentFingerprint } from './session-registration.js';

const githubIntegrationId = '123e4567-e89b-12d3-a456-426614174022';

function githubResolution(platformIntegrationId = githubIntegrationId) {
  return {
    success: true as const,
    token: 'token',
    platformIntegrationId,
    installationId: '123',
    accountLogin: 'acme',
    appType: 'standard' as const,
  };
}

function githubRequest(overrides: Record<string, unknown> = {}) {
  return {
    initialTurn: { type: 'prompt' as const, prompt: 'Build it' },
    agent: { mode: 'code', model: 'model' },
    repository: { type: 'github' as const, repo: 'acme/repo' },
    ...overrides,
  };
}

const repository = {
  type: 'bitbucket' as const,
  url: 'https://bitbucket.org/acme/repo.git',
  workspaceUuid: '123e4567-e89b-12d3-a456-426614174020',
  repositoryUuid: '123e4567-e89b-12d3-a456-426614174021',
};

describe('GitHub session creation preflight', () => {
  it('canonicalizes an unpinned GitHub repository to the live resolved integration', async () => {
    const getTokenForRepo = vi.fn().mockResolvedValue(githubResolution());

    await expect(
      canonicalizeRepositoryBeforeSessionCreation({
        env: { GIT_TOKEN_SERVICE: { getTokenForRepo } } as never,
        userId: 'user-1',
        request: githubRequest(),
      })
    ).resolves.toMatchObject({
      repository: { type: 'github', repo: 'acme/repo', githubIntegrationId },
    });
    expect(getTokenForRepo).toHaveBeenCalledWith({
      githubRepo: 'acme/repo',
      userId: 'user-1',
    });
  });

  it('includes the canonical integration in the operation fingerprint', async () => {
    const getTokenForRepo = vi.fn().mockResolvedValue(githubResolution());
    const canonical = await canonicalizeRepositoryBeforeSessionCreation({
      env: { GIT_TOKEN_SERVICE: { getTokenForRepo } } as never,
      userId: 'user-1',
      request: githubRequest(),
    });
    const alternate = {
      ...canonical,
      repository: {
        ...canonical.repository,
        githubIntegrationId: '123e4567-e89b-12d3-a456-426614174099',
      },
    };

    expect(await sessionCreateIntentFingerprint(canonical)).not.toBe(
      await sessionCreateIntentFingerprint(alternate)
    );
  });

  it('canonicalizes a pinned GitHub repository against the exact integration', async () => {
    const getTokenForRepo = vi.fn().mockResolvedValue(githubResolution());
    const orgId = '123e4567-e89b-12d3-a456-426614174030';

    await expect(
      canonicalizeRepositoryBeforeSessionCreation({
        env: { GIT_TOKEN_SERVICE: { getTokenForRepo } } as never,
        userId: 'user-1',
        orgId,
        request: githubRequest({
          repository: { type: 'github', repo: 'acme/repo', githubIntegrationId },
        }),
      })
    ).resolves.toMatchObject({ repository: { githubIntegrationId } });
    expect(getTokenForRepo).toHaveBeenCalledWith({
      githubRepo: 'acme/repo',
      userId: 'user-1',
      orgId,
      expectedIntegrationId: githubIntegrationId,
    });
  });

  it('rejects an integration mismatch before session allocation', async () => {
    const getTokenForRepo = vi.fn().mockResolvedValue({
      success: false,
      reason: 'integration_mismatch',
    });

    await expect(
      canonicalizeRepositoryBeforeSessionCreation({
        env: { GIT_TOKEN_SERVICE: { getTokenForRepo } } as never,
        userId: 'user-1',
        request: githubRequest({
          repository: { type: 'github', repo: 'acme/repo', githubIntegrationId },
        }),
      })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'GitHub repository authorization failed (integration_mismatch)',
    });
  });

  it.each([
    ['ambiguous_installation', 'BAD_REQUEST'],
    ['repository_not_installed', 'BAD_REQUEST'],
    ['temporarily_unavailable', 'SERVICE_UNAVAILABLE'],
    ['database_not_configured', 'SERVICE_UNAVAILABLE'],
  ])('maps %s to %s before allocation', async (reason, code) => {
    const getTokenForRepo = vi.fn().mockResolvedValue({ success: false, reason });

    await expect(
      canonicalizeRepositoryBeforeSessionCreation({
        env: { GIT_TOKEN_SERVICE: { getTokenForRepo } } as never,
        userId: 'user-1',
        request: githubRequest(),
      })
    ).rejects.toMatchObject({ code });
  });

  it('inherits the source GitHub pin and accepts repository case differences', async () => {
    const getTokenForRepo = vi.fn().mockResolvedValue(githubResolution());
    const getMetadata = vi.fn().mockResolvedValue({
      repository: { type: 'github', repo: 'Acme/Repo', githubIntegrationId },
    });
    const env = {
      SESSION_INGEST: {
        resolveCloudAgentRootSessionForKiloSession: vi.fn().mockResolvedValue({
          cloudAgentSessionId: 'agent-source',
          repository: { type: 'github', repo: 'Acme/Repo' },
        }),
      },
      CLOUD_AGENT_SESSION: {
        idFromName: vi.fn(name => name),
        get: vi.fn(() => ({ getMetadata })),
      },
      GIT_TOKEN_SERVICE: { getTokenForRepo },
    };

    await expect(
      canonicalizeRepositoryBeforeSessionCreation({
        env: env as never,
        userId: 'user-1',
        request: githubRequest({
          repository: { type: 'github', repo: 'acme/repo' },
          clone: { cloneFromKiloSessionId: 'ses_12345678901234567890123456' },
        }),
      })
    ).resolves.toMatchObject({
      repository: { repo: 'Acme/Repo', githubIntegrationId },
    });
    expect(getTokenForRepo).toHaveBeenCalledWith({
      githubRepo: 'Acme/Repo',
      userId: 'user-1',
      expectedIntegrationId: githubIntegrationId,
    });
  });

  it('continues from an authorized remote CLI source without requiring a Cloud Agent mapping', async () => {
    const getTokenForRepo = vi.fn().mockResolvedValue(githubResolution());
    const getMetadata = vi.fn();
    const env = {
      SESSION_INGEST: {
        resolveAuthorizedSessionSource: vi.fn().mockResolvedValue({
          organizationId: null,
          repository: { type: 'github', repo: 'Acme/Repo' },
        }),
      },
      CLOUD_AGENT_SESSION: {
        idFromName: vi.fn(),
        get: vi.fn(() => ({ getMetadata })),
      },
      GIT_TOKEN_SERVICE: { getTokenForRepo },
    };

    await expect(
      canonicalizeRepositoryBeforeSessionCreation({
        env: env as never,
        userId: 'user-1',
        request: githubRequest({
          clone: { cloneFromKiloSessionId: 'ses_12345678901234567890123456' },
        }),
      })
    ).resolves.toMatchObject({ repository: { repo: 'Acme/Repo', githubIntegrationId } });
    expect(getMetadata).not.toHaveBeenCalled();
  });

  it('falls back to the legacy resolver when an old deployment rejects the canonical RPC method', async () => {
    const getTokenForRepo = vi.fn().mockResolvedValue(githubResolution());
    const resolveAuthorizedSessionSource = vi
      .fn()
      .mockRejectedValue(
        new TypeError(
          'The RPC receiver does not implement the method "resolveAuthorizedSessionSource".'
        )
      );
    const resolveCloudAgentRootSessionForKiloSession = vi.fn().mockResolvedValue({
      cloudAgentSessionId: 'agent-source',
      repository: { type: 'github', repo: 'Acme/Repo' },
    });
    const env = {
      SESSION_INGEST: {
        resolveAuthorizedSessionSource,
        resolveCloudAgentRootSessionForKiloSession,
      },
      CLOUD_AGENT_SESSION: {
        idFromName: vi.fn(name => name),
        get: vi.fn(() => ({
          getMetadata: vi.fn().mockResolvedValue({
            repository: { type: 'github', repo: 'Acme/Repo', githubIntegrationId },
          }),
        })),
      },
      GIT_TOKEN_SERVICE: { getTokenForRepo },
    };

    await expect(
      canonicalizeRepositoryBeforeSessionCreation({
        env: env as never,
        userId: 'user-1',
        request: githubRequest({
          clone: { cloneFromKiloSessionId: 'ses_12345678901234567890123456' },
        }),
      })
    ).resolves.toMatchObject({
      repository: { repo: 'Acme/Repo', githubIntegrationId },
    });
    expect(resolveAuthorizedSessionSource).toHaveBeenCalledOnce();
    expect(resolveCloudAgentRootSessionForKiloSession).toHaveBeenCalledOnce();
  });

  it.each([
    new Error('Provider failed while calling resolveAuthorizedSessionSource'),
    new TypeError('The RPC receiver does not implement the method "anotherMethod".'),
  ])('does not mask a true canonical resolver failure: %s', async error => {
    const legacyResolver = vi.fn();
    const getTokenForRepo = vi.fn();
    const env = {
      SESSION_INGEST: {
        resolveAuthorizedSessionSource: vi.fn().mockRejectedValue(error),
        resolveCloudAgentRootSessionForKiloSession: legacyResolver,
      },
      GIT_TOKEN_SERVICE: { getTokenForRepo },
    };

    await expect(
      canonicalizeRepositoryBeforeSessionCreation({
        env: env as never,
        userId: 'user-1',
        request: githubRequest({
          clone: { cloneFromKiloSessionId: 'ses_12345678901234567890123456' },
        }),
      })
    ).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: 'GitHub repository authorization failed (source_unavailable)',
    });
    expect(legacyResolver).not.toHaveBeenCalled();
    expect(getTokenForRepo).not.toHaveBeenCalled();
  });

  it('rejects a source organization mismatch before live GitHub resolution', async () => {
    const getTokenForRepo = vi.fn();
    const env = {
      SESSION_INGEST: {
        resolveAuthorizedSessionSource: vi.fn().mockResolvedValue({
          organizationId: '123e4567-e89b-12d3-a456-426614174099',
          repository: { type: 'github', repo: 'acme/repo' },
        }),
      },
      GIT_TOKEN_SERVICE: { getTokenForRepo },
    };

    await expect(
      canonicalizeRepositoryBeforeSessionCreation({
        env: env as never,
        userId: 'user-1',
        orgId: '123e4567-e89b-12d3-a456-426614174030',
        request: githubRequest({
          clone: { cloneFromKiloSessionId: 'ses_12345678901234567890123456' },
        }),
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'organization_mismatch' });
    expect(getTokenForRepo).not.toHaveBeenCalled();
  });

  it('preserves indistinguishable source access denial before live GitHub resolution', async () => {
    const getTokenForRepo = vi.fn();
    const env = {
      SESSION_INGEST: {
        resolveAuthorizedSessionSource: vi.fn().mockResolvedValue(null),
      },
      GIT_TOKEN_SERVICE: { getTokenForRepo },
    };

    await expect(
      canonicalizeRepositoryBeforeSessionCreation({
        env: env as never,
        userId: 'user-1',
        request: githubRequest({
          clone: { cloneFromKiloSessionId: 'ses_12345678901234567890123456' },
        }),
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'source_access_denied' });
    expect(getTokenForRepo).not.toHaveBeenCalled();
  });

  it.each([
    [
      'repository',
      { type: 'github', repo: 'Acme/Repo', githubIntegrationId },
      { type: 'github', repo: 'other/repo', githubIntegrationId },
      'clone_repository_mismatch',
    ],
    [
      'integration',
      { type: 'github', repo: 'acme/repo', githubIntegrationId },
      {
        type: 'github',
        repo: 'Acme/Repo',
        githubIntegrationId: '123e4567-e89b-12d3-a456-426614174099',
      },
      'clone_integration_mismatch',
    ],
  ])(
    'rejects a clone %s mismatch before live resolution',
    async (_kind, sourceRepo, submitted, message) => {
      const getTokenForRepo = vi.fn();
      const env = {
        SESSION_INGEST: {
          resolveCloudAgentRootSessionForKiloSession: vi.fn().mockResolvedValue({
            cloudAgentSessionId: 'agent-source',
            repository: { type: 'github', repo: 'Acme/Repo' },
          }),
        },
        CLOUD_AGENT_SESSION: {
          idFromName: vi.fn(name => name),
          get: vi.fn(() => ({
            getMetadata: vi.fn().mockResolvedValue({ repository: sourceRepo }),
          })),
        },
        GIT_TOKEN_SERVICE: { getTokenForRepo },
      };

      await expect(
        canonicalizeRepositoryBeforeSessionCreation({
          env: env as never,
          userId: 'user-1',
          request: githubRequest({
            repository: submitted,
            clone: { cloneFromKiloSessionId: 'ses_12345678901234567890123456' },
          }),
        })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST', message });
      expect(getTokenForRepo).not.toHaveBeenCalled();
    }
  );

  it('uses live resolution for a legacy source without an integration pin', async () => {
    const getTokenForRepo = vi.fn().mockResolvedValue(githubResolution());
    const env = {
      SESSION_INGEST: {
        resolveCloudAgentRootSessionForKiloSession: vi.fn().mockResolvedValue({
          cloudAgentSessionId: 'agent-source',
        }),
      },
      CLOUD_AGENT_SESSION: {
        idFromName: vi.fn(name => name),
        get: vi.fn(() => ({
          getMetadata: vi.fn().mockResolvedValue({
            repository: { type: 'github', repo: 'acme/repo' },
          }),
        })),
      },
      GIT_TOKEN_SERVICE: { getTokenForRepo },
    };

    await expect(
      canonicalizeRepositoryBeforeSessionCreation({
        env: env as never,
        userId: 'user-1',
        request: githubRequest({
          clone: { cloneFromKiloSessionId: 'ses_12345678901234567890123456' },
        }),
      })
    ).resolves.toMatchObject({ repository: { githubIntegrationId } });
    expect(getTokenForRepo).toHaveBeenCalledWith({ githubRepo: 'acme/repo', userId: 'user-1' });
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
