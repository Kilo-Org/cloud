import { describe, expect, it, vi } from 'vitest';
import type { GitTokenService } from '../types.js';
import { resolveGitLabCodeReviewToken } from './git-token-service-client.js';

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
    getGitLabCodeReviewToken: vi.fn(),
  } satisfies GitTokenService;
}

describe('resolveGitLabCodeReviewToken', () => {
  const params = {
    userId: 'user_123',
    integrationId: '123e4567-e89b-12d3-a456-426614174011',
    projectId: 42,
  };

  it('returns the exact project token resolved by the service binding', async () => {
    const service = createGitTokenService();
    service.getGitLabCodeReviewToken.mockResolvedValue({
      success: true,
      token: 'project-access-token',
      instanceUrl: 'https://gitlab.com',
    });

    await expect(
      resolveGitLabCodeReviewToken({ GIT_TOKEN_SERVICE: service }, params)
    ).resolves.toEqual({
      success: true,
      token: 'project-access-token',
      instanceUrl: 'https://gitlab.com',
    });
    expect(service.getGitLabCodeReviewToken).toHaveBeenCalledWith(params);
    expect(service.getGitLabToken).not.toHaveBeenCalled();
  });

  it('returns a safe failure without falling back to managed credentials', async () => {
    const service = createGitTokenService();
    service.getGitLabCodeReviewToken.mockResolvedValue({
      success: false,
      reason: 'no_project_token',
    });

    await expect(
      resolveGitLabCodeReviewToken({ GIT_TOKEN_SERVICE: service }, params)
    ).resolves.toEqual({ success: false, reason: 'no_project_token' });
    expect(service.getGitLabToken).not.toHaveBeenCalled();
  });

  it('fails safely when the service binding is unavailable', async () => {
    await expect(resolveGitLabCodeReviewToken({}, params)).resolves.toEqual({
      success: false,
      reason: 'service_not_configured',
    });
  });
});
