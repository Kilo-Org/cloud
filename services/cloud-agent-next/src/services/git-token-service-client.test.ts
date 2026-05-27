import { describe, expect, it, vi } from 'vitest';
import type { GitTokenService } from '../types.js';
import { resolveManagedGitLabToken } from './git-token-service-client.js';

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    withFields: vi.fn(() => ({ info: vi.fn(), error: vi.fn() })),
  },
}));

function createGitTokenService() {
  return {
    getTokenForRepo: vi.fn(),
    getToken: vi.fn(),
    getGitLabToken: vi.fn(),
  } satisfies GitTokenService;
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
