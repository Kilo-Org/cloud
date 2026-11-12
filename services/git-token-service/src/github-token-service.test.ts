import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import {
  GitHubRepositoryPermissionsUnavailableError,
  GitHubTokenGenerationError,
  GitHubTokenService,
} from './github-token-service.js';

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

  it('requests only selected-repository permissions and never reuses an unrestricted cache entry', async () => {
    const cache = new Map<string, unknown>();
    const tokenCache = {
      get: vi.fn(async (key: string) => cache.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => {
        cache.set(key, JSON.parse(value));
      }),
    };
    const auth = vi.fn().mockImplementation(async (params: { permissions?: object }) => ({
      token: params.permissions ? 'repository-only-token' : 'legacy-token',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }));
    vi.mocked(createAppAuth).mockReturnValue(Object.assign(auth, { hook: vi.fn() }));
    const service = new GitHubTokenService({
      GITHUB_APP_ID: 'app-id',
      GITHUB_APP_PRIVATE_KEY: 'synthetic-key',
      TOKEN_CACHE: tokenCache,
    } as unknown as CloudflareEnv);
    expect(await service.getTokenForRepo('123', 'repo')).toBe('legacy-token');
    const permissions = {
      contents: 'write',
      pull_requests: 'write',
      issues: 'write',
      metadata: 'read',
      members: 'write',
      organization_administration: 'write',
      organization_secrets: 'read',
      email_addresses: 'read',
      unknown_future_permission: 'write',
    };
    expect(await service.getRepositoryOnlyToken('123', 'repo', 'standard', permissions)).toBe(
      'repository-only-token'
    );
    expect(auth.mock.calls[1]?.[0]).toEqual({
      type: 'installation',
      repositoryNames: ['repo'],
      permissions: { contents: 'write', pull_requests: 'write', issues: 'write', metadata: 'read' },
    });
    expect(tokenCache.put.mock.calls[1]?.[0]).toMatch(
      /^gh-token:123:standard:repo:repository-only:v1:[a-f0-9]{64}$/
    );
    expect(await service.getRepositoryOnlyToken('123', 'repo', 'standard', permissions)).toBe(
      'repository-only-token'
    );
    expect(auth).toHaveBeenCalledTimes(2);
    await service.getRepositoryOnlyToken('123', 'repo', 'standard', { contents: 'read' });
    await service.getRepositoryOnlyToken('123', 'other-repo', 'standard', permissions);
    expect(auth).toHaveBeenCalledTimes(4);
    expect(auth.mock.calls[2]?.[0]).toMatchObject({ permissions: { contents: 'read' } });
    expect(auth.mock.calls[3]?.[0]).toMatchObject({ repositoryNames: ['other-repo'] });
    expect(await service.getTokenForRepo('123', 'repo')).toBe('legacy-token');
  });

  it('bounds wide permission cache keys and isolates normalized permission policies', async () => {
    const cache = new Map<string, unknown>();
    const checkKey = (key: string) =>
      expect(Buffer.byteLength(key, 'utf8')).toBeLessThanOrEqual(512);
    const tokenCache = {
      get: vi.fn(async (key: string) => {
        checkKey(key);
        return cache.get(key) ?? null;
      }),
      put: vi.fn(async (key: string, value: string) => {
        checkKey(key);
        cache.set(key, JSON.parse(value));
      }),
    };
    const permissions = {
      actions: 'write',
      administration: 'write',
      artifact_metadata: 'write',
      attestations: 'write',
      checks: 'write',
      code_quality: 'write',
      codespaces: 'write',
      contents: 'write',
      dependabot_secrets: 'write',
      deployments: 'write',
      discussions: 'write',
      environments: 'write',
      issues: 'write',
      merge_queues: 'write',
      metadata: 'read',
      packages: 'write',
      pages: 'write',
      pull_requests: 'write',
      repository_custom_properties: 'write',
      repository_hooks: 'write',
      repository_projects: 'admin',
      secret_scanning_alerts: 'write',
      secrets: 'write',
      security_events: 'write',
      single_file: 'write',
      statuses: 'write',
      vulnerability_alerts: 'write',
      workflows: 'write',
    };
    const repoName = 'r'.repeat(100);
    expect(
      Buffer.byteLength(
        `gh-token:123:standard:${repoName}:repository-only:v1:${JSON.stringify(permissions)}`,
        'utf8'
      )
    ).toBeGreaterThan(512);
    const auth = vi
      .fn()
      .mockResolvedValueOnce({
        token: 'wide-policy-token',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      })
      .mockResolvedValueOnce({
        token: 'read-contents-token',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      });
    vi.mocked(createAppAuth).mockReturnValue(Object.assign(auth, { hook: vi.fn() }));
    const service = new GitHubTokenService({
      GITHUB_APP_ID: 'app-id',
      GITHUB_APP_PRIVATE_KEY: 'synthetic-key',
      TOKEN_CACHE: tokenCache,
    } as unknown as CloudflareEnv);

    expect(await service.getRepositoryOnlyToken('123', repoName, 'standard', permissions)).toBe(
      'wide-policy-token'
    );
    expect(auth.mock.calls[0]?.[0]).toMatchObject({
      repositoryNames: [repoName],
      permissions,
    });
    const reordered = Object.fromEntries(Object.entries(permissions).reverse());
    expect(await service.getRepositoryOnlyToken('123', repoName, 'standard', reordered)).toBe(
      'wide-policy-token'
    );
    expect(
      await service.getRepositoryOnlyToken('123', repoName, 'standard', {
        ...permissions,
        contents: 'read',
      })
    ).toBe('read-contents-token');
    expect(auth).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(2);
    for (const key of cache.keys()) {
      expect(key).toMatch(
        new RegExp(`^gh-token:123:standard:${repoName}:repository-only:v1:[a-f0-9]{64}$`)
      );
    }
  });

  it.each([null, {}])(
    'loads missing stored permissions from the trusted installation API: %j',
    async permissions => {
      const auth = vi.fn().mockImplementation(async (params: { type: string }) =>
        params.type === 'app'
          ? { token: 'synthetic-app-jwt' }
          : {
              token: 'repository-only-token',
              expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            }
      );
      vi.mocked(createAppAuth).mockReturnValue(Object.assign(auth, { hook: vi.fn() }));
      mockGetInstallation.mockResolvedValue({
        data: {
          permissions: {
            contents: 'read',
            pull_requests: 'read',
            members: 'read',
            organization_administration: 'write',
          },
        },
      });
      const service = new GitHubTokenService({
        GITHUB_LITE_APP_ID: 'lite-app-id',
        GITHUB_LITE_APP_PRIVATE_KEY: 'synthetic-lite-key',
      } as CloudflareEnv);

      expect(await service.getRepositoryOnlyToken('123', 'repo', 'lite', permissions)).toBe(
        'repository-only-token'
      );
      expect(createAppAuth).toHaveBeenNthCalledWith(1, {
        appId: 'lite-app-id',
        privateKey: 'synthetic-lite-key',
      });
      expect(Octokit).toHaveBeenCalledWith({ auth: 'synthetic-app-jwt' });
      expect(mockGetInstallation).toHaveBeenCalledWith({ installation_id: 123 });
      expect(auth.mock.calls).toEqual([
        [{ type: 'app' }],
        [
          {
            type: 'installation',
            repositoryNames: ['repo'],
            permissions: { contents: 'read', pull_requests: 'read' },
          },
        ],
      ]);
    }
  );

  it('fails closed on unavailable lookup and permits a later request to recover without broad issuance', async () => {
    const secret = 'sensitive-provider-response';
    const auth = vi.fn().mockImplementation(async (params: { type: string }) =>
      params.type === 'app'
        ? { token: 'synthetic-app-jwt' }
        : {
            token: 'repository-only-token',
            expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          }
    );
    vi.mocked(createAppAuth).mockReturnValue(Object.assign(auth, { hook: vi.fn() }));
    mockGetInstallation
      .mockRejectedValueOnce(new Error(secret))
      .mockResolvedValueOnce({ data: { permissions: { contents: 'write', members: 'write' } } });
    const tokenCache = createTokenCache();
    const service = new GitHubTokenService({
      GITHUB_APP_ID: 'app-id',
      GITHUB_APP_PRIVATE_KEY: 'synthetic-key',
      TOKEN_CACHE: tokenCache,
    } as unknown as CloudflareEnv);

    const error = await service
      .getRepositoryOnlyToken('123', 'repo', 'standard', null)
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(GitHubRepositoryPermissionsUnavailableError);
    expect(error).toMatchObject({
      message: 'GitHub repository permissions are unavailable; retry the request',
    });
    expect(error).not.toHaveProperty('cause');
    expect(String(error)).not.toContain(secret);
    expect(auth).toHaveBeenCalledExactlyOnceWith({ type: 'app' });
    expect(tokenCache.put).not.toHaveBeenCalled();

    expect(await service.getRepositoryOnlyToken('123', 'repo', 'standard', null)).toBe(
      'repository-only-token'
    );
    expect(auth.mock.calls[2]?.[0]).toEqual({
      type: 'installation',
      repositoryNames: ['repo'],
      permissions: { contents: 'write' },
    });
    expect(mockGetInstallation).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, null, {}, { members: 'write' }, { contents: 'admin' }])(
    'never issues a token for unavailable or invalid trusted permissions: %j',
    async permissions => {
      const auth = vi.fn().mockResolvedValue({ token: 'synthetic-app-jwt' });
      vi.mocked(createAppAuth).mockReturnValue(Object.assign(auth, { hook: vi.fn() }));
      mockGetInstallation.mockResolvedValue({ data: { permissions } });
      const service = new GitHubTokenService({
        GITHUB_APP_ID: 'app-id',
        GITHUB_APP_PRIVATE_KEY: 'synthetic-key',
      } as CloudflareEnv);
      await expect(
        service.getRepositoryOnlyToken('123', 'repo', 'standard', null)
      ).rejects.toBeInstanceOf(GitHubRepositoryPermissionsUnavailableError);
      expect(auth).toHaveBeenCalledExactlyOnceWith({ type: 'app' });
    }
  );

  it.each([{ members: 'write' }, { contents: 'admin' }])(
    'fails closed without valid repository permission metadata: %j',
    async permissions => {
      const service = new GitHubTokenService({} as CloudflareEnv);
      await expect(
        service.getRepositoryOnlyToken('123', 'repo', 'standard', permissions)
      ).rejects.toThrow();
      expect(createAppAuth).not.toHaveBeenCalled();
    }
  );

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

  it.each([
    [404, 'Not Found', 'no_installation_found'],
    [403, 'Resource not accessible by integration', 'repository_not_installed'],
    [
      422,
      'There is at least one repository that does not exist or is not accessible to the parent installation.',
      'repository_not_installed',
    ],
  ] as const)(
    'preserves the expected GitHub %s token failure as %s without exposing credentials',
    async (status, message, reason) => {
      const secret = 'sensitive-upstream-credential';
      const upstreamError = Object.assign(new Error(`provider detail: ${secret}`), {
        status,
        request: { headers: { authorization: `Bearer ${secret}` } },
        response: { data: { message, token: secret } },
      });
      const auth = vi.fn().mockRejectedValue(upstreamError);
      vi.mocked(createAppAuth).mockReturnValue(Object.assign(auth, { hook: vi.fn() }));
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const tokenCache = createTokenCache();
      const service = new GitHubTokenService({
        GITHUB_APP_ID: 'app-id',
        GITHUB_APP_PRIVATE_KEY: 'private-key',
        TOKEN_CACHE: tokenCache,
      } as unknown as CloudflareEnv);

      const error = await service
        .getTokenForRepo('123', 'repository')
        .catch((error: unknown) => error);

      expect(error).toBeInstanceOf(GitHubTokenGenerationError);
      expect(error).toMatchObject({
        status,
        reason,
        rejectionProvenance: status === 404 ? 'installation_token_http404' : undefined,
        message: 'Failed to generate GitHub installation token',
      });
      expect(error).not.toHaveProperty('cause');
      expect(JSON.stringify({ error, logs: consoleError.mock.calls })).not.toContain(secret);
      expect(consoleError).toHaveBeenCalledWith(
        JSON.stringify({ message: 'Failed to generate GitHub installation token', status, reason })
      );
      expect(auth).toHaveBeenCalledOnce();
      expect(tokenCache.put).not.toHaveBeenCalled();
    }
  );

  it.each([
    [403, 'API rate limit exceeded'],
    [403, 'You have exceeded a secondary rate limit.'],
    [403, 'Forbidden'],
    [429, 'Too Many Requests'],
    [401, 'Bad credentials'],
    [422, 'The permissions requested are not granted to this installation.'],
    [500, 'Resource not accessible by integration'],
    [undefined, 'Not Found'],
    [undefined, 'Resource not accessible by integration'],
  ])(
    'does not infer repository access from unrecognized %s token errors',
    async (status, message) => {
      const upstreamError = Object.assign(new Error('secret-provider-detail'), {
        status,
        response: { data: { message, token: 'secret-token' } },
      });
      vi.mocked(createAppAuth).mockReturnValue(
        Object.assign(vi.fn().mockRejectedValue(upstreamError), { hook: vi.fn() })
      );
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const service = new GitHubTokenService({
        GITHUB_APP_ID: 'app-id',
        GITHUB_APP_PRIVATE_KEY: 'private-key',
      } as CloudflareEnv);

      const error = await service
        .getTokenForRepo('123', 'repository')
        .catch((error: unknown) => error);

      expect(error).toBeInstanceOf(GitHubTokenGenerationError);
      expect(error).toMatchObject({
        status,
        reason: undefined,
        message: 'Failed to generate GitHub installation token',
      });
      expect(error).not.toHaveProperty('cause');
      expect(JSON.stringify({ error, logs: consoleError.mock.calls })).not.toContain('secret-');
    }
  );

  it('does not classify token-cache failures as GitHub access failures', async () => {
    const cacheError = Object.assign(new Error('cache unavailable'), { status: 404 });
    const tokenCache = createTokenCache();
    tokenCache.get.mockRejectedValueOnce(cacheError);
    const service = new GitHubTokenService({ TOKEN_CACHE: tokenCache } as unknown as CloudflareEnv);

    await expect(service.getTokenForRepo('123', 'repository')).rejects.toBe(cacheError);
    expect(createAppAuth).not.toHaveBeenCalled();
  });
});
