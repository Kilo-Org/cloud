jest.mock('@/lib/integrations/github/runtime-authorization', () => ({
  assertGitHubInstallationRuntimeAuthorized: jest.fn(async () => undefined),
}));

jest.mock('@/lib/slack-bot/github-repository-context', () => ({
  resolveGitHubRepositoryForOwner: jest.fn(),
}));

jest.mock('@/lib/integrations/db/platform-integrations', () => ({
  getGitHubIntegrationById: jest.fn(),
}));

import type { PlatformIntegration } from '@kilocode/db';
import { assertGitHubInstallationRuntimeAuthorized } from '@/lib/integrations/github/runtime-authorization';
import { resolveGitHubRepositoryForOwner } from '@/lib/slack-bot/github-repository-context';
import { getGitHubIntegrationById } from '@/lib/integrations/db/platform-integrations';
import {
  authorizeGitHubRepository,
  getGitHubRepositoryPermission,
  GITHUB_REPOSITORY_PERMISSION_CACHE_TTL_MS,
  MAX_CACHED_REPOSITORY_PERMISSIONS,
} from './github-repository-permission';

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
      'pi_github_1',
      'workflow'
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

  test('a repeatedly failing permission lookup is denied after one retry', async () => {
    const fetchPermission = createFetchPermission(null);

    const result = await authorizeGitHubRepository({
      platformIntegration: createIntegration(),
      repository: 'acme/lookup-failure',
      actorLogin: 'octocat',
      fetchPermission,
    });

    expect(result.allowed).toBe(false);
    expect(fetchPermission).toHaveBeenCalledTimes(2);
  });

  test('a transient permission lookup failure recovers on the retry', async () => {
    const fetchPermission = createFetchPermission(null);
    fetchPermission.mockResolvedValueOnce(null).mockResolvedValueOnce('write');

    const result = await authorizeGitHubRepository({
      platformIntegration: createIntegration(),
      repository: 'acme/transient',
      actorLogin: 'octocat',
      fetchPermission,
    });

    expect(result).toEqual({ allowed: true });
    expect(fetchPermission).toHaveBeenCalledTimes(2);
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
    const slackIntegration = createIntegration({ id: 'pi_slack_1', platform: 'slack' });
    const linearIntegration = createIntegration({ id: 'pi_linear_1', platform: 'linear' });
    const githubConnection = createIntegration({ id: 'pi_github_1' });
    const requesterLogin = async () => 'octocat';

    beforeEach(() => {
      // Each case names its own repository: the permission cache is keyed by
      // repository and account, so a shared name would reuse another case.
      jest.mocked(resolveGitHubRepositoryForOwner).mockImplementation(async (_owner, fullName) => ({
        id: 7,
        name: fullName.split('/')[1] ?? fullName,
        full_name: fullName,
        private: true,
        githubIntegrationId: 'pi_github_1',
        githubAppType: 'standard',
      }));
      jest.mocked(getGitHubIntegrationById).mockResolvedValue(githubConnection);
    });

    test('allows a repository the requesting account can write to', async () => {
      const fetchPermission = createFetchPermission('write');

      const result = await authorizeGitHubRepository({
        platformIntegration: slackIntegration,
        repository: 'acme/allowed',
        requesterUserId: 'user_1',
        purpose: 'agent',
        getRequesterLogin: requesterLogin,
        fetchPermission,
      });

      expect(result).toEqual({ allowed: true });
      expect(resolveGitHubRepositoryForOwner).toHaveBeenCalledWith(
        { type: 'org', id: 'org_1' },
        'acme/allowed',
        'agent'
      );
      expect(getGitHubIntegrationById).toHaveBeenCalledWith(
        { type: 'org', id: 'org_1' },
        'pi_github_1'
      );
      expect(fetchPermission).toHaveBeenCalledWith(
        '98765',
        'acme',
        'allowed',
        'octocat',
        'standard',
        'pi_github_1',
        'agent'
      );
    });

    test('authorizes a Linear run the same way', async () => {
      const fetchPermission = createFetchPermission('admin');

      const result = await authorizeGitHubRepository({
        platformIntegration: linearIntegration,
        repository: 'acme/linear',
        requesterUserId: 'user_1',
        getRequesterLogin: requesterLogin,
        fetchPermission,
      });

      expect(result).toEqual({ allowed: true });
      expect(resolveGitHubRepositoryForOwner).toHaveBeenCalledWith(
        { type: 'org', id: 'org_1' },
        'acme/linear',
        'workflow'
      );
    });

    test('refuses an account without a linked GitHub identity', async () => {
      const fetchPermission = createFetchPermission('write');

      const result = await authorizeGitHubRepository({
        platformIntegration: slackIntegration,
        repository: 'acme/no-identity',
        requesterUserId: 'user_1',
        getRequesterLogin: async () => null,
        fetchPermission,
      });

      expect(result).toEqual({
        allowed: false,
        markdown: expect.stringContaining('`acme/no-identity`'),
      });
      expect(resolveGitHubRepositoryForOwner).not.toHaveBeenCalled();
      expect(fetchPermission).not.toHaveBeenCalled();
    });

    test('refuses an account whose GitHub identity lacks write access', async () => {
      const fetchPermission = createFetchPermission('read');

      const result = await authorizeGitHubRepository({
        platformIntegration: slackIntegration,
        repository: 'acme/read-only',
        requesterUserId: 'user_1',
        getRequesterLogin: requesterLogin,
        fetchPermission,
      });

      expect(result).toEqual({ allowed: false, markdown: expect.stringContaining('write access') });
      expect(fetchPermission).toHaveBeenCalledTimes(1);
    });

    test('refuses after one retry when the permission lookup keeps failing', async () => {
      const fetchPermission = createFetchPermission(null);

      const result = await authorizeGitHubRepository({
        platformIntegration: slackIntegration,
        repository: 'acme/lookup-failure-chat',
        requesterUserId: 'user_1',
        getRequesterLogin: requesterLogin,
        fetchPermission,
      });

      expect(result.allowed).toBe(false);
      expect(fetchPermission).toHaveBeenCalledTimes(2);
    });

    test('refuses a repository the account connections cannot serve', async () => {
      jest.mocked(resolveGitHubRepositoryForOwner).mockResolvedValue(null);
      const fetchPermission = createFetchPermission('write');

      const result = await authorizeGitHubRepository({
        platformIntegration: slackIntegration,
        repository: 'acme/other',
        requesterUserId: 'user_1',
        getRequesterLogin: requesterLogin,
        fetchPermission,
      });

      expect(result).toEqual({ allowed: false, markdown: expect.stringContaining('`acme/other`') });
      expect(fetchPermission).not.toHaveBeenCalled();
    });

    test('refuses when the connection cannot mint a token for the repository', async () => {
      jest
        .mocked(getGitHubIntegrationById)
        .mockResolvedValue({ ...githubConnection, platform_installation_id: null });
      const fetchPermission = createFetchPermission('write');

      const result = await authorizeGitHubRepository({
        platformIntegration: slackIntegration,
        repository: 'acme/stale-connection',
        requesterUserId: 'user_1',
        getRequesterLogin: requesterLogin,
        fetchPermission,
      });

      expect(result.allowed).toBe(false);
      expect(fetchPermission).not.toHaveBeenCalled();
    });

    test('refuses a rejected installation authorization', async () => {
      mockedAssertAuthorized.mockRejectedValueOnce(new Error('integration suspended'));
      const fetchPermission = createFetchPermission('write');

      const result = await authorizeGitHubRepository({
        platformIntegration: slackIntegration,
        repository: 'acme/suspended-chat',
        requesterUserId: 'user_1',
        getRequesterLogin: requesterLogin,
        fetchPermission,
      });

      expect(result.allowed).toBe(false);
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
        requesterUserId: 'user_1',
        getRequesterLogin: requesterLogin,
        fetchPermission,
      });

      expect(result).toEqual({ allowed: true });
      expect(resolveGitHubRepositoryForOwner).not.toHaveBeenCalled();
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

  test('a rejected installation authorization denies the action', async () => {
    mockedAssertAuthorized.mockRejectedValueOnce(new Error('integration suspended'));
    const fetchPermission = createFetchPermission('write');

    const result = await authorizeGitHubRepository({
      platformIntegration: createIntegration(),
      repository: 'acme/suspended',
      actorLogin: 'octocat',
      fetchPermission,
    });

    expect(result.allowed).toBe(false);
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
