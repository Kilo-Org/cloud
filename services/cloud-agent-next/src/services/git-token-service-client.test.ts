import { describe, expect, it, vi } from 'vitest';
import { logger } from '../logger.js';
import type { GitTokenService } from '../types.js';
import {
  issueCloudAgentGitHubSessionCapability,
  issueCloudAgentBitbucketSessionCapability,
  resolveGitHubTokenForRepo,
  issueCloudAgentGitLabSessionCapability,
  resolveCloudAgentGitHubAuthForRepo,
  resolveManagedBitbucketToken,
  resolveManagedGitLabToken,
} from './git-token-service-client.js';

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withFields: vi.fn(() => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() })),
  },
}));

function createGitTokenService() {
  return {
    getTokenForRepo: vi.fn(),
    getToken: vi.fn(),
    getGitLabToken: vi.fn(),
    issueGitHubSessionCapability: vi.fn(),
    redeemGitHubSessionCapability: vi.fn(),
    issueGitLabSessionCapability: vi.fn(),
    redeemGitLabSessionCapability: vi.fn(),
    issueKiloSessionCapability: vi.fn(),
    redeemKiloSessionCapability: vi.fn(),
  } satisfies GitTokenService;
}

function createEnv(service: Partial<GitTokenService>) {
  return { GIT_TOKEN_SERVICE: service as GitTokenService };
}

describe('authorized identity producer/consumer contract', () => {
  const integrationId = '123e4567-e89b-12d3-a456-426614174022';
  const integrationOwner = { type: 'user' as const, id: 'oauth/user' };
  const githubParams = {
    githubRepo: 'acme/repo',
    userId: 'oauth/user',
    orgId: 'billing-org',
    expectedIntegrationId: integrationId,
    expectedIntegrationOwner: integrationOwner,
    allowUserAuthorization: true,
    outboundContainerId: 'container-1',
  };

  it.each(['raw', 'managed', 'capability', 'legacy-capability'] as const)(
    'retains the resolved Personal owner and organization context through %s',
    async mode => {
      const response = {
        success: true as const,
        token: 'raw-token',
        githubToken: 'managed-token',
        capability: 'opaque-capability',
        installationId: '123',
        appType: 'standard' as const,
        accountLogin: 'acme',
        integrationId,
        integrationOwner,
        source: 'installation' as const,
        gitAuthor: { name: 'bot', email: 'bot@example.com' },
      };
      const authorized = async (params: Parameters<GitTokenService['getTokenForRepo']>[0]) =>
        params.orgId === githubParams.orgId &&
        params.expectedIntegrationId === integrationId &&
        params.expectedIntegrationOwner?.type === 'user' &&
        params.expectedIntegrationOwner.id === integrationOwner.id
          ? response
          : { success: false as const, reason: 'integration_mismatch' as const };
      const env = createEnv({
        getTokenForRepo: authorized,
        ...(mode === 'legacy-capability'
          ? {}
          : {
              getCloudAgentAuthForRepo: authorized,
              issueGitHubSessionCapability: authorized,
            }),
      });
      const result =
        mode === 'raw'
          ? await resolveGitHubTokenForRepo(env, githubParams)
          : mode === 'managed'
            ? await resolveCloudAgentGitHubAuthForRepo(env, githubParams)
            : await issueCloudAgentGitHubSessionCapability(env, githubParams);
      expect(result).toMatchObject({
        success: true,
        value: {
          identity: {
            kind: 'resolved',
            integrationId,
            integrationOwner,
            instanceUrl: 'https://github.com',
          },
        },
      });
    }
  );

  it.each(['gitlab', 'bitbucket'] as const)(
    'retains %s pins through raw and capability responses',
    async provider => {
      const authorized = async (params: { expectedIntegrationId?: string }) =>
        params.expectedIntegrationId === integrationId
          ? {
              success: true,
              token: 'raw-token',
              capability: 'opaque-capability',
              integrationId,
              instanceUrl: 'https://gitlab.example.com/gitlab',
              instanceOrigin: 'https://gitlab.example.com/gitlab',
              instanceHost: 'gitlab.example.com',
              projectPath: 'group/sub/repo',
              gitUrl: 'https://bitbucket.org/group/repo.git',
              authType: 'oauth',
              identity: { accountId: '42', accountLogin: 'actor' },
              glabIsOAuth2: true,
            }
          : { success: false, reason: 'integration_mismatch' };
      const env = createEnv({
        getGitLabToken: vi.fn(authorized),
        issueGitLabSessionCapability: vi.fn(authorized),
        getBitbucketToken: vi.fn(authorized),
        issueBitbucketSessionCapability: vi.fn(authorized),
      } as Partial<GitTokenService>);
      const params = {
        userId: 'oauth/user',
        orgId: 'org-1',
        expectedIntegrationId: integrationId,
        outboundContainerId: 'container-1',
        gitUrl: 'https://gitlab.example.com/gitlab/group/sub/repo.git',
        repositoryUrl: 'https://bitbucket.org/group/repo.git',
        workspaceUuid: '123e4567-e89b-12d3-a456-426614174020',
        repositoryUuid: '123e4567-e89b-12d3-a456-426614174021',
      };
      const raw =
        provider === 'gitlab'
          ? await resolveManagedGitLabToken(env, params)
          : await resolveManagedBitbucketToken(env, params);
      const capability =
        provider === 'gitlab'
          ? await issueCloudAgentGitLabSessionCapability(env, params)
          : await issueCloudAgentBitbucketSessionCapability(env, params);
      expect(raw).toMatchObject({ success: true, token: 'raw-token', integrationId });
      expect(capability).toMatchObject({
        success: true,
        value: { capability: 'opaque-capability', integrationId },
      });
      if (provider === 'gitlab')
        expect(capability).toMatchObject({
          value: { gitUrl: 'https://gitlab.example.com/gitlab/group/sub/repo.git' },
        });
    }
  );
});

describe('GitHub response identity compatibility', () => {
  const integrationId = '123e4567-e89b-12d3-a456-426614174022';
  const integrationOwner = { type: 'user' as const, id: 'oauth/user' };
  const params = {
    githubRepo: 'acme/repo',
    userId: 'oauth/user',
    orgId: 'billing-org',
    allowUserAuthorization: true,
    outboundContainerId: 'container-1',
  };
  const oldResponse = {
    success: true,
    token: 'old-token',
    githubToken: 'old-token',
    capability: 'old-capability',
    installationId: '123',
    appType: 'standard',
    accountLogin: 'acme',
    source: 'installation',
    gitAuthor: { name: 'bot', email: 'bot@example.com' },
  };
  const resolvers = [
    { mode: 'raw', resolve: resolveGitHubTokenForRepo },
    { mode: 'managed', resolve: resolveCloudAgentGitHubAuthForRepo },
    { mode: 'capability', resolve: issueCloudAgentGitHubSessionCapability },
  ];

  it.each(resolvers)(
    'marks old $mode responses as unresolved without inventing identity',
    async ({ resolve }) => {
      const service = vi.fn().mockResolvedValue(oldResponse);
      const result = await resolve(
        createEnv({
          getTokenForRepo: service,
          getCloudAgentAuthForRepo: service,
          issueGitHubSessionCapability: service,
        }),
        params
      );
      expect(result).toMatchObject({
        success: true,
        value: { identity: { kind: 'legacy-unresolved' } },
      });
      expect(result).not.toHaveProperty('value.integrationId');
    }
  );

  it.each(
    resolvers.flatMap(resolver =>
      [
        { label: 'pin', expected: { expectedIntegrationId: integrationId } },
        { label: 'owner', expected: { expectedIntegrationOwner: integrationOwner } },
      ].map(selection => ({ ...resolver, ...selection }))
    )
  )('rejects an unproven $label from an old $mode response', async ({ resolve, expected }) => {
    const service = vi.fn().mockResolvedValue(oldResponse);
    const result = await resolve(
      createEnv({
        getTokenForRepo: service,
        getCloudAgentAuthForRepo: service,
        issueGitHubSessionCapability: service,
      }),
      { ...params, ...expected }
    );
    expect(result).toMatchObject({
      success: false,
      error: { reason: 'service_compatibility_error' },
    });
    expect(result).not.toHaveProperty('value');
  });

  it.each(
    resolvers.flatMap(resolver =>
      [
        { integrationId },
        { integrationOwner },
        { integrationId: undefined, integrationOwner: undefined },
        { integrationId: '', integrationOwner },
        { integrationId: 123, integrationOwner },
        { integrationId, integrationOwner: null },
        { integrationId, integrationOwner: { type: 'user', id: '' } },
        { integrationId, integrationOwner: { type: 'team', id: 'owner' } },
      ].map(fields => ({ ...resolver, fields }))
    )
  )(
    'rejects malformed $mode identity $fields without a legacy fallback',
    async ({ resolve, fields }) => {
      const service = vi.fn().mockResolvedValue({ ...oldResponse, ...fields });
      const result = await resolve(
        createEnv({
          getTokenForRepo: service,
          getCloudAgentAuthForRepo: service,
          issueGitHubSessionCapability: service,
        }),
        params
      );
      expect(result).toMatchObject({
        success: false,
        error: { reason: 'service_compatibility_error' },
      });
      expect(result).not.toHaveProperty('value');
    }
  );

  it.each(['managed', 'capability'] as const)(
    'does not hide malformed %s identity with a successful fallback',
    async mode => {
      const malformed = { ...oldResponse, integrationId };
      const resolved = { ...oldResponse, integrationId, integrationOwner };
      const env = createEnv({
        getTokenForRepo: vi.fn().mockResolvedValue(resolved),
        getCloudAgentAuthForRepo: vi
          .fn()
          .mockResolvedValue(mode === 'managed' ? malformed : resolved),
        issueGitHubSessionCapability: vi.fn().mockResolvedValue(malformed),
      });
      const result =
        mode === 'managed'
          ? await resolveCloudAgentGitHubAuthForRepo(env, params)
          : await issueCloudAgentGitHubSessionCapability(env, params);
      expect(result).toMatchObject({
        success: false,
        error: { reason: 'service_compatibility_error' },
      });
      expect(result).not.toHaveProperty('value');
    }
  );

  it.each(
    resolvers.flatMap(resolver =>
      [
        { expectedIntegrationId: 'another-integration' },
        { expectedIntegrationOwner: { type: 'org' as const, id: 'billing-org' } },
        { expectedIntegrationOwner: { type: 'user' as const, id: 'another-user' } },
      ].map(expected => ({ ...resolver, expected }))
    )
  )('rejects a changed resolved identity from $mode', async ({ resolve, expected }) => {
    const service = vi.fn().mockResolvedValue({ ...oldResponse, integrationId, integrationOwner });
    expect(
      await resolve(
        createEnv({
          getTokenForRepo: service,
          getCloudAgentAuthForRepo: service,
          issueGitHubSessionCapability: service,
        }),
        { ...params, ...expected }
      )
    ).toMatchObject({
      success: false,
      error: { reason: 'integration_mismatch' },
    });
  });
});

describe('resolveManagedBitbucketToken', () => {
  const repositoryParams = {
    userId: 'user_123',
    workspaceUuid: '123e4567-e89b-12d3-a456-426614174020',
    repositoryUuid: '123e4567-e89b-12d3-a456-426614174021',
    repositoryUrl: 'https://bitbucket.org/acme/repo.git',
  };

  it('rejects a missing organization before invoking the service binding', async () => {
    const getBitbucketToken = vi.fn().mockResolvedValue({ success: true, token: 'opaque-token' });

    await expect(
      resolveManagedBitbucketToken(createEnv({ getBitbucketToken }), repositoryParams as never)
    ).resolves.toEqual({ success: false, reason: 'invalid_request' });
    expect(getBitbucketToken).not.toHaveBeenCalled();
  });

  it('forwards explicit organization and repository identity and returns the token unchanged', async () => {
    const getBitbucketToken = vi.fn().mockResolvedValue({
      success: true,
      token: 'opaque-workspace-token',
    });
    const params = {
      ...repositoryParams,
      orgId: '123e4567-e89b-12d3-a456-426614174030',
    };

    await expect(
      resolveManagedBitbucketToken(createEnv({ getBitbucketToken }), params)
    ).resolves.toEqual({ success: true, token: 'opaque-workspace-token' });
    expect(getBitbucketToken).toHaveBeenCalledWith(params);
  });

  it('forwards an explicit expected integration id when provided', async () => {
    const getBitbucketToken = vi.fn().mockResolvedValue({
      success: true,
      token: 'opaque-workspace-token',
    });
    const params = {
      ...repositoryParams,
      orgId: '123e4567-e89b-12d3-a456-426614174030',
      expectedIntegrationId: '123e4567-e89b-12d3-a456-426614174022',
    };

    await expect(
      resolveManagedBitbucketToken(createEnv({ getBitbucketToken }), params)
    ).resolves.toEqual({ success: true, token: 'opaque-workspace-token' });
    expect(getBitbucketToken).toHaveBeenCalledWith(params);
  });

  it.each(['insufficient_permissions', 'temporarily_unavailable'] as const)(
    'preserves the %s resolver failure',
    async reason => {
      const getBitbucketToken = vi.fn().mockResolvedValue({ success: false, reason });

      await expect(
        resolveManagedBitbucketToken(createEnv({ getBitbucketToken }), {
          ...repositoryParams,
          orgId: '123e4567-e89b-12d3-a456-426614174030',
        })
      ).resolves.toEqual({ success: false, reason });
    }
  );

  it('normalizes a missing service binding distinctly', async () => {
    await expect(
      resolveManagedBitbucketToken(
        {},
        {
          ...repositoryParams,
          orgId: '123e4567-e89b-12d3-a456-426614174030',
        }
      )
    ).resolves.toEqual({ success: false, reason: 'service_not_configured' });
    expect(logger.warn).toHaveBeenCalledWith(
      'Bitbucket git-token-service binding is not configured'
    );
  });

  it('normalizes an RPC exception distinctly', async () => {
    const getBitbucketToken = vi.fn().mockRejectedValue(new Error('binding unavailable'));

    await expect(
      resolveManagedBitbucketToken(createEnv({ getBitbucketToken }), {
        ...repositoryParams,
        orgId: '123e4567-e89b-12d3-a456-426614174030',
      })
    ).resolves.toEqual({ success: false, reason: 'rpc_error' });
    expect(logger.error).toHaveBeenCalledWith('Failed to call git-token-service getBitbucketToken');
  });
});

describe('resolveManagedGitLabToken', () => {
  const reviewParams = {
    userId: 'user_123',
    repositoryUrl: 'https://gitlab.com/acme/repo.git',
    createdOnPlatform: 'code-review',
  };

  it('passes generic session context and project-token CLI mode through the service binding', async () => {
    const service = createGitTokenService();
    service.getGitLabToken.mockResolvedValue({
      success: true,
      token: 'project-access-token',
      instanceUrl: 'https://gitlab.com',
      glabIsOAuth2: false,
    });

    await expect(
      resolveManagedGitLabToken({ GIT_TOKEN_SERVICE: service }, reviewParams)
    ).resolves.toEqual({
      success: true,
      token: 'project-access-token',
      instanceUrl: 'https://gitlab.com',
      glabIsOAuth2: false,
    });
    expect(service.getGitLabToken).toHaveBeenCalledWith(reviewParams);
  });

  it('passes ordinary managed-token CLI mode through unchanged', async () => {
    const service = createGitTokenService();
    service.getGitLabToken.mockResolvedValue({
      success: true,
      token: 'integration-token',
      instanceUrl: 'https://gitlab.com',
      glabIsOAuth2: true,
    });

    await expect(
      resolveManagedGitLabToken({ GIT_TOKEN_SERVICE: service }, { userId: 'user_123' })
    ).resolves.toEqual({
      success: true,
      token: 'integration-token',
      instanceUrl: 'https://gitlab.com',
      glabIsOAuth2: true,
    });
  });

  it('returns a safe generic failure without a local fallback path', async () => {
    const service = createGitTokenService();
    service.getGitLabToken.mockResolvedValue({ success: false, reason: 'no_project_token' });

    await expect(
      resolveManagedGitLabToken({ GIT_TOKEN_SERVICE: service }, reviewParams)
    ).resolves.toEqual({ success: false, reason: 'no_project_token' });
  });

  it('fails safely when the service binding is unavailable', async () => {
    await expect(resolveManagedGitLabToken({}, reviewParams)).resolves.toEqual({
      success: false,
      reason: 'service_not_configured',
    });
  });
});

describe('issueCloudAgentGitHubSessionCapability', () => {
  it('falls back to installation authentication when the capability RPC is not deployed yet', async () => {
    const getTokenForRepo = vi.fn().mockResolvedValue({
      success: true,
      token: 'installation-token',
      installationId: '123',
      accountLogin: 'acme',
      appType: 'standard',
    });

    const result = await issueCloudAgentGitHubSessionCapability(createEnv({ getTokenForRepo }), {
      githubRepo: 'acme/repo',
      userId: 'user_1',
      outboundContainerId: 'container-test',
      allowUserAuthorization: true,
    });

    expect(getTokenForRepo).toHaveBeenCalledWith({ githubRepo: 'acme/repo', userId: 'user_1' });
    expect(result).toEqual({
      success: true,
      value: {
        githubToken: 'installation-token',
        installationId: '123',
        identity: { kind: 'legacy-unresolved' },
        accountLogin: 'acme',
        appType: 'standard',
        source: 'installation',
      },
    });
  });

  it('returns an opaque capability and preserves managed identity metadata', async () => {
    const issueGitHubSessionCapability = vi.fn().mockResolvedValue({
      success: true,
      capability: 'kgh2.opaque',
      installationId: '123',
      accountLogin: 'acme',
      appType: 'standard',
      source: 'user',
      gitAuthor: { name: 'octocat', email: '101+octocat@users.noreply.github.com' },
      commitCoAuthor: { name: 'kiloconnect[bot]', email: 'bot@example.com' },
    });
    const getCloudAgentAuthForRepo = vi.fn();
    const getTokenForRepo = vi.fn();

    const result = await issueCloudAgentGitHubSessionCapability(
      createEnv({ issueGitHubSessionCapability, getCloudAgentAuthForRepo, getTokenForRepo }),
      {
        githubRepo: 'acme/repo',
        userId: 'user_1',
        outboundContainerId: 'container-test',
        allowUserAuthorization: true,
      }
    );

    expect(issueGitHubSessionCapability).toHaveBeenCalledWith({
      githubRepo: 'acme/repo',
      userId: 'user_1',
      outboundContainerId: 'container-test',
      allowUserAuthorization: true,
    });
    expect(getCloudAgentAuthForRepo).not.toHaveBeenCalled();
    expect(getTokenForRepo).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      value: {
        capability: 'kgh2.opaque',
        source: 'user',
        gitAuthor: { name: 'octocat' },
      },
    });
  });

  it('forwards the expected integration id through capability issuance', async () => {
    const issueGitHubSessionCapability = vi.fn().mockResolvedValue({
      success: true,
      capability: 'kgh2.opaque',
      installationId: '123',
      accountLogin: 'acme',
      appType: 'standard',
      source: 'installation',
      gitAuthor: { name: 'kiloconnect[bot]', email: 'bot@example.com' },
    });
    const expectedIntegrationId = '123e4567-e89b-12d3-a456-426614174022';

    await issueCloudAgentGitHubSessionCapability(createEnv({ issueGitHubSessionCapability }), {
      githubRepo: 'acme/repo',
      userId: 'user_1',
      outboundContainerId: 'container-test',
      expectedIntegrationId,
      allowUserAuthorization: false,
    });

    expect(issueGitHubSessionCapability).toHaveBeenCalledWith({
      githubRepo: 'acme/repo',
      userId: 'user_1',
      outboundContainerId: 'container-test',
      expectedIntegrationId,
      allowUserAuthorization: false,
    });
  });

  it('reports issuance failure without resolving raw authentication', async () => {
    const issueGitHubSessionCapability = vi.fn().mockResolvedValue({
      success: false,
      reason: 'capability_configuration_error',
    });
    const getCloudAgentAuthForRepo = vi.fn();
    const getTokenForRepo = vi.fn();

    const result = await issueCloudAgentGitHubSessionCapability(
      createEnv({ issueGitHubSessionCapability, getCloudAgentAuthForRepo, getTokenForRepo }),
      {
        githubRepo: 'acme/repo',
        userId: 'user_1',
        outboundContainerId: 'container-test',
        allowUserAuthorization: false,
      }
    );

    expect(result).toEqual({
      success: false,
      error: {
        reason: 'capability_configuration_error',
        message: 'GitHub managed auth lookup failed (capability_configuration_error)',
      },
    });
    expect(getCloudAgentAuthForRepo).not.toHaveBeenCalled();
    expect(getTokenForRepo).not.toHaveBeenCalled();
  });

  it('falls back to direct authentication when the capability RPC rejects during rollout', async () => {
    const issueGitHubSessionCapability = vi
      .fn()
      .mockRejectedValue(new Error('service unavailable'));
    const getCloudAgentAuthForRepo = vi.fn().mockResolvedValue({
      success: true,
      githubToken: 'user-token',
      installationId: '123',
      accountLogin: 'acme',
      appType: 'standard',
      source: 'user',
      gitAuthor: { name: 'octocat', email: '101+octocat@users.noreply.github.com' },
    });
    const getTokenForRepo = vi.fn();

    const result = await issueCloudAgentGitHubSessionCapability(
      createEnv({ issueGitHubSessionCapability, getCloudAgentAuthForRepo, getTokenForRepo }),
      {
        githubRepo: 'acme/repo',
        userId: 'user_1',
        outboundContainerId: 'container-test',
        allowUserAuthorization: true,
      }
    );

    expect(result).toEqual({
      success: true,
      value: {
        githubToken: 'user-token',
        installationId: '123',
        identity: { kind: 'legacy-unresolved' },
        accountLogin: 'acme',
        appType: 'standard',
        source: 'user',
        gitAuthor: { name: 'octocat', email: '101+octocat@users.noreply.github.com' },
      },
    });
    expect(getCloudAgentAuthForRepo).toHaveBeenCalledWith({
      githubRepo: 'acme/repo',
      userId: 'user_1',
      allowUserAuthorization: true,
    });
    expect(getTokenForRepo).not.toHaveBeenCalled();
  });
});

describe('issueCloudAgentGitLabSessionCapability', () => {
  it('returns an opaque code-review project capability and preserves CLI mode metadata', async () => {
    const issueGitLabSessionCapability = vi.fn().mockResolvedValue({
      success: true,
      capability: 'kgl2.project',
      instanceOrigin: 'https://gitlab.example.com:8443/gitlab',
      instanceHost: 'gitlab.example.com:8443',
      projectPath: 'acme/platform/repo',
      integrationId: 'project_token_1',
      authType: 'pat',
      identity: { accountId: null, accountLogin: null },
      glabIsOAuth2: false,
    });
    const getGitLabToken = vi.fn();

    const result = await issueCloudAgentGitLabSessionCapability(
      createEnv({ issueGitLabSessionCapability, getGitLabToken }),
      {
        gitUrl: 'https://gitlab.example.com:8443/gitlab/acme/platform/repo.git',
        userId: 'user_1',
        outboundContainerId: 'container-test',
        createdOnPlatform: 'code-review',
      }
    );

    expect(issueGitLabSessionCapability).toHaveBeenCalledWith({
      gitUrl: 'https://gitlab.example.com:8443/gitlab/acme/platform/repo.git',
      userId: 'user_1',
      outboundContainerId: 'container-test',
      createdOnPlatform: 'code-review',
    });
    expect(getGitLabToken).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: true,
      value: {
        capability: 'kgl2.project',
        gitUrl: 'https://gitlab.example.com:8443/gitlab/acme/platform/repo.git',
        instanceOrigin: 'https://gitlab.example.com:8443/gitlab',
        instanceHost: 'gitlab.example.com:8443',
        projectPath: 'acme/platform/repo',
        integrationId: 'project_token_1',
        authType: 'pat',
        identity: { accountId: null, accountLogin: null },
        glabIsOAuth2: false,
      },
    });
    expect(JSON.stringify(result)).not.toContain('project-access-token');
  });

  it('reports issuance failure without resolving a raw token', async () => {
    const issueGitLabSessionCapability = vi.fn().mockResolvedValue({
      success: false,
      reason: 'capability_configuration_error',
    });
    const getGitLabToken = vi.fn();

    const result = await issueCloudAgentGitLabSessionCapability(
      createEnv({ issueGitLabSessionCapability, getGitLabToken }),
      {
        gitUrl: 'https://gitlab.com/acme/repo.git',
        userId: 'user_1',
        outboundContainerId: 'container-test',
      }
    );

    expect(result).toEqual({ success: false, reason: 'capability_configuration_error' });
    expect(getGitLabToken).not.toHaveBeenCalled();
  });

  it('fails closed when capability RPC throws without a raw token fallback', async () => {
    const issueGitLabSessionCapability = vi
      .fn()
      .mockRejectedValue(new Error('service unavailable'));
    const getGitLabToken = vi.fn();

    const result = await issueCloudAgentGitLabSessionCapability(
      createEnv({ issueGitLabSessionCapability, getGitLabToken }),
      {
        gitUrl: 'https://gitlab.com/acme/repo.git',
        userId: 'user_1',
        outboundContainerId: 'container-test',
      }
    );

    expect(result).toEqual({ success: false, reason: 'rpc_error' });
    expect(getGitLabToken).not.toHaveBeenCalled();
  });
});

describe('resolveCloudAgentGitHubAuthForRepo', () => {
  it('passes explicit user-auth eligibility to the managed resolver when it is available', async () => {
    const getCloudAgentAuthForRepo = vi.fn().mockResolvedValue({
      success: true,
      githubToken: 'user-token',
      installationId: '123',
      accountLogin: 'acme',
      appType: 'standard',
      source: 'user',
      gitAuthor: { name: 'octocat', email: '101+octocat@users.noreply.github.com' },
      commitCoAuthor: { name: 'kiloconnect[bot]', email: 'bot@example.com' },
    });
    const getTokenForRepo = vi.fn();

    const result = await resolveCloudAgentGitHubAuthForRepo(
      createEnv({ getCloudAgentAuthForRepo, getTokenForRepo }),
      {
        githubRepo: 'acme/repo',
        userId: 'user_1',
        allowUserAuthorization: true,
      }
    );

    expect(getCloudAgentAuthForRepo).toHaveBeenCalledWith({
      githubRepo: 'acme/repo',
      userId: 'user_1',
      allowUserAuthorization: true,
    });
    expect(getTokenForRepo).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      value: { source: 'user', githubToken: 'user-token' },
    });
  });

  it('passes through sanitized credential fallback reasons on successful installation auth', async () => {
    const getCloudAgentAuthForRepo = vi.fn().mockResolvedValue({
      success: true,
      githubToken: 'installation-token',
      installationId: '123',
      accountLogin: 'acme',
      appType: 'standard',
      source: 'installation',
      gitAuthor: { name: 'kiloconnect[bot]', email: 'bot@example.com' },
      fallbackReason: 'credential_unreadable',
    });
    const getTokenForRepo = vi.fn();

    const result = await resolveCloudAgentGitHubAuthForRepo(
      createEnv({ getCloudAgentAuthForRepo, getTokenForRepo }),
      {
        githubRepo: 'acme/repo',
        userId: 'user_1',
        allowUserAuthorization: true,
      }
    );

    expect(getTokenForRepo).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: true,
      value: {
        githubToken: 'installation-token',
        installationId: '123',
        identity: { kind: 'legacy-unresolved' },
        accountLogin: 'acme',
        appType: 'standard',
        source: 'installation',
        gitAuthor: { name: 'kiloconnect[bot]', email: 'bot@example.com' },
        fallbackReason: 'credential_unreadable',
      },
    });
  });

  it('falls back to installation authentication when an older service rejects the managed RPC', async () => {
    const getCloudAgentAuthForRepo = vi
      .fn()
      .mockRejectedValue(new Error('RPC method getCloudAgentAuthForRepo is not available'));
    const getTokenForRepo = vi.fn().mockResolvedValue({
      success: true,
      token: 'installation-token',
      installationId: '123',
      accountLogin: 'acme',
      appType: 'standard',
    });

    const result = await resolveCloudAgentGitHubAuthForRepo(
      createEnv({ getCloudAgentAuthForRepo, getTokenForRepo }),
      {
        githubRepo: 'acme/repo',
        userId: 'user_1',
        allowUserAuthorization: true,
      }
    );

    expect(getCloudAgentAuthForRepo).toHaveBeenCalledWith({
      githubRepo: 'acme/repo',
      userId: 'user_1',
      allowUserAuthorization: true,
    });
    expect(getTokenForRepo).toHaveBeenCalledWith({ githubRepo: 'acme/repo', userId: 'user_1' });
    expect(result).toMatchObject({
      success: true,
      value: {
        githubToken: 'installation-token',
        installationId: '123',
        identity: { kind: 'legacy-unresolved' },
        appType: 'standard',
        source: 'installation',
      },
    });
  });

  it('preserves the expected integration id through direct and legacy fallbacks', async () => {
    const getCloudAgentAuthForRepo = vi
      .fn()
      .mockRejectedValue(new Error('RPC method getCloudAgentAuthForRepo is not available'));
    const getTokenForRepo = vi.fn().mockResolvedValue({
      success: true,
      token: 'installation-token',
      installationId: '123',
      accountLogin: 'acme',
      appType: 'standard',
    });
    const expectedIntegrationId = '123e4567-e89b-12d3-a456-426614174022';

    await resolveCloudAgentGitHubAuthForRepo(
      createEnv({ getCloudAgentAuthForRepo, getTokenForRepo }),
      {
        githubRepo: 'acme/repo',
        userId: 'user_1',
        expectedIntegrationId,
        allowUserAuthorization: false,
      }
    );

    expect(getCloudAgentAuthForRepo).toHaveBeenCalledWith({
      githubRepo: 'acme/repo',
      userId: 'user_1',
      expectedIntegrationId,
      allowUserAuthorization: false,
    });
    expect(getTokenForRepo).toHaveBeenCalledWith({
      githubRepo: 'acme/repo',
      userId: 'user_1',
      expectedIntegrationId,
    });
  });
});
