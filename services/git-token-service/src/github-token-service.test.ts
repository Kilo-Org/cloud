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
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
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

  it('looks up the authoritative repository installation as the selected app', async () => {
    vi.mocked(createAppAuth).mockReturnValue(
      vi.fn().mockResolvedValue({ token: 'app-jwt' }) as unknown as ReturnType<typeof createAppAuth>
    );
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({ id: 987654 }, { headers: { 'Content-Length': '13' } })
    );
    const service = new GitHubTokenService({
      GITHUB_LITE_APP_ID: 'lite-app-id',
      GITHUB_LITE_APP_PRIVATE_KEY: 'lite-private-key',
    } as CloudflareEnv);

    await expect(service.findRepositoryInstallation('acme/repository', 'lite')).resolves.toEqual({
      status: 'installed',
      installationId: '987654',
    });
    expect(createAppAuth).toHaveBeenCalledWith({
      appId: 'lite-app-id',
      privateKey: 'lite-private-key',
    });
    expect(fetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/acme/repository/installation',
      expect.objectContaining({
        method: 'GET',
        redirect: 'manual',
        signal: expect.any(AbortSignal),
        headers: expect.objectContaining({ Authorization: 'Bearer app-jwt' }),
      })
    );
  });

  it('treats only a repository installation 404 as definitive no installation', async () => {
    vi.mocked(createAppAuth).mockReturnValue(
      vi.fn().mockResolvedValue({ token: 'app-jwt' }) as unknown as ReturnType<typeof createAppAuth>
    );
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 404 }));
    const service = new GitHubTokenService({
      GITHUB_APP_ID: 'app-id',
      GITHUB_APP_PRIVATE_KEY: 'private-key',
    } as CloudflareEnv);

    await expect(service.findRepositoryInstallation('acme/repository')).resolves.toEqual({
      status: 'not_installed',
    });
  });

  it.each([401, 403, 422, 429, 500, 503])(
    'treats repository installation status %s as temporary failure',
    async status => {
      vi.mocked(createAppAuth).mockReturnValue(
        vi.fn().mockResolvedValue({ token: 'app-jwt' }) as unknown as ReturnType<
          typeof createAppAuth
        >
      );
      vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status }));
      const service = new GitHubTokenService({
        GITHUB_APP_ID: 'app-id',
        GITHUB_APP_PRIVATE_KEY: 'private-key',
      } as CloudflareEnv);

      await expect(service.findRepositoryInstallation('acme/repository')).resolves.toEqual({
        status: 'temporarily_unavailable',
      });
    }
  );

  it('rejects redirects without following them', async () => {
    vi.mocked(createAppAuth).mockReturnValue(
      vi.fn().mockResolvedValue({ token: 'app-jwt' }) as unknown as ReturnType<typeof createAppAuth>
    );
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { Location: 'https://example.com' } })
    );
    const service = new GitHubTokenService({
      GITHUB_APP_ID: 'app-id',
      GITHUB_APP_PRIVATE_KEY: 'private-key',
    } as CloudflareEnv);

    await expect(service.findRepositoryInstallation('acme/repository')).resolves.toEqual({
      status: 'temporarily_unavailable',
    });
    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ redirect: 'manual' })
    );
  });

  it('classifies lookup timeout as temporary failure', async () => {
    vi.mocked(createAppAuth).mockReturnValue(
      vi.fn().mockResolvedValue({ token: 'app-jwt' }) as unknown as ReturnType<typeof createAppAuth>
    );
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(AbortSignal.abort());
    vi.mocked(fetch).mockRejectedValueOnce(new DOMException('Timed out', 'TimeoutError'));
    const service = new GitHubTokenService({
      GITHUB_APP_ID: 'app-id',
      GITHUB_APP_PRIVATE_KEY: 'private-key',
    } as CloudflareEnv);

    await expect(service.findRepositoryInstallation('acme/repository')).resolves.toEqual({
      status: 'temporarily_unavailable',
    });
  });

  it.each([
    new Response('{"id":"123"}', { headers: { 'Content-Type': 'application/json' } }),
    new Response('{"id":123}', { headers: { 'Content-Type': 'text/plain' } }),
    new Response('{"id":123}', {
      headers: { 'Content-Type': 'application/json', 'Content-Length': '64001' },
    }),
  ])('rejects an invalid or unbounded installation response', async response => {
    vi.mocked(createAppAuth).mockReturnValue(
      vi.fn().mockResolvedValue({ token: 'app-jwt' }) as unknown as ReturnType<typeof createAppAuth>
    );
    vi.mocked(fetch).mockResolvedValueOnce(response);
    const service = new GitHubTokenService({
      GITHUB_APP_ID: 'app-id',
      GITHUB_APP_PRIVATE_KEY: 'private-key',
    } as CloudflareEnv);

    await expect(service.findRepositoryInstallation('acme/repository')).resolves.toEqual({
      status: 'temporarily_unavailable',
    });
  });

  it('reuses a cached scoped token only after authoritative resolution selects its row', async () => {
    const expiresAt = Date.now() + 60 * 60_000;
    let cached: unknown = null;
    const tokenCache = {
      get: vi.fn(async (_key: string, type?: string) => (type === 'json' ? cached : null)),
      put: vi.fn(async (_key: string, value: string) => {
        cached = JSON.parse(value);
      }),
    };
    const installationAuth = vi.fn().mockResolvedValue({ token: 'scoped-token', expiresAt });
    vi.mocked(createAppAuth).mockReturnValue(
      installationAuth as unknown as ReturnType<typeof createAppAuth>
    );
    const service = new GitHubTokenService({
      GITHUB_APP_ID: 'app-id',
      GITHUB_APP_PRIVATE_KEY: 'private-key',
      TOKEN_CACHE: tokenCache,
    } as unknown as CloudflareEnv);

    await expect(service.getTokenForRepo('123', 'repository')).resolves.toBe('scoped-token');
    await expect(service.getTokenForRepo('123', 'repository')).resolves.toBe('scoped-token');

    expect(installationAuth).toHaveBeenCalledOnce();
    expect(tokenCache.get).toHaveBeenCalledWith('gh-token:123:standard:repository', 'json');
    expect(tokenCache.put).toHaveBeenCalledOnce();
  });
});
