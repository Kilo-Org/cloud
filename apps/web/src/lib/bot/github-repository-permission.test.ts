jest.mock('@/lib/integrations/github/runtime-authorization', () => ({
  GitHubRuntimeAuthorizationError: class GitHubRuntimeAuthorizationError extends Error {},
  assertGitHubInstallationRuntimeAuthorized: jest.fn(async () => undefined),
}));

import type { PlatformIntegration } from '@kilocode/db';
import {
  assertGitHubInstallationRuntimeAuthorized,
  GitHubRuntimeAuthorizationError,
} from '@/lib/integrations/github/runtime-authorization';
import {
  authorizeGitHubRepository,
  getGitHubRepositoryPermission,
  GITHUB_REPOSITORY_PERMISSION_CACHE_TTL_MS,
  MAX_CACHED_REPOSITORY_PERMISSIONS,
} from './github-repository-permission';
import {
  GitHubCredentialRejectionError,
  GitHubRateLimitError,
} from '@/lib/integrations/platforms/github/adapter';

const mockedAssertAuthorized = jest.mocked(assertGitHubInstallationRuntimeAuthorized);

type Permission = 'admin' | 'maintain' | 'write' | 'read' | 'none' | null;

function createIntegration(overrides: Partial<PlatformIntegration> = {}): PlatformIntegration {
  return {
    id: 'pi_github_1',
    platform: 'github',
    owned_by_organization_id: 'org_1',
    owned_by_user_id: null,
    platform_installation_id: '98765',
    github_app_type: 'standard',
    ...overrides,
  } as PlatformIntegration;
}

function createFetchPermission(permission: Permission) {
  return jest.fn(async () => permission as 'admin' | 'maintain' | 'write' | 'read' | 'none' | null);
}

/** A lookup 401: GitHub rejected the installation token, not the App credentials. */
function httpStatusError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedAssertAuthorized.mockResolvedValue(undefined);
});

describe('authorizeGitHubRepository', () => {
  test.each([
    ['read', false],
    ['none', false],
    ['write', true],
    ['maintain', true],
    ['admin', true],
  ] as const)('a %s collaborator is %s', async (permission, expectedAllowed) => {
    const fetchPermission = createFetchPermission(permission);

    const result = await authorizeGitHubRepository({
      platformIntegration: createIntegration(),
      repository: 'acme/widgets',
      actorLogin: `permission-${permission}`,
      fetchPermission,
    });

    expect(result.allowed).toBe(expectedAllowed);
    if (!result.allowed) {
      expect(result.markdown).toContain('write access');
      expect(result.markdown).toContain('`acme/widgets`');
    }
    expect(fetchPermission).toHaveBeenCalledWith(
      '98765',
      'acme',
      'widgets',
      `permission-${permission}`,
      'standard',
      'pi_github_1'
    );
  });

  test('an organization member without repository access is not allowed', async () => {
    const fetchPermission = createFetchPermission('none');

    const result = await authorizeGitHubRepository({
      platformIntegration: createIntegration(),
      repository: 'acme/no-access',
      actorLogin: 'org-member',
      fetchPermission,
    });

    expect(result).toEqual({ allowed: false, markdown: expect.stringContaining('write access') });
  });

  test('a definitive no-permission answer is not retried', async () => {
    const fetchPermission = createFetchPermission(null);

    const result = await authorizeGitHubRepository({
      platformIntegration: createIntegration(),
      repository: 'acme/no-answer',
      actorLogin: 'octocat',
      fetchPermission,
    });

    expect(result.allowed).toBe(false);
    expect(fetchPermission).toHaveBeenCalledTimes(1);
  });

  test('an unreachable GitHub is reported as temporary, not as a denial', async () => {
    const fetchPermission = createFetchPermission('write');
    const lookupError = new Error('GitHub rate limited until 2026-11-17T00:01:00.000Z');
    fetchPermission.mockRejectedValue(lookupError);

    const result = await authorizeGitHubRepository({
      platformIntegration: createIntegration(),
      repository: 'acme/unreachable',
      actorLogin: 'octocat',
      fetchPermission,
    });

    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error('expected a refusal');
    expect(result.markdown).not.toContain('write access');
    expect(result.markdown).toContain('`acme/unreachable`');
    expect(result.markdown).toContain('temporary');
    expect(fetchPermission).toHaveBeenCalledTimes(2);
  });

  test('a rate-limited lookup names the rate limit and is not retried', async () => {
    const fetchPermission = createFetchPermission('write');
    const rateLimitError = new GitHubRateLimitError(new Date('2026-11-17T01:00:00.000Z'));
    fetchPermission.mockRejectedValue(rateLimitError);
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-17T00:48:00.000Z'));

    try {
      const result = await authorizeGitHubRepository({
        platformIntegration: createIntegration(),
        repository: 'acme/rate-limited',
        actorLogin: 'octocat',
        fetchPermission,
      });

      expect(result.allowed).toBe(false);
      if (result.allowed) throw new Error('expected a refusal');
      expect(result.markdown).toContain('rate limit');
      expect(result.markdown).toContain('`acme/rate-limited`');
      expect(result.markdown).toContain('GitHub resets it at 01:00 UTC (in 12 minutes)');
      expect(result.markdown).not.toContain('write access');
      expect(fetchPermission).toHaveBeenCalledTimes(1);
    } finally {
      jest.restoreAllMocks();
    }
  });

  test('rejected App credentials are reported as a configuration failure, not as temporary', async () => {
    const fetchPermission = createFetchPermission('write');
    fetchPermission.mockRejectedValue(
      new GitHubCredentialRejectionError(httpStatusError(401, 'Bad credentials'))
    );

    const result = await authorizeGitHubRepository({
      platformIntegration: createIntegration(),
      repository: 'acme/bad-credentials',
      actorLogin: 'octocat',
      fetchPermission,
    });

    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error('expected a refusal');
    expect(result.markdown).toContain('`acme/bad-credentials`');
    expect(result.markdown).toContain('credentials were rejected');
    expect(result.markdown).not.toContain('temporary');
    expect(result.markdown).not.toContain('write access');
    expect(fetchPermission).toHaveBeenCalledTimes(1);
  });

  test('credentials rejected on the retry end as a configuration failure, not as temporary', async () => {
    const fetchPermission = createFetchPermission('write');
    fetchPermission
      .mockRejectedValueOnce(new Error('boom'))
      .mockRejectedValueOnce(
        new GitHubCredentialRejectionError(httpStatusError(401, 'Bad credentials'))
      );

    const result = await authorizeGitHubRepository({
      platformIntegration: createIntegration(),
      repository: 'acme/rotated-credentials',
      actorLogin: 'octocat',
      fetchPermission,
    });

    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error('expected a refusal');
    expect(result.markdown).toContain('credentials were rejected');
    expect(result.markdown).not.toContain('temporary');
    expect(fetchPermission).toHaveBeenCalledTimes(2);
  });

  test('a permission lookup that fails once is retried and allowed', async () => {
    const fetchPermission = createFetchPermission('write');
    fetchPermission.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce('write');

    const result = await authorizeGitHubRepository({
      platformIntegration: createIntegration(),
      repository: 'acme/recovered',
      actorLogin: 'octocat',
      fetchPermission,
    });

    expect(result).toEqual({ allowed: true });
    expect(fetchPermission).toHaveBeenCalledTimes(2);
  });

  test('a lookup 401 on the first attempt is retried and allowed', async () => {
    const fetchPermission = createFetchPermission('write');
    fetchPermission
      .mockRejectedValueOnce(httpStatusError(401, 'Bad credentials'))
      .mockResolvedValueOnce('write');

    const result = await authorizeGitHubRepository({
      platformIntegration: createIntegration(),
      repository: 'acme/stale-token',
      actorLogin: 'octocat',
      fetchPermission,
    });

    expect(result).toEqual({ allowed: true });
    expect(fetchPermission).toHaveBeenCalledTimes(2);
  });

  test('a lookup 401 on the second attempt reads as temporary, not as a credential failure', async () => {
    const fetchPermission = createFetchPermission('write');
    fetchPermission
      .mockRejectedValueOnce(new Error('boom'))
      .mockRejectedValueOnce(httpStatusError(401, 'Bad credentials'));

    const result = await authorizeGitHubRepository({
      platformIntegration: createIntegration(),
      repository: 'acme/stale-token-again',
      actorLogin: 'octocat',
      fetchPermission,
    });

    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error('expected a refusal');
    expect(result.markdown).toContain('temporary');
    expect(result.markdown).not.toContain('credentials were rejected');
    expect(fetchPermission).toHaveBeenCalledTimes(2);
  });

  test('the retry waits the injected delay before the second attempt', async () => {
    jest.useFakeTimers();
    const fetchPermission = createFetchPermission('write');
    fetchPermission.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce('write');

    const resultPromise = authorizeGitHubRepository({
      platformIntegration: createIntegration(),
      repository: 'acme/retry-delay',
      actorLogin: 'octocat',
      fetchPermission,
      retryDelayMs: 500,
    });

    // The second attempt happens only after the timer advances past the delay.
    // The first flush lets the first attempt's awaited promises settle.
    try {
      await jest.advanceTimersByTimeAsync(0);
      expect(fetchPermission).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(499);
      expect(fetchPermission).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      await expect(resultPromise).resolves.toEqual({ allowed: true });
      expect(fetchPermission).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  test('personally owned integrations do not consult repository permissions', async () => {
    const fetchPermission = createFetchPermission('none');

    const result = await authorizeGitHubRepository({
      platformIntegration: createIntegration({
        owned_by_organization_id: null,
        owned_by_user_id: 'user_1',
      }),
      repository: 'acme/personal',
      actorLogin: 'octocat',
      fetchPermission,
    });

    expect(result).toEqual({ allowed: true });
    expect(fetchPermission).not.toHaveBeenCalled();
  });

  describe('chat integration repositories', () => {
    test.each(['slack', 'linear'] as const)(
      'allows an organization-owned %s integration without a linked GitHub identity',
      async platform => {
        const fetchPermission = createFetchPermission('none');

        const result = await authorizeGitHubRepository({
          platformIntegration: createIntegration({ platform, platform_installation_id: null }),
          repository: 'acme/no-identity',
          fetchPermission,
        });

        expect(result).toEqual({ allowed: true });
        expect(fetchPermission).not.toHaveBeenCalled();
        expect(mockedAssertAuthorized).not.toHaveBeenCalled();
      }
    );

    test.each(['slack', 'linear'] as const)(
      "does not check an actor's GitHub write access for a %s integration",
      async platform => {
        const fetchPermission = createFetchPermission('read');

        const result = await authorizeGitHubRepository({
          platformIntegration: createIntegration({ platform }),
          repository: 'acme/read-only',
          actorLogin: 'read-only-user',
          fetchPermission,
        });

        expect(result).toEqual({ allowed: true });
        expect(fetchPermission).not.toHaveBeenCalled();
      }
    );

    test('allows a chat integration call without a repository', async () => {
      const fetchPermission = createFetchPermission('none');

      const result = await authorizeGitHubRepository({
        platformIntegration: createIntegration({ platform: 'slack' }),
        repository: null,
        fetchPermission,
      });

      expect(result).toEqual({ allowed: true });
      expect(fetchPermission).not.toHaveBeenCalled();
    });

    test('keeps personally owned chat integrations owner-controlled', async () => {
      const fetchPermission = createFetchPermission('none');

      const result = await authorizeGitHubRepository({
        platformIntegration: createIntegration({
          platform: 'slack',
          owned_by_organization_id: null,
          owned_by_user_id: 'user_1',
        }),
        repository: 'acme/personal',
        fetchPermission,
      });

      expect(result).toEqual({ allowed: true });
      expect(fetchPermission).not.toHaveBeenCalled();
    });
  });

  test('a missing triggering login may only use the conversation repository', async () => {
    const fetchPermission = createFetchPermission('none');
    const platformIntegration = createIntegration();

    await expect(
      authorizeGitHubRepository({
        platformIntegration,
        repository: 'acme/thread-repo',
        threadRepository: 'ACME/Thread-Repo',
        fetchPermission,
      })
    ).resolves.toEqual({ allowed: true });

    await expect(
      authorizeGitHubRepository({
        platformIntegration,
        repository: 'acme/other-repo',
        threadRepository: 'acme/thread-repo',
        fetchPermission,
      })
    ).resolves.toEqual({ allowed: false, markdown: expect.stringContaining('`acme/other-repo`') });

    expect(fetchPermission).not.toHaveBeenCalled();
  });

  test('a rejected installation authorization reports the connection unavailable', async () => {
    mockedAssertAuthorized.mockRejectedValueOnce(new GitHubRuntimeAuthorizationError());
    const fetchPermission = createFetchPermission('write');

    const result = await authorizeGitHubRepository({
      platformIntegration: createIntegration(),
      repository: 'acme/disconnected',
      actorLogin: 'octocat',
      fetchPermission,
    });

    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error('expected a refusal');
    expect(result.markdown).toContain('`acme/disconnected`');
    expect(result.markdown).toContain('reconnect');
    expect(result.markdown).toContain('organization admin');
    expect(fetchPermission).not.toHaveBeenCalled();
  });

  test('an unexpected pre-check failure is reported as temporary, not as a denial', async () => {
    mockedAssertAuthorized.mockRejectedValueOnce(new Error('database unavailable'));
    const fetchPermission = createFetchPermission('write');

    const result = await authorizeGitHubRepository({
      platformIntegration: createIntegration(),
      repository: 'acme/precheck-failure',
      actorLogin: 'octocat',
      fetchPermission,
    });

    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error('expected a refusal');
    expect(result.markdown).toContain('`acme/precheck-failure`');
    expect(result.markdown).toContain('temporary');
    expect(fetchPermission).not.toHaveBeenCalled();
  });
});

describe('getGitHubRepositoryPermission cache', () => {
  test('reuses a cached permission and refreshes it after the TTL', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-20T00:00:00Z') });
    try {
      const fetchPermission = createFetchPermission('write');
      const input = {
        installationId: '5001',
        appType: 'standard' as const,
        owner: 'Acme',
        repo: 'Cache',
        username: 'Octocat',
      };

      await getGitHubRepositoryPermission(input, fetchPermission);
      await getGitHubRepositoryPermission(
        { ...input, owner: 'acme', repo: 'cache', username: 'octocat' },
        fetchPermission
      );
      expect(fetchPermission).toHaveBeenCalledTimes(1);

      jest.setSystemTime(Date.now() + GITHUB_REPOSITORY_PERMISSION_CACHE_TTL_MS + 1);

      await getGitHubRepositoryPermission(input, fetchPermission);
      expect(fetchPermission).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  test('caches per repository and per account', async () => {
    const fetchPermission = createFetchPermission('read');
    const base = {
      installationId: '5002',
      appType: 'standard' as const,
      owner: 'acme',
      repo: 'secrets',
      username: 'octocat',
    };

    await getGitHubRepositoryPermission(base, fetchPermission);
    await getGitHubRepositoryPermission({ ...base, repo: 'other' }, fetchPermission);
    await getGitHubRepositoryPermission({ ...base, username: 'hubber' }, fetchPermission);

    expect(fetchPermission).toHaveBeenCalledTimes(3);
  });

  test('does not cache a failed lookup', async () => {
    const fetchPermission = createFetchPermission(null);
    const input = {
      installationId: '5003',
      appType: 'standard' as const,
      owner: 'acme',
      repo: 'uncached',
      username: 'octocat',
    };

    await getGitHubRepositoryPermission(input, fetchPermission);
    await getGitHubRepositoryPermission(input, fetchPermission);

    expect(fetchPermission).toHaveBeenCalledTimes(2);
  });

  test('evicts the oldest entry when the cache reaches its bound', async () => {
    const fetchPermission = createFetchPermission('write');
    const base = {
      installationId: '5004',
      appType: 'standard' as const,
      owner: 'acme',
      repo: 'bounded',
      username: 'octocat',
    };
    const first = { ...base, repo: 'first' };

    await getGitHubRepositoryPermission(first, fetchPermission);
    for (let index = 0; index <= MAX_CACHED_REPOSITORY_PERMISSIONS; index += 1) {
      await getGitHubRepositoryPermission({ ...base, repo: `repo-${index}` }, fetchPermission);
    }

    const callsAfterFill = fetchPermission.mock.calls.length;
    await getGitHubRepositoryPermission(first, fetchPermission);
    expect(fetchPermission.mock.calls.length).toBe(callsAfterFill + 1);

    const recent = { ...base, repo: `repo-${MAX_CACHED_REPOSITORY_PERMISSIONS}` };
    await getGitHubRepositoryPermission(recent, fetchPermission);
    expect(fetchPermission.mock.calls.length).toBe(callsAfterFill + 1);
  });
});
