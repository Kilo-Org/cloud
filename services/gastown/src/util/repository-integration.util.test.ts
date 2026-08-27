import { describe, expect, it, vi } from 'vitest';
import { resolveRepositoryIntegration } from './repository-integration.util';

describe('resolveRepositoryIntegration', () => {
  it('returns and persists the authoritative integration identity', async () => {
    const getTokenForRepo = vi.fn().mockResolvedValue({
      success: true,
      token: 'token',
      platformIntegrationId: 'resolved-integration',
      installationId: '123',
      accountLogin: 'acme',
      appType: 'standard',
    });

    await expect(
      resolveRepositoryIntegration({ GIT_TOKEN_SERVICE: { getTokenForRepo } } as unknown as Env, {
        gitUrl: 'https://github.com/acme/repo.git',
        userId: 'user-1',
        orgId: 'org-1',
        expectedIntegrationId: 'selected-integration',
      })
    ).resolves.toEqual({ success: true, platformIntegrationId: 'resolved-integration' });
    expect(getTokenForRepo).toHaveBeenCalledWith({
      githubRepo: 'acme/repo',
      userId: 'user-1',
      orgId: 'org-1',
      expectedIntegrationId: 'selected-integration',
    });
  });

  it('does not require Git Token Service for non-GitHub repositories', async () => {
    await expect(
      resolveRepositoryIntegration({} as Env, {
        gitUrl: 'https://gitlab.com/acme/repo.git',
        userId: 'user-1',
      })
    ).resolves.toEqual({ success: true });
  });
});
