import { beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../logger.js';
import type { GitTokenService } from '../types.js';
import {
  issueCloudAgentBitbucketSessionCapability,
  issueCloudAgentGitHubSessionCapability,
  issueCloudAgentGitLabSessionCapability,
  issueCloudAgentKiloSessionCapability,
  resolveCloudAgentGitHubAuthForRepo,
  resolveGitHubTokenForRepo,
  resolveManagedBitbucketToken,
  resolveManagedGitLabToken,
} from './git-token-service-client.js';

vi.mock('../logger.js', () => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withFields: vi.fn(),
  };
  logger.withFields.mockReturnValue(logger);
  return { logger };
});

const BROKER_ERROR_SECRET = 'fixture-managed-credential-in-broker-error';

beforeEach(() => vi.clearAllMocks());

function expectSecretSafeLogs(): void {
  const mockedLogger = vi.mocked(logger);
  expect(
    JSON.stringify([
      mockedLogger.info.mock.calls,
      mockedLogger.warn.mock.calls,
      mockedLogger.error.mock.calls,
      mockedLogger.withFields.mock.calls,
    ])
  ).not.toContain(BROKER_ERROR_SECRET);
}

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

describe('broker exception safety', () => {
  const params = { userId: 'user_1', outboundContainerId: 'container-test' };
  const bitbucketParams = {
    ...params,
    orgId: '123e4567-e89b-12d3-a456-426614174030',
    workspaceUuid: '123e4567-e89b-12d3-a456-426614174020',
    repositoryUuid: '123e4567-e89b-12d3-a456-426614174021',
    repositoryUrl: 'https://bitbucket.org/acme/repo.git',
  };

  it.each([
    [
      'GitHub lookup',
      (env: ReturnType<typeof createEnv>) =>
        resolveGitHubTokenForRepo(env, { userId: params.userId, githubRepo: 'acme/repo' }),
    ],
    [
      'Kilo issuance',
      (env: ReturnType<typeof createEnv>) =>
        issueCloudAgentKiloSessionCapability(env, {
          ...params,
          cloudAgentSessionId: 'workspace_11111111-1111-4111-8111-111111111111',
          kiloSessionId: 'ses_abcdefghijklmnopqrstuvwxyz',
          userToken: BROKER_ERROR_SECRET,
          targets: {
            backendBaseUrl: 'https://backend.example.com',
            providerBaseUrl: 'https://provider.example.com',
            sessionIngestBaseUrl: 'https://ingest.example.com',
          },
        }),
    ],
    [
      'GitLab issuance',
      (env: ReturnType<typeof createEnv>) =>
        issueCloudAgentGitLabSessionCapability(env, {
          ...params,
          gitUrl: 'https://gitlab.com/acme/repo.git',
        }),
    ],
    [
      'Bitbucket issuance',
      (env: ReturnType<typeof createEnv>) =>
        issueCloudAgentBitbucketSessionCapability(env, bitbucketParams),
    ],
    [
      'GitLab lookup',
      (env: ReturnType<typeof createEnv>) =>
        resolveManagedGitLabToken(env, { userId: params.userId }),
    ],
    [
      'Bitbucket lookup',
      (env: ReturnType<typeof createEnv>) => resolveManagedBitbucketToken(env, bitbucketParams),
    ],
  ] as const)('keeps %s exception details out of logs and failure output', async (name, call) => {
    const rejectedRpc = vi
      .fn()
      .mockRejectedValue(new Error(`Broker rejected Bearer ${BROKER_ERROR_SECRET}`));
    const env = createEnv({
      getTokenForRepo: rejectedRpc,
      issueKiloSessionCapability: rejectedRpc,
      issueGitLabSessionCapability: rejectedRpc,
      issueBitbucketSessionCapability: rejectedRpc,
      getGitLabToken: rejectedRpc,
      getBitbucketToken: rejectedRpc,
    });

    const result = await call(env);

    expect(JSON.stringify(result)).not.toContain(BROKER_ERROR_SECRET);
    expectSecretSafeLogs();
    expect(logger.error).toHaveBeenCalled();
    expect(result).toEqual(
      'error' in result
        ? {
            success: false,
            error: {
              reason: 'rpc_error',
              message:
                name === 'GitHub lookup'
                  ? 'GitHub credential service is unavailable'
                  : 'git-token-service RPC failed',
            },
          }
        : { success: false, reason: 'rpc_error' }
    );
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
  it('fails closed without raw authentication when the capability RPC is not deployed yet', async () => {
    const getTokenForRepo = vi.fn().mockResolvedValue({
      success: true,
      token: 'installation-token',
      installationId: '123',
      accountLogin: 'acme',
      appType: 'standard',
    });
    const getCloudAgentAuthForRepo = vi.fn();

    const result = await issueCloudAgentGitHubSessionCapability(
      createEnv({ getTokenForRepo, getCloudAgentAuthForRepo }),
      {
        githubRepo: 'acme/repo',
        userId: 'user_1',
        outboundContainerId: 'container-test',
        allowUserAuthorization: true,
      }
    );

    expect(getTokenForRepo).not.toHaveBeenCalled();
    expect(getCloudAgentAuthForRepo).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: false,
      error: {
        reason: 'service_not_configured',
        message: 'git-token-service capability issuance is not configured',
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

  it('fails closed without direct authentication when the capability RPC rejects', async () => {
    const issueGitHubSessionCapability = vi
      .fn()
      .mockRejectedValue(new Error(`Broker rejected ${BROKER_ERROR_SECRET}`));
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
      success: false,
      error: { reason: 'rpc_error', message: 'GitHub credential service is unavailable' },
    });
    expect(getCloudAgentAuthForRepo).not.toHaveBeenCalled();
    expect(getTokenForRepo).not.toHaveBeenCalled();
    expectSecretSafeLogs();
    expect(JSON.stringify(result)).not.toContain(BROKER_ERROR_SECRET);
  });
});

describe.each([
  { method: 'getTokenForRepo', resolve: resolveGitHubTokenForRepo },
  { method: 'getCloudAgentAuthForRepo', resolve: resolveCloudAgentGitHubAuthForRepo },
  { method: 'issueGitHubSessionCapability', resolve: issueCloudAgentGitHubSessionCapability },
] as const)('GitHub credential client $method failures', ({ method, resolve }) => {
  const params = {
    githubRepo: 'acme/repo',
    userId: 'user_1',
    outboundContainerId: 'container-test',
    allowUserAuthorization: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(['no_installation_found', 'repository_not_installed', 'integration_mismatch'] as const)(
    'preserves %s without trying another authorization path',
    async reason => {
      const service = { ...createGitTokenService(), getCloudAgentAuthForRepo: vi.fn() };
      service[method].mockResolvedValue({ success: false, reason });

      const result = await resolve({ GIT_TOKEN_SERVICE: service }, params);

      expect(result).toMatchObject({ success: false, error: { reason } });
      for (const rpc of [
        'getTokenForRepo',
        'getCloudAgentAuthForRepo',
        'issueGitHubSessionCapability',
      ] as const) {
        expect(service[rpc]).toHaveBeenCalledTimes(rpc === method ? 1 : 0);
      }
    }
  );

  it('keeps RPC exceptions distinct and excludes private errors from returned or logged data', async () => {
    const secret = 'sensitive-credential-or-query-parameter';
    const logFields = vi.spyOn(logger, 'withFields');
    const service = { ...createGitTokenService(), getCloudAgentAuthForRepo: vi.fn() };
    service[method].mockRejectedValue(
      Object.assign(new Error(`query or transport failed: ${secret}`), {
        request: { headers: { authorization: `Bearer ${secret}` } },
        response: { data: { token: secret } },
      })
    );

    const result = await resolve({ GIT_TOKEN_SERVICE: service }, params);

    expect(result).toEqual({
      success: false,
      error: { reason: 'rpc_error', message: 'GitHub credential service is unavailable' },
    });
    for (const rpc of [
      'getTokenForRepo',
      'getCloudAgentAuthForRepo',
      'issueGitHubSessionCapability',
    ] as const) {
      expect(service[rpc]).toHaveBeenCalledTimes(rpc === method ? 1 : 0);
    }
    expect(
      JSON.stringify({
        result,
        fields: logFields.mock.calls,
        errors: vi.mocked(logger.error).mock.calls,
        warnings: vi.mocked(logger.warn).mock.calls,
      })
    ).not.toContain(secret);
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
        accountLogin: 'acme',
        appType: 'standard',
        source: 'installation',
        gitAuthor: { name: 'kiloconnect[bot]', email: 'bot@example.com' },
        fallbackReason: 'credential_unreadable',
      },
    });
  });

  it('does not fall back to a different authorization path when the managed RPC rejects', async () => {
    const getCloudAgentAuthForRepo = vi
      .fn()
      .mockRejectedValue(new Error(`Broker rejected ${BROKER_ERROR_SECRET}`));
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
    expect(getTokenForRepo).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: false,
      error: { reason: 'rpc_error', message: 'GitHub credential service is unavailable' },
    });
    expectSecretSafeLogs();
    expect(JSON.stringify(result)).not.toContain(BROKER_ERROR_SECRET);
  });

  it('preserves the expected integration id through direct and legacy authentication', async () => {
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
    expect(getTokenForRepo).not.toHaveBeenCalled();

    await expect(
      resolveCloudAgentGitHubAuthForRepo(createEnv({ getTokenForRepo }), {
        githubRepo: 'acme/repo',
        userId: 'user_1',
        expectedIntegrationId,
        allowUserAuthorization: false,
      })
    ).resolves.toMatchObject({ success: true, value: { source: 'installation' } });
    expect(getTokenForRepo).toHaveBeenCalledWith({
      githubRepo: 'acme/repo',
      userId: 'user_1',
      expectedIntegrationId,
    });
  });
});
