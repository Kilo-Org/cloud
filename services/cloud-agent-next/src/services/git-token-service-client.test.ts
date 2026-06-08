import { describe, expect, it, vi } from 'vitest';
import type { GitTokenService } from '../types.js';
import {
  issueCloudAgentGitHubSessionCapability,
  issueCloudAgentGitLabSessionCapability,
  resolveCloudAgentGitHubAuthForRepo,
  resolveManagedGitLabToken,
} from './git-token-service-client.js';

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
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
  } satisfies GitTokenService;
}

function createEnv(service: Partial<GitTokenService>) {
  return { GIT_TOKEN_SERVICE: service as GitTokenService };
}

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

  it('fails closed when capability RPC throws without a raw token fallback', async () => {
    const issueGitHubSessionCapability = vi
      .fn()
      .mockRejectedValue(new Error('service unavailable'));
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

    expect(result).toMatchObject({ success: false, error: { reason: 'rpc_error' } });
    expect(getCloudAgentAuthForRepo).not.toHaveBeenCalled();
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
        appType: 'standard',
        source: 'installation',
      },
    });
  });
});
