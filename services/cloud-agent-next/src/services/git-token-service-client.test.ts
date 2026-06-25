import { describe, expect, it, vi } from 'vitest';
import { logger } from '../logger.js';
import type { GitTokenService } from '../types.js';
import {
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
  } satisfies GitTokenService;
}

function createEnv(service: Partial<GitTokenService>) {
  return { GIT_TOKEN_SERVICE: service as GitTokenService };
}

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

  it('forwards exact organization and repository identity and returns the token unchanged', async () => {
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

  it('normalizes a missing service binding to temporary unavailability', async () => {
    await expect(
      resolveManagedBitbucketToken(
        {},
        {
          ...repositoryParams,
          orgId: '123e4567-e89b-12d3-a456-426614174030',
        }
      )
    ).resolves.toEqual({ success: false, reason: 'temporarily_unavailable' });
    expect(logger.warn).toHaveBeenCalledWith(
      'Bitbucket git-token-service binding is not configured'
    );
  });

  it('normalizes an RPC exception to temporary unavailability', async () => {
    const getBitbucketToken = vi.fn().mockRejectedValue(new Error('binding unavailable'));

    await expect(
      resolveManagedBitbucketToken(createEnv({ getBitbucketToken }), {
        ...repositoryParams,
        orgId: '123e4567-e89b-12d3-a456-426614174030',
      })
    ).resolves.toEqual({ success: false, reason: 'temporarily_unavailable' });
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
    ).resolves.toEqual({ success: true, token: 'integration-token', glabIsOAuth2: true });
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
      { githubRepo: 'acme/repo', userId: 'user_1', allowUserAuthorization: true }
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
      { githubRepo: 'acme/repo', userId: 'user_1', allowUserAuthorization: true }
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
      { githubRepo: 'acme/repo', userId: 'user_1', allowUserAuthorization: true }
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
