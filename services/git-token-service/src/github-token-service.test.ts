import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import { GitHubTokenService } from './github-token-service.js';

vi.mock('@octokit/auth-app', () => ({
  createAppAuth: vi.fn(),
}));
vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn(),
}));

const mockGetInstallation = vi.fn();

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
    vi.mocked(Octokit).mockReset();
    mockGetInstallation.mockReset();
    vi.mocked(Octokit).mockImplementation(function MockOctokit() {
      return { apps: { getInstallation: mockGetInstallation } } as unknown as Octokit;
    });
  });

  it('refreshes installation account login and stores a fifteen minute cooldown marker', async () => {
    const tokenCache = createTokenCache();
    vi.mocked(createAppAuth).mockReturnValue(
      vi.fn().mockResolvedValue({ token: 'app-jwt' }) as unknown as ReturnType<typeof createAppAuth>
    );
    mockGetInstallation.mockResolvedValue({ data: { account: { login: 'renamed-owner' } } });
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
      { expirationTtl: 15 * 60 }
    );
    expect(Octokit).toHaveBeenCalledWith({ auth: 'app-jwt' });
    expect(mockGetInstallation).toHaveBeenCalledWith({ installation_id: 123 });
  });

  it('suppresses installation login refresh during the cooldown window', async () => {
    const tokenCache = createTokenCache('attempted');
    const service = new GitHubTokenService({
      GITHUB_APP_ID: 'app-id',
      GITHUB_APP_PRIVATE_KEY: 'private-key',
      TOKEN_CACHE: tokenCache,
    } as unknown as CloudflareEnv) as unknown as RefreshableGitHubTokenService;

    const result = await service.refreshInstallationAccountLoginIfDue('123', 'lite');

    expect(result).toBeNull();
    expect(tokenCache.put).not.toHaveBeenCalled();
    expect(Octokit).not.toHaveBeenCalled();
    expect(createAppAuth).not.toHaveBeenCalled();
  });

  it('cools down failed login refresh attempts to avoid repeated upstream requests', async () => {
    let cooldownValue: string | null = null;
    const tokenCache = {
      get: vi.fn(async () => cooldownValue),
      put: vi.fn(async (_key: string, value: string) => {
        cooldownValue = value;
      }),
    };
    vi.mocked(createAppAuth).mockReturnValue(
      vi.fn().mockResolvedValue({ token: 'app-jwt' }) as unknown as ReturnType<typeof createAppAuth>
    );
    mockGetInstallation.mockRejectedValue(new Error('unavailable'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const service = new GitHubTokenService({
      GITHUB_APP_ID: 'app-id',
      GITHUB_APP_PRIVATE_KEY: 'private-key',
      TOKEN_CACHE: tokenCache,
    } as unknown as CloudflareEnv) as unknown as RefreshableGitHubTokenService;

    expect(await service.refreshInstallationAccountLoginIfDue('123')).toBeNull();
    expect(await service.refreshInstallationAccountLoginIfDue('123')).toBeNull();

    expect(tokenCache.put).toHaveBeenCalledTimes(1);
    expect(mockGetInstallation).toHaveBeenCalledTimes(1);
  });

  it('does not log authenticated response data when installation login refresh fails', async () => {
    const upstreamError = Object.assign(new Error('metadata lookup unavailable'), {
      response: { data: { token: 'sensitive-metadata-response' } },
    });
    vi.mocked(createAppAuth).mockReturnValue(
      vi.fn().mockResolvedValue({ token: 'app-jwt' }) as unknown as ReturnType<typeof createAppAuth>
    );
    mockGetInstallation.mockRejectedValue(upstreamError);
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
