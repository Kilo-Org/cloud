/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the existing DOM-free hook harness. */
import * as React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClientProvider } from '@tanstack/react-query';
import { type TRPCQueryKey } from '@trpc/tanstack-react-query';
import { afterEach, assert, beforeEach, expect, it, vi } from 'vitest';
import { type RepositoryPlatform } from '@/components/agents/new-session-repository-state';
import { createKiloAppQueryClient } from './query-client';
import { setRepositoryDiscoveryError } from './use-github-repos-refresh';
import { useNewSessionRepos } from './use-new-session-repos';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn<(platform: RepositoryPlatform, forceRefresh: boolean) => Promise<unknown>>(),
  browser: vi.fn<() => Promise<string>>(),
  mint: vi.fn<() => Promise<{ token: string }>>(),
  normalRequests: [] as RepositoryPlatform[],
  recents: [] as unknown[],
}));
vi.mock('react-native', () => ({
  AppState: { addEventListener: () => ({ remove: vi.fn() }) },
  Platform: { OS: 'ios' },
}));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => ({ userId: 'user-1' }),
}));
vi.mock('@/lib/hooks/use-agent-sessions', () => ({
  useRecentAgentRepositories: () => ({ data: { repositories: mocks.recents } }),
}));
vi.mock('@/lib/config', () => ({ WEB_BASE_URL: 'https://app.example.com' }));
vi.mock('@/lib/auth/trpc-unauthorized', () => ({ handleTrpcQueryError: vi.fn() }));
vi.mock('@/lib/force-update-signal', () => ({ reportTrpcError: vi.fn() }));
vi.mock('@/lib/pr-review/connect-gate-platform', () => ({
  openAuthorizationAndWaitForReturn: mocks.browser,
}));
vi.mock('@/lib/trpc', () => {
  const procedure = (platform: RepositoryPlatform) => ({
    queryOptions: (input: { organizationId?: string; forceRefresh: boolean }) => ({
      queryKey: [[platform], { input, type: 'query' }],
      queryFn: async () => {
        if (!input.forceRefresh) {
          mocks.normalRequests.push(platform);
        }
        const data = await mocks.fetch(platform, input.forceRefresh);
        return data;
      },
    }),
  });
  const cloudAgentNext = {
    listGitHubRepositories: procedure('github'),
    listGitLabRepositories: procedure('gitlab'),
    listBitbucketRepositories: procedure('bitbucket'),
    listRepositoryBranches: { pathFilter: () => ({ queryKey: [['branches']] }) },
  };
  const trpc = { cloudAgentNext, organizations: { cloudAgentNext } };
  return {
    useTRPC: () => trpc,
    trpcClient: { githubApps: { mintInstallState: { mutate: mocks.mint } } },
  };
});

const client = createKiloAppQueryClient();
const empty = { integrationInstalled: true, status: 'available', repositories: [] };
let renderer: ReactTestRenderer | undefined = undefined;
let latest: ReturnType<typeof useNewSessionRepos> | undefined = undefined;
function result() {
  assert(latest, 'Discovery hook did not render');
  return latest;
}
function Harness() {
  latest = useNewSessionRepos({ organizationId: 'org-1' });
  return null;
}
function tree() {
  return React.createElement(QueryClientProvider, { client }, React.createElement(Harness));
}
function mountRepos() {
  act(() => {
    renderer = TestRenderer.create(tree());
  });
}
async function flushQueries() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
}
function repositoryData(platform: RepositoryPlatform, integrationId: string) {
  return {
    ...empty,
    repositories: [
      {
        private: true,
        repositoryReference: {
          repository: {
            provider: platform,
            instanceUrl:
              platform === 'bitbucket' ? 'https://bitbucket.org' : `https://${platform}.com`,
            repositoryId: platform === 'bitbucket' ? '{repository-uuid}' : '7',
            fullName: 'owner/repo',
            defaultBranch: 'main',
            ...(platform === 'bitbucket' ? { workspaceUuid: '{workspace-uuid}' } : {}),
          },
          authorization: {
            kind: 'ownerIntegration',
            owner: { type: 'org', id: 'org-1' },
            integrationId,
          },
        },
      },
    ],
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.normalRequests.length = 0;
  mocks.recents.length = 0;
  mocks.browser.mockResolvedValue('sheet-close');
  mocks.mint.mockResolvedValue({ token: 'install-state' });
});
afterEach(() => {
  act(() => renderer?.unmount());
  client.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each([
  ['FORBIDDEN', 'access-denied'],
  ['UNAUTHORIZED', 'connect'],
])('retains %s recovery after the production cache removes both variants', async (code, status) => {
  const permissionClient = createKiloAppQueryClient();
  const normalKey: TRPCQueryKey = [
    ['github'],
    { input: { organizationId: 'org-1', forceRefresh: false }, type: 'query', accountId: 'user-1' },
  ];
  const forcedKey: TRPCQueryKey = [
    ['github'],
    { input: { organizationId: 'org-1', forceRefresh: true }, type: 'query', accountId: 'user-1' },
  ];
  const error = Object.assign(new Error('Access revoked'), { data: { code } });
  permissionClient.setQueryData(normalKey, {
    integrationInstalled: true,
    repositories: ['revoked rows'],
  });
  try {
    await expect(
      permissionClient.fetchQuery({
        queryKey: forcedKey,
        queryFn: async () => {
          await Promise.resolve();
          throw error;
        },
      })
    ).rejects.toBe(error);
    expect(
      permissionClient.getQueryCache().find({ queryKey: normalKey, exact: true })
    ).toBeUndefined();
    expect(
      permissionClient.getQueryCache().find({ queryKey: forcedKey, exact: true })
    ).toBeUndefined();

    expect(setRepositoryDiscoveryError(permissionClient, normalKey, error)).toBe(status);
    expect(permissionClient.getQueryState(normalKey)).toMatchObject({
      data: undefined,
      error,
      status: 'error',
    });
    expect(permissionClient.getQueryData(normalKey)).toBeUndefined();
  } finally {
    permissionClient.clear();
  }
});

it.each(
  (['github', 'gitlab', 'bitbucket'] as const).flatMap(platform =>
    [
      { code: 'FORBIDDEN', status: 'access-denied' },
      { code: 'UNAUTHORIZED', status: 'connect' },
    ].flatMap(({ code, status }) =>
      ['retry', 'authorization return'].map(recovery => ({ platform, code, status, recovery }))
    )
  )
)(
  'keeps mounted $platform $code recovery until $recovery',
  async ({ platform, code, status, recovery }) => {
    const cached = repositoryData(platform, 'revoked-integration');
    mocks.recents.push(
      ...cached.repositories.map(row => ({
        identity: { kind: 'resolved', accountId: 'user-1', reference: row.repositoryReference },
      }))
    );
    mocks.fetch.mockImplementation(async provider => {
      await Promise.resolve();
      return provider === platform ? cached : empty;
    });
    mountRepos();
    await flushQueries();
    expect(result().repositories).toHaveLength(1);
    expect(result().recents).toHaveLength(1);

    const pendingNormal = Promise.withResolvers<unknown>();
    const denied = Object.assign(new Error('Repository access denied'), { data: { code } });
    mocks.fetch.mockImplementation(async (provider, forceRefresh) => {
      await Promise.resolve();
      if (provider !== platform) {
        return empty;
      }
      if (forceRefresh) {
        throw denied;
      }
      return pendingNormal.promise;
    });
    await act(async () => {
      await result().refreshReposForceFresh();
    });
    await flushQueries();
    expect(result().groups.find(group => group.key === platform)).toEqual({
      key: platform,
      status,
      repositories: [],
    });
    expect(result().repositories).toEqual([]);
    expect(result().recents).toEqual([]);
    expect(result().isRetrying).toBe(false);

    act(() => renderer?.update(tree()));
    await flushQueries();
    expect(result().groups.find(group => group.key === platform)?.status).toBe(status);
    act(() => renderer?.unmount());
    mountRepos();
    await flushQueries();
    expect(result().groups.find(group => group.key === platform)?.status).toBe(status);
    expect(result().repositories).toEqual([]);
    expect(result().recents).toEqual([]);
    expect(mocks.normalRequests.filter(provider => provider === platform)).toEqual([platform]);

    const restored = repositoryData(platform, 'restored-integration');
    mocks.fetch.mockImplementation(async (provider, forceRefresh) => {
      await Promise.resolve();
      if (provider !== platform) {
        return empty;
      }
      return forceRefresh ? restored : pendingNormal.promise;
    });
    await act(async () => {
      if (recovery === 'retry') {
        await result().refreshReposForceFresh();
      } else {
        result().openIntegration(platform);
      }
    });
    await flushQueries();
    expect(result().groups.find(group => group.key === platform)?.status).toBe('repos');
    expect(result().repositories.map(row => row.reference)).toEqual(
      restored.repositories.map(row => row.repositoryReference)
    );
    expect(result().isRetrying).toBe(false);
    expect(mocks.normalRequests.filter(provider => provider === platform)).toEqual([platform]);
  }
);

it.each(
  (['github', 'gitlab', 'bitbucket'] as const).flatMap(platform =>
    ['FORBIDDEN', 'UNAUTHORIZED'].map(code => ({ platform, code }))
  )
)(
  'retains a directly observed $platform $code failure without retrying on remount',
  async ({ platform, code }) => {
    const denied = Object.assign(new Error('Repository access denied'), { data: { code } });
    const pending = Promise.withResolvers<unknown>();
    let firstAttempt = true;
    mocks.fetch.mockImplementation(async provider => {
      await Promise.resolve();
      if (provider !== platform) {
        return empty;
      }
      if (firstAttempt) {
        firstAttempt = false;
        throw denied;
      }
      return pending.promise;
    });
    mountRepos();
    await flushQueries();
    const status = code === 'FORBIDDEN' ? 'access-denied' : 'connect';
    expect(result().groups.find(group => group.key === platform)?.status).toBe(status);
    act(() => renderer?.unmount());
    mountRepos();
    await flushQueries();
    expect(result().groups.find(group => group.key === platform)?.status).toBe(status);
    expect(result().repositories).toEqual([]);
    expect(result().recents).toEqual([]);
    expect(mocks.normalRequests.filter(provider => provider === platform)).toEqual([platform]);
  }
);
