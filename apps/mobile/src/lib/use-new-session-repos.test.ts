/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the existing DOM-free hook harness. */
/* eslint-disable max-lines -- Provider/account/cache and native return matrices share one discovery hook harness. */
import * as React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import * as ReactQuery from '@tanstack/react-query';
import { type MobileRouter } from '@kilocode/trpc/mobile';
import {
  type LaunchRepositoryReference,
  repositoryResourceKey,
} from '@kilocode/app-shared/code-review/repository-identity';
import { afterEach, assert, beforeEach, expect, it, vi } from 'vitest';
import { resolvePrefillRepoSelection } from '@/components/agents/new-session-prefill';
import { useNewSessionPrefillTargets } from '@/components/agents/use-new-session-prefill';
import { type RepositoryPlatform } from '@/components/agents/new-session-repository-state';
import { useNewSessionRepos } from './use-new-session-repos';

type DiscoveryRequest = {
  path: string;
  input: { organizationId?: string; forceRefresh: boolean };
  accountId: string;
};
const mocks = vi.hoisted(() => {
  const prefill: { prefillRepo?: string } = {};
  return {
    fetch: vi.fn<(request: DiscoveryRequest) => unknown>(),
    normalFetch: vi.fn<(request: DiscoveryRequest) => unknown>(),
    browser: vi.fn<(os: string, url: string) => Promise<unknown>>(),
    queries: new Map<string, { data?: unknown; isLoading?: boolean; isError?: boolean }>(),
    recents: undefined as unknown,
    prefill,
    userId: 'user-1',
    platform: { OS: 'ios' },
    messages: [] as string[],
    notes: [] as string[],
    destinations: [] as string[],
    requests: [] as DiscoveryRequest[],
    listeners: new Set<(state: string) => void>(),
  };
});
const client = new ReactQuery.QueryClient({ defaultOptions: { queries: { retry: false } } });
let renderer: ReactTestRenderer | undefined = undefined;
let latest: ReturnType<typeof useNewSessionRepos> | undefined = undefined;
let prefillTargets: ReturnType<typeof useNewSessionPrefillTargets> | undefined = undefined;
function result() {
  assert(latest, 'Hook did not render');
  return latest;
}
vi.mock('react-native', () => ({
  Platform: mocks.platform,
  AppState: {
    addEventListener: (_event: string, listener: (state: string) => void) => {
      mocks.listeners.add(listener);
      return { remove: () => mocks.listeners.delete(listener) };
    },
  },
}));
vi.mock('expo-router', () => ({ useLocalSearchParams: () => mocks.prefill }));
vi.mock('@/components/ui/icons', () => ({
  Bug: 'Bug',
  Code: 'Code',
  HelpCircle: 'HelpCircle',
  NotebookPen: 'NotebookPen',
  Workflow: 'Workflow',
}));
vi.mock('sonner-native', () => ({
  toast: {
    error: (message: string) => mocks.messages.push(message),
    info: (message: string) => mocks.notes.push(message),
  },
}));
vi.mock('@tanstack/react-query', async importOriginal => ({
  ...(await importOriginal<typeof ReactQuery>()),
  // Keep the earlier lifecycle fixtures; cache regressions replace this with the real useQuery.
  useQuery: vi.fn(({ queryKey }: { queryKey: [string[], unknown] }) => ({
    isLoading: false,
    isError: false,
    isRefetching: false,
    ...mocks.queries.get(
      (queryKey[0].at(-1) ?? '').replace('list', '').replace('Repositories', '').toLowerCase()
    ),
  })),
  useQueryClient: () => client,
}));
vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => ({ userId: mocks.userId }),
}));
vi.mock('@/lib/config', () => ({ WEB_BASE_URL: 'https://app.example.com' }));
vi.mock('@/lib/hooks/use-agent-sessions', () => ({
  useRecentAgentRepositories: () => ({ data: mocks.recents }),
}));
vi.mock('@/lib/pr-review/connect-gate-platform', () => ({
  openAuthorizationAndWaitForReturn: async (os: string, url: string) => {
    mocks.destinations.push(url);
    const trigger = await mocks.browser(os, url);
    return trigger ?? (mocks.platform.OS === 'ios' ? 'sheet-close' : 'app-foreground');
  },
}));
vi.mock('@/lib/trpc', async () => {
  const { createTRPCClient, httpLink } = await import('@trpc/client');
  const { createTRPCOptionsProxy } = await import('@trpc/tanstack-react-query');
  const trpcClient = createTRPCClient<MobileRouter>({
    links: [
      httpLink({
        url: 'https://app.example.com/trpc',
        fetch: async url => {
          const address = new URL(url instanceof Request ? url.url : url);
          const request: DiscoveryRequest = {
            path: address.pathname.slice('/trpc/'.length),
            input: JSON.parse(address.searchParams.get('input') ?? '{}'),
            accountId: mocks.userId,
          };
          mocks.requests.push(request);
          const data = await (request.input.forceRefresh
            ? mocks.fetch(request)
            : mocks.normalFetch(request));
          return Response.json({ result: { data } });
        },
      }),
    ],
  });
  const trpc = createTRPCOptionsProxy<MobileRouter>({
    queryClient: () => client,
    client: trpcClient,
  });
  return { useTRPC: () => trpc, trpcClient };
});
const available = { status: 'available', integrationInstalled: true, repositories: [] };
const procedures = {
  github: 'listGitHubRepositories',
  gitlab: 'listGitLabRepositories',
  bitbucket: 'listBitbucketRepositories',
};
function discoveryKey(
  platform: RepositoryPlatform,
  organizationId: string | undefined,
  {
    forceRefresh = false,
    accountId = 'user-1',
  }: { forceRefresh?: boolean; accountId?: string } = {}
) {
  return [
    [...(organizationId ? ['organizations'] : []), 'cloudAgentNext', procedures[platform]],
    {
      input: { ...(organizationId ? { organizationId } : {}), forceRefresh },
      type: 'query',
      accountId,
    },
  ];
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.queries.clear();
  mocks.recents = undefined;
  mocks.prefill = {};
  mocks.userId = 'user-1';
  mocks.platform.OS = 'ios';
  mocks.messages.length = 0;
  mocks.notes.length = 0;
  mocks.destinations.length = 0;
  mocks.requests.length = 0;
  mocks.fetch.mockResolvedValue(available);
  mocks.normalFetch.mockResolvedValue(available);
  mocks.browser.mockResolvedValue(undefined);
});
afterEach(() => {
  act(() => {
    renderer?.unmount();
  });
  client.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function foreground() {
  await act(() => {
    for (const listener of mocks.listeners) {
      listener('active');
    }
  });
}
function Harness({ org }: { org: string | undefined }) {
  latest = useNewSessionRepos({ organizationId: org });
  prefillTargets = useNewSessionPrefillTargets({ ...latest, models: [], modelsSettled: true });
  return null;
}
function tree(org: string | undefined) {
  return React.createElement(
    ReactQuery.QueryClientProvider,
    { client },
    React.createElement(Harness, { org })
  );
}
function mountRepos(organizationId: string | undefined) {
  act(() => {
    renderer = TestRenderer.create(tree(organizationId));
  });
  return {
    update: (org: string | undefined) =>
      act(() => {
        renderer?.update(tree(org));
      }),
    unmount: () =>
      act(() => {
        renderer?.unmount();
      }),
  };
}
async function useRealQueries() {
  const actual = await vi.importActual<typeof ReactQuery>('@tanstack/react-query');
  vi.mocked(ReactQuery.useQuery).mockImplementation(actual.useQuery);
  vi.useFakeTimers();
}
async function flushQueries() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
}
const reference: LaunchRepositoryReference = {
  repository: {
    provider: 'gitlab',
    instanceUrl: 'https://git.example.com/base',
    repositoryId: '7',
    fullName: 'group/nested/Repo',
    defaultBranch: 'develop',
  },
  authorization: {
    kind: 'ownerIntegration',
    owner: { type: 'org', id: 'org-1' },
    integrationId: 'integration-1',
  },
};
function providerReference(
  platform: RepositoryPlatform,
  organizationId: string | undefined,
  integrationId = 'integration-1'
): LaunchRepositoryReference {
  return {
    repository:
      platform === 'bitbucket'
        ? {
            provider: platform,
            instanceUrl: 'https://bitbucket.org',
            repositoryId: '{repository-uuid}',
            workspaceUuid: '{workspace-uuid}',
            fullName: 'owner/repo',
            defaultBranch: 'release',
          }
        : {
            provider: platform,
            instanceUrl: `https://${platform}.com`,
            repositoryId: '7',
            fullName: 'owner/repo',
            defaultBranch: 'develop',
          },
    authorization: {
      kind: 'ownerIntegration',
      owner: organizationId
        ? { type: 'org', id: organizationId }
        : { type: 'user', id: mocks.userId },
      integrationId,
    },
  };
}
function providerData(platform: RepositoryPlatform, refs: LaunchRepositoryReference[] = []) {
  const repositories = refs.map(repositoryReference => {
    const { repository, authorization } = repositoryReference;
    return {
      id:
        repository.provider === 'bitbucket'
          ? repository.repositoryId
          : Number(repository.repositoryId),
      ...(repository.provider === 'bitbucket' ? { workspaceUuid: repository.workspaceUuid } : {}),
      name: 'repo',
      fullName: repository.fullName,
      private: true,
      defaultBranch: repository.defaultBranch ?? undefined,
      platformIntegrationId: authorization.integrationId,
      instanceUrl: repository.instanceUrl,
      repositoryReference,
    };
  });
  return platform === 'bitbucket'
    ? { status: 'available', repositories, syncedAt: '2026-08-29T16:00:00Z' }
    : { integrationInstalled: true, repositories, syncedAt: '2026-08-29T16:00:00Z' };
}
function requestProvider(request: DiscoveryRequest): RepositoryPlatform {
  if (request.path.endsWith(procedures.github)) {
    return 'github';
  }
  if (request.path.endsWith(procedures.gitlab)) {
    return 'gitlab';
  }
  return 'bitbucket';
}

it.each(['available', 'temporarily_unavailable'])(
  'handles a %s Bitbucket refresh without losing cached rows',
  async status => {
    const key = discoveryKey('bitbucket', 'org-1');
    const cached = { ...available, repositories: [{ fullName: 'workspace/repo' }] };
    client.setQueryData(key, cached);
    mocks.fetch.mockResolvedValue({ ...available, status });
    mountRepos('org-1');
    await act(async () => {
      await result().refreshReposForceFresh();
    });
    expect(client.getQueryData(key)).toEqual(status === 'available' ? available : cached);
    expect(mocks.messages).toEqual(
      status === 'available' ? [] : ['Could not refresh repositories. Please try again.']
    );
  }
);

it('keeps exact discovery and recents selectable while another provider loads', () => {
  const other = {
    ...reference,
    authorization: { ...reference.authorization, integrationId: 'integration-2' },
  };
  mocks.queries.set('gitlab', {
    data: {
      ...available,
      repositories: [reference, other].map(repositoryReference => ({
        private: true,
        repositoryReference,
      })),
    },
  });
  mocks.queries.set('github', { isLoading: true });
  mocks.queries.set('bitbucket', { data: available });
  mocks.recents = {
    repositories: [
      { identity: { kind: 'resolved', accountId: 'user-1', reference: other } },
      { identity: { kind: 'legacy-unresolved', accountId: 'user-1', reason: 'ambiguous' } },
      { identity: { kind: 'resolved', accountId: 'other-user', reference } },
    ],
  };
  const hook = mountRepos('org-1');
  expect(result().repositories.map(repo => repo.reference)).toEqual([other, reference]);
  expect(result().recents.map(repo => repo.reference)).toEqual([other]);
  expect(result().groups.map(group => [group.key, group.status])).toEqual([
    ['github', 'loading'],
    ['gitlab', 'repos'],
    ['bitbucket', 'connected-empty'],
  ]);
  expect(result().reposSettled).toBe(false);
  hook.update('org-2');
  expect(result().repositories).toEqual([]);
  expect(result().recents).toEqual([]);
});

it('quarantines incomplete discovery and settles an empty Personal browsing response', () => {
  mocks.queries.set('github', {
    data: { ...available, repositories: [{ fullName: 'owner/repo', private: true }] },
  });
  mocks.queries.set('gitlab', { data: { integrationInstalled: false, repositories: [] } });
  const hook = mountRepos(undefined);
  expect(result().repositories).toEqual([]);
  expect(result().groups[0]?.status).toBe('identity-unavailable');
  expect(result().reposSettled).toBe(false);
  mocks.queries.set('github', { data: available });
  hook.update(undefined);
  expect(result().groups.map(group => group.status)).toEqual(['connected-empty', 'connect']);
  expect(result().recents).toEqual([]);
  expect(result().reposSettled).toBe(true);
});

it.each(
  ['owner', 'account', 'unmount'].flatMap(change =>
    (['refresh', 'gitlab', 'bitbucket'] as const).flatMap(action =>
      ['success', 'failure'].flatMap(outcome =>
        ['ios', 'android'].map(os => ({ change, action, outcome, os }))
      )
    )
  )
)(
  'isolates late $action $outcome after $change replacement on $os',
  async ({ change, action, outcome, os }) => {
    mocks.platform.OS = os;
    const old = Promise.withResolvers<unknown>();
    mocks.fetch.mockReturnValue(old.promise);
    mocks.browser.mockReturnValue(old.promise);
    const hook = mountRepos('org-1');
    await act(() => {
      if (action === 'refresh') {
        void result().refreshReposForceFresh();
      } else {
        result().openIntegration(action);
      }
    });
    const organizationId = change === 'owner' ? 'org-2' : 'org-1';
    if (change === 'account') {
      mocks.userId = 'user-2';
    }
    if (change === 'unmount') {
      hook.unmount();
    } else {
      hook.update(organizationId);
    }
    const replacement = Promise.withResolvers<unknown>();
    mocks.fetch.mockResolvedValue(available);
    if (action === 'refresh') {
      mocks.fetch.mockReturnValue(replacement.promise);
    }
    if (change !== 'unmount' && action === 'refresh') {
      expect(result().isRetrying).toBe(false);
      act(() => {
        void result().refreshReposForceFresh();
      });
      expect(result().groups.map(group => group.status)).toEqual(['loading', 'loading', 'loading']);
    }
    await act(() => {
      if (outcome === 'failure') {
        old.reject(new Error('Retired request failed'));
      } else {
        old.resolve(action === 'refresh' ? available : undefined);
      }
    });
    await foreground();
    for (const name of ['github', 'gitlab', 'bitbucket'] as const) {
      for (const forceRefresh of [false, true]) {
        const key = discoveryKey(name, 'org-1', { forceRefresh });
        expect(client.getQueryData(key)).toBeUndefined();
        expect(client.getQueryState(key)?.error ?? null).toBeNull();
      }
    }
    expect(mocks.messages).toEqual([]);
    if (change !== 'unmount') {
      expect(result().isRetrying).toBe(action === 'refresh');
      await act(() => {
        replacement.resolve(available);
      });
      expect(result().isRetrying).toBe(false);
    }
  }
);

it.each(['gitlab', 'bitbucket'] as const)(
  'refreshes %s once on Android return and handles a failed return',
  async platform => {
    mocks.platform.OS = 'android';
    mountRepos('org-1');
    await act(() => {
      result().openIntegration(platform);
    });
    expect(mocks.destinations).toEqual([
      `https://app.example.com/organizations/org-1/integrations/${platform}`,
    ]);
    await foreground();
    const key = discoveryKey(platform, 'org-1');
    expect(client.getQueryData(key)).toEqual(available);
    client.setQueryData(key, { ...available, repositories: ['newer rows'] });
    await foreground();
    expect(client.getQueryData(key)).toMatchObject({ repositories: ['newer rows'] });
    mocks.fetch.mockRejectedValue(new Error('Offline'));
    await act(() => {
      result().openIntegration(platform);
    });
    await foreground();
    expect(mocks.messages).toHaveLength(1);
    expect(client.getQueryData(key)).toMatchObject({ repositories: ['newer rows'] });
    expect(result().isRetrying).toBe(false);
  }
);

it.each(
  (['github', 'gitlab', 'bitbucket'] as const).flatMap(platform =>
    ['owner', 'account', 'unmount'].flatMap(change =>
      ['success', 'failure'].map(outcome => ({ platform, change, outcome }))
    )
  )
)(
  'isolates cached $platform rows and late normal $outcome after $change replacement',
  async ({ platform, change, outcome }) => {
    await useRealQueries();
    const old = Promise.withResolvers<unknown>();
    const next = Promise.withResolvers<unknown>();
    const cachedReference = providerReference(platform, 'org-1');
    const cached = providerData(platform, [cachedReference]);
    const key = discoveryKey(platform, 'org-1');
    client.setQueryData(key, cached);
    mocks.normalFetch.mockImplementation(async request => {
      const response =
        requestProvider(request) === platform
          ? await old.promise
          : providerData(requestProvider(request));
      return response;
    });
    const hook = mountRepos('org-1');
    await flushQueries();
    expect(result().repositories.map(repo => repo.reference)).toEqual([cachedReference]);
    const organizationId = change === 'owner' ? 'org-2' : 'org-1';
    if (change === 'account') {
      mocks.userId = 'user-2';
    }
    mocks.recents = {
      repositories: [
        { identity: { kind: 'resolved', accountId: mocks.userId, reference: cachedReference } },
      ],
    };
    mocks.normalFetch.mockImplementation(async request => {
      const response =
        requestProvider(request) === platform
          ? await next.promise
          : providerData(requestProvider(request));
      return response;
    });
    if (change === 'unmount') {
      hook.unmount();
    } else {
      hook.update(organizationId);
      await flushQueries();
      expect(result().repositories).toEqual([]);
      expect(result().recents).toEqual([]);
      expect(result().groups.find(group => group.key === platform)?.status).toBe('loading');
    }
    await act(() => {
      if (outcome === 'success') {
        old.resolve(providerData(platform, [providerReference(platform, 'org-1', 'late-old')]));
      } else {
        old.reject(new Error('Retired normal discovery failed'));
      }
    });
    await flushQueries();
    expect(client.getQueryData(key)).toEqual(cached);
    expect(client.getQueryState(key)?.error).toBeNull();
    expect(mocks.messages).toEqual([]);
    if (change !== 'unmount') {
      const nextKey = discoveryKey(platform, organizationId, { accountId: mocks.userId });
      expect(client.getQueryData(nextKey)).toBeUndefined();
      expect(client.getQueryState(nextKey)?.error).toBeNull();
      expect(result().repositories).toEqual([]);
      const authorized = providerReference(platform, organizationId, 'replacement-integration');
      next.resolve(providerData(platform, [authorized]));
      await flushQueries();
      expect(result().repositories.map(repo => [repo.accountId, repo.reference])).toEqual([
        [mocks.userId, authorized],
      ]);
      expect(result().groups.find(group => group.key === platform)?.status).toBe('repos');
    }
  }
);

it.each(['org-1', undefined])(
  'keeps original tRPC request paths and inputs for owner %s in both discovery caches',
  async organizationId => {
    await useRealQueries();
    const response = (request: DiscoveryRequest) => {
      const platform = requestProvider(request);
      return providerData(platform, [providerReference(platform, organizationId)]);
    };
    mocks.normalFetch.mockImplementation(response);
    mocks.fetch.mockImplementation(response);
    mountRepos(organizationId);
    await flushQueries();
    await act(async () => {
      await result().refreshReposForceFresh();
    });
    await flushQueries();
    const platforms: RepositoryPlatform[] = organizationId
      ? ['github', 'gitlab', 'bitbucket']
      : ['github', 'gitlab'];
    expect(result().repositories.map(repo => repo.platform)).toEqual(platforms);
    expect(mocks.requests).toEqual(
      [false, true].flatMap(forceRefresh =>
        platforms.map(platform => ({
          path: `${organizationId ? 'organizations.' : ''}cloudAgentNext.${procedures[platform]}`,
          input: { ...(organizationId ? { organizationId } : {}), forceRefresh },
          accountId: 'user-1',
        }))
      )
    );
  }
);

it.each(
  (['github', 'gitlab'] as const).flatMap(platform =>
    ['org-1', undefined].flatMap(organizationId =>
      ['missing', 'suspended'].map(connection => ({ platform, organizationId, connection }))
    )
  )
)(
  'exposes connection recovery for $platform $connection with owner $organizationId',
  async ({ platform, organizationId, connection }) => {
    await useRealQueries();
    const name = platform === 'github' ? 'GitHub' : 'GitLab';
    const missing = {
      integrationInstalled: false,
      repositories: [],
      syncedAt: null,
      errorMessage:
        connection === 'suspended'
          ? `${name} integration is suspended`
          : `No ${name} integration found for this ${organizationId ? 'organization' : 'user'}`,
    };
    const response = (request: DiscoveryRequest) =>
      requestProvider(request) === platform ? missing : providerData(requestProvider(request));
    mocks.normalFetch.mockImplementation(response);
    mocks.fetch.mockImplementation(response);
    mountRepos(organizationId);
    await flushQueries();
    expect(result().groups.find(group => group.key === platform)?.status).toBe('connect');
    await act(async () => {
      await result().refreshReposForceFresh();
    });
    await flushQueries();
    expect(result().groups.find(group => group.key === platform)?.status).toBe('connect');
    expect(result().repositories).toEqual([]);
    expect(client.getQueryData(discoveryKey(platform, organizationId))).toEqual(missing);
    expect(mocks.messages).toEqual([]);
  }
);

it.each(
  [
    ['not_connected', 'connect'],
    ['reconnect_required', 'connect'],
    ['workspace_selection_required', 'connect'],
    ['insufficient_permissions', 'access-denied'],
    ['invalid_request', 'access-denied'],
  ].flatMap(([status, expected]) =>
    ['manual', 'ios', 'android'].map(mode => ({ status, expected, mode }))
  )
)(
  'publishes Bitbucket $status after $mode refresh and removes revoked rows and recents',
  async ({ status, expected, mode }) => {
    await useRealQueries();
    mocks.platform.OS = mode === 'android' ? 'android' : 'ios';
    const authorized = providerReference('bitbucket', 'org-1');
    mocks.recents = {
      repositories: [
        { identity: { kind: 'resolved', accountId: 'user-1', reference: authorized } },
      ],
    };
    mocks.normalFetch.mockImplementation(request =>
      providerData(
        requestProvider(request),
        requestProvider(request) === 'bitbucket' ? [authorized] : []
      )
    );
    mocks.fetch.mockImplementation(request =>
      requestProvider(request) === 'bitbucket' ? { status } : providerData(requestProvider(request))
    );
    mountRepos('org-1');
    await flushQueries();
    expect(result().recents.map(repo => repo.reference)).toEqual([authorized]);
    await act(async () => {
      if (mode === 'manual') {
        await result().refreshReposForceFresh();
      } else {
        result().openIntegration('bitbucket');
      }
    });
    if (mode === 'android') {
      await foreground();
    }
    await flushQueries();
    expect(client.getQueryData(discoveryKey('bitbucket', 'org-1'))).toEqual({ status });
    expect(result().groups.find(group => group.key === 'bitbucket')).toEqual({
      key: 'bitbucket',
      status: expected,
      repositories: [],
    });
    expect(result().repositories).toEqual([]);
    expect(result().recents).toEqual([]);
    expect(mocks.messages).toEqual([]);
  }
);

it.each(['github', 'gitlab', 'bitbucket'] as const)(
  'retains authorized %s rows after transient refresh failure and recovers on retry',
  async platform => {
    await useRealQueries();
    const authorized = providerReference(platform, 'org-1');
    const cached = providerData(platform, [authorized]);
    mocks.normalFetch.mockImplementation(request =>
      requestProvider(request) === platform ? cached : providerData(requestProvider(request))
    );
    mocks.fetch.mockImplementation(request => {
      if (requestProvider(request) !== platform) {
        return providerData(requestProvider(request));
      }
      if (platform === 'bitbucket') {
        return { status: 'temporarily_unavailable' };
      }
      throw new Error('Provider offline');
    });
    mountRepos('org-1');
    await flushQueries();
    await act(async () => {
      await result().refreshReposForceFresh();
    });
    await flushQueries();
    expect(result().groups.find(group => group.key === platform)?.status).toBe('error');
    expect(result().repositories.map(repo => repo.reference)).toEqual([authorized]);
    expect(client.getQueryData(discoveryKey(platform, 'org-1'))).toEqual(cached);
    expect(result().reposSettled).toBe(false);
    expect(mocks.messages).toEqual(['Could not refresh repositories. Please try again.']);
    mocks.fetch.mockImplementation(request =>
      requestProvider(request) === platform ? cached : providerData(requestProvider(request))
    );
    await act(async () => {
      await result().refreshReposForceFresh();
    });
    await flushQueries();
    expect(result().groups.find(group => group.key === platform)?.status).toBe('repos');
  }
);

it.each(['hidden Personal integration', 'failed organization integration'])(
  'keeps legacy prefill unresolved beside a %s while permitting exact selection',
  async scenario => {
    await useRealQueries();
    const organizationId = scenario === 'hidden Personal integration' ? undefined : 'org-1';
    const visible = providerReference('github', organizationId);
    mocks.prefill = { prefillRepo: 'owner/repo' };
    // Both producers return only the visible integration, with no completeness field or error.
    mocks.normalFetch.mockImplementation(request =>
      providerData(requestProvider(request), requestProvider(request) === 'github' ? [visible] : [])
    );
    mountRepos(organizationId);
    await flushQueries();
    const row = result().repositories[0];
    assert(row, 'Visible authorized repository is missing');
    expect(row.reference).toEqual(visible);
    expect(prefillTargets?.selectedRepo).toBe('');
    expect(mocks.notes).toEqual([]);
    expect(
      resolvePrefillRepoSelection(result().repositories, { mode: 'code', repo: row.key })
    ).toBe(row.key);
    act(() => prefillTargets?.setSelectedRepo(row.key));
    expect(prefillTargets?.selectedRepo).toBe(row.key);
  }
);

it('applies exact prefill during partial loading without erasing normalized identity', async () => {
  await useRealQueries();
  const authorized = providerReference('github', 'org-1');
  mocks.prefill = { prefillRepo: repositoryResourceKey('user-1', authorized) };
  const pending = Promise.withResolvers<unknown>();
  mocks.normalFetch.mockImplementation(async request => {
    const response =
      requestProvider(request) === 'gitlab'
        ? await pending.promise
        : providerData(
            requestProvider(request),
            requestProvider(request) === 'github' ? [authorized] : []
          );
    return response;
  });
  mountRepos('org-1');
  await flushQueries();
  expect(result().reposSettled).toBe(false);
  expect(
    result().repositories.find(repo => repo.key === prefillTargets?.selectedRepo)?.reference
  ).toEqual(authorized);
  expect(mocks.notes).toEqual([]);
});

it('distinguishes a confirmed empty provider from incomplete identity through real discovery', async () => {
  await useRealQueries();
  mocks.normalFetch.mockImplementation(request =>
    requestProvider(request) === 'github'
      ? {
          integrationInstalled: true,
          repositories: [{ id: 1, name: 'repo', fullName: 'owner/repo', private: true }],
        }
      : providerData(requestProvider(request))
  );
  mountRepos('org-1');
  await flushQueries();
  expect(result().groups.map(group => group.status)).toEqual([
    'identity-unavailable',
    'connected-empty',
    'connected-empty',
  ]);
  expect(result().repositories).toEqual([]);
  expect(result().recents).toEqual([]);
  expect(result().reposSettled).toBe(false);
});

it.each(
  (['github', 'gitlab', 'bitbucket'] as const).flatMap(platform =>
    [
      { code: 'FORBIDDEN', rpcCode: -32_003, status: 'access-denied' },
      { code: 'UNAUTHORIZED', rpcCode: -32_001, status: 'connect' },
    ].map(({ code, rpcCode, status }) => ({ platform, code, rpcCode, status }))
  )
)(
  'does not revive $platform rows after $code refresh failure and remount',
  async ({ platform, code, rpcCode, status }) => {
    await useRealQueries();
    const { TRPCClientError } = await import('@trpc/client');
    const denied = TRPCClientError.from({
      error: { code: rpcCode, message: 'Repository access denied', data: { code } },
    });
    const authorized = providerReference(platform, 'org-1');
    const cached = providerData(platform, [authorized]);
    mocks.recents = {
      repositories: [
        { identity: { kind: 'resolved', accountId: 'user-1', reference: authorized } },
      ],
    };
    mocks.normalFetch.mockImplementation(request =>
      requestProvider(request) === platform ? cached : providerData(requestProvider(request))
    );
    mocks.fetch.mockImplementation(request => {
      if (requestProvider(request) === platform) {
        throw denied;
      }
      return providerData(requestProvider(request));
    });
    const hook = mountRepos('org-1');
    await flushQueries();
    expect(result().repositories.map(repo => repo.reference)).toEqual([authorized]);
    await act(async () => {
      await result().refreshReposForceFresh();
    });
    await flushQueries();
    expect(result().groups.find(group => group.key === platform)?.status).toBe(status);
    expect(result().repositories).toEqual([]);
    hook.unmount();
    const pending = Promise.withResolvers<unknown>();
    mocks.normalFetch.mockReturnValue(pending.promise);
    mountRepos('org-1');
    await flushQueries();
    expect(result().repositories).toEqual([]);
    expect(result().recents).toEqual([]);
  }
);

it.each(
  (['github', 'gitlab', 'bitbucket'] as const).flatMap(platform =>
    ['success', 'failure'].map(outcome => ({ platform, outcome }))
  )
)(
  'keeps confirmed $platform disconnection after a late normal $outcome',
  async ({ platform, outcome }) => {
    await useRealQueries();
    const normal = Promise.withResolvers<unknown>();
    const cached = providerData(platform, [providerReference(platform, 'org-1')]);
    const key = discoveryKey(platform, 'org-1');
    const disconnected =
      platform === 'bitbucket'
        ? { status: 'reconnect_required' }
        : {
            integrationInstalled: false,
            repositories: [],
            syncedAt: null,
            errorMessage: `${platform === 'github' ? 'GitHub' : 'GitLab'} integration is suspended`,
          };
    client.setQueryData(key, cached);
    mocks.normalFetch.mockImplementation(async request => {
      const response =
        requestProvider(request) === platform
          ? await normal.promise
          : providerData(requestProvider(request));
      return response;
    });
    mocks.fetch.mockImplementation(request =>
      requestProvider(request) === platform ? disconnected : providerData(requestProvider(request))
    );
    mountRepos('org-1');
    await flushQueries();
    expect(result().repositories).toHaveLength(1);
    await act(async () => {
      await result().refreshReposForceFresh();
    });
    await act(() => {
      if (outcome === 'success') {
        normal.resolve(cached);
      } else {
        normal.reject(new Error('Old normal request failed'));
      }
    });
    await flushQueries();
    expect(client.getQueryData(key)).toEqual(disconnected);
    expect(client.getQueryState(key)?.error).toBeNull();
    expect(result().groups.find(group => group.key === platform)?.status).toBe('connect');
    expect(result().repositories).toEqual([]);
    expect(result().recents).toEqual([]);
    expect(mocks.messages).toEqual([]);
  }
);
