import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAppAuth } from '@octokit/auth-app';
import { GitHubTokenService } from './github-token-service.js';

vi.mock('@octokit/auth-app', () => ({
  createAppAuth: vi.fn(),
}));

type RefreshableGitHubTokenService = {
  refreshInstallationAccountLoginIfDue(
    installationId: string,
    appType?: 'standard' | 'lite'
  ): Promise<string | null>;
};

function createTokenCache(cooldownValue: string | null = null) {
  return {
    get: vi.fn(async () => cooldownValue),
    put: vi.fn(async () => undefined),
  };
}

describe('GitHubTokenService', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(createAppAuth).mockReset();
  });

  it('refreshes installation account login and stores a ten minute cooldown marker', async () => {
    const tokenCache = createTokenCache();
    vi.mocked(createAppAuth).mockReturnValue(
      vi.fn().mockResolvedValue({ token: 'app-jwt' }) as unknown as ReturnType<typeof createAppAuth>
    );
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ account: { login: 'renamed-owner' } }), { status: 200 })
      );
    const service = new GitHubTokenService({
      GITHUB_APP_ID: 'app-id',
      GITHUB_APP_PRIVATE_KEY: 'private-key',
      TOKEN_CACHE: tokenCache,
    } as unknown as CloudflareEnv) as unknown as RefreshableGitHubTokenService;

    const result = await service.refreshInstallationAccountLoginIfDue('123');

    expect(result).toBe('renamed-owner');
    expect(tokenCache.put).toHaveBeenCalledWith(
      'gh-installation-login-refresh:v1:standard:123',
      expect.any(String),
      { expirationTtl: 10 * 60 }
    );
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.github.com/app/installations/123',
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('suppresses installation login refresh during the cooldown window', async () => {
    const tokenCache = createTokenCache('attempted');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const service = new GitHubTokenService({
      GITHUB_APP_ID: 'app-id',
      GITHUB_APP_PRIVATE_KEY: 'private-key',
      TOKEN_CACHE: tokenCache,
    } as unknown as CloudflareEnv) as unknown as RefreshableGitHubTokenService;

    const result = await service.refreshInstallationAccountLoginIfDue('123', 'lite');

    expect(result).toBeNull();
    expect(tokenCache.put).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(createAppAuth).not.toHaveBeenCalled();
  });

  it('does not log authenticated response data when installation login refresh fails', async () => {
    const upstreamError = Object.assign(new Error('metadata lookup unavailable'), {
      response: { data: { token: 'sensitive-metadata-response' } },
    });
    vi.mocked(createAppAuth).mockReturnValue(
      vi.fn().mockResolvedValue({ token: 'app-jwt' }) as unknown as ReturnType<typeof createAppAuth>
    );
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(upstreamError);
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const service = new GitHubTokenService({
      GITHUB_APP_ID: 'app-id',
      GITHUB_APP_PRIVATE_KEY: 'private-key',
    } as CloudflareEnv) as unknown as RefreshableGitHubTokenService;

    const result = await service.refreshInstallationAccountLoginIfDue('123');

    expect(result).toBeNull();
    expect(JSON.stringify(consoleWarn.mock.calls)).not.toContain('sensitive-metadata-response');
  });

  it('does not log authenticated upstream response data when scoped token minting fails', async () => {
    const upstreamError = Object.assign(new Error('repository unavailable'), {
      response: { data: { token: 'sensitive-upstream-data' } },
    });
    vi.mocked(createAppAuth).mockReturnValue(
      vi.fn().mockRejectedValue(upstreamError) as unknown as ReturnType<typeof createAppAuth>
    );
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const service = new GitHubTokenService({
      GITHUB_APP_ID: 'app-id',
      GITHUB_APP_PRIVATE_KEY: 'private-key',
    } as CloudflareEnv);

    await expect(service.getTokenForRepo('123', 'repository')).rejects.toThrow(
      'Failed to generate GitHub installation token: repository unavailable'
    );

    expect(consoleError).toHaveBeenCalledWith(
      JSON.stringify({
        message: 'Failed to generate GitHub installation token',
        errorType: 'Error',
      })
    );
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('sensitive-upstream-data');
  });
});
