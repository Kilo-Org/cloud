import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  QueryClient,
  QueryClientProvider,
  QueryObserver,
  type QueryObserverOptions,
} from '@tanstack/react-query';
import { createTRPCClient, type TRPCClient } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import { createTRPCOptionsProxy } from '@trpc/tanstack-react-query';
import type { RootRouter } from '@/routers/root-router';
import { useModelSelectorList } from '@/lib/hooks/use-openrouter-models';
import { TRPCProvider } from '@/lib/trpc/utils';
import { CLOUD_AGENT_METADATA_STALE_TIME } from '@/lib/cloud-agent/constants';
import { useBuiltinAgentSettings } from './useCloudAgentSettings';
import {
  useCombinedProfileMutations,
  useCombinedProfiles,
  useProfile,
  useProfileMutations,
  useProfiles,
  useRepoBindings,
} from './useCloudAgentProfiles';

let queryClient: QueryClient;
let trpcClient: TRPCClient<RootRouter>;

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: 60_000, retry: false, gcTime: Infinity } },
  });
  trpcClient = createTRPCClient<RootRouter>({
    links: [
      () => () =>
        observable(observer => {
          observer.next({ result: { data: {} } });
          observer.complete();
        }),
    ],
  });
});

afterEach(() => {
  queryClient.clear();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

function renderHook(useMetadata: () => unknown) {
  function Metadata() {
    useMetadata();
    return null;
  }

  renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(TRPCProvider, { trpcClient, queryClient, children: createElement(Metadata) })
    )
  );
}

function readQueryOptions(useMetadata: () => unknown): QueryObserverOptions {
  renderHook(useMetadata);
  const query = queryClient.getQueryCache().getAll().at(-1);
  if (!query) throw new Error('Metadata query was not registered');
  return query.options as QueryObserverOptions;
}

describe.each([
  {
    name: 'personal models',
    useMetadata: () =>
      useModelSelectorList(undefined, true, 'member', {
        staleTime: CLOUD_AGENT_METADATA_STALE_TIME,
        gcTime: CLOUD_AGENT_METADATA_STALE_TIME,
      }),
  },
  {
    name: 'organization models',
    useMetadata: () =>
      useModelSelectorList('org-1', true, 'member', {
        staleTime: CLOUD_AGENT_METADATA_STALE_TIME,
        gcTime: CLOUD_AGENT_METADATA_STALE_TIME,
      }),
  },
  { name: 'personal profiles', useMetadata: () => useProfiles() },
  { name: 'organization profiles', useMetadata: () => useProfiles({ organizationId: 'org-1' }) },
  { name: 'profile agents', useMetadata: () => useProfile('profile-1') },
  {
    name: 'combined profiles',
    useMetadata: () => useCombinedProfiles({ organizationId: 'org-1' }),
  },
  { name: 'repository profile bindings', useMetadata: () => useRepoBindings() },
  { name: 'built-in modes', useMetadata: () => useBuiltinAgentSettings() },
])('$name cache', ({ useMetadata }) => {
  it('reuses metadata on remount for fifteen minutes, then refreshes', async () => {
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    const queryFn = jest.fn(async () => ({ orgProfiles: [], personalProfiles: [] }));
    const options = { ...readQueryOptions(useMetadata), queryFn };
    await queryClient.query(options);

    clock.mockReturnValue(now + 14 * 60_000);
    const observer = new QueryObserver(queryClient, options);
    const unsubscribe = observer.subscribe(() => {});
    expect(observer.getCurrentResult().data).toMatchObject({
      orgProfiles: [],
      personalProfiles: [],
    });
    expect(observer.getCurrentResult().isFetching).toBe(false);
    expect(queryFn).toHaveBeenCalledTimes(1);
    unsubscribe();

    clock.mockReturnValue(now + 15 * 60_000);
    await queryClient.query(options);
    expect(queryFn).toHaveBeenCalledTimes(2);
  });

  it('retains inactive metadata beyond five minutes until the fifteen-minute retention expires', async () => {
    jest.useFakeTimers();
    const queryFn = jest.fn(async () => ({ orgProfiles: [], personalProfiles: [] }));
    const options = { ...readQueryOptions(useMetadata), queryFn };
    await queryClient.query(options);

    await jest.advanceTimersByTimeAsync(14 * 60_000);
    expect(queryClient.getQueryData(options.queryKey)).toBeDefined();
    await queryClient.query(options);
    expect(queryFn).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(60_000);
    expect(queryClient.getQueryData(options.queryKey)).toBeUndefined();
  });

  it('allows invalidation and manual refresh before the TTL expires', async () => {
    const queryFn = jest.fn(async () => ({ orgProfiles: [], personalProfiles: [] }));
    const options = { ...readQueryOptions(useMetadata), queryFn };
    await queryClient.query(options);

    await queryClient.invalidateQueries({ queryKey: options.queryKey });
    await queryClient.query(options);
    expect(queryFn).toHaveBeenCalledTimes(2);

    const observer = new QueryObserver(queryClient, options);
    await observer.refetch();
    expect(queryFn).toHaveBeenCalledTimes(3);
    observer.destroy();
  });

  it('shows cached metadata while a stale entry refreshes in the background', async () => {
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    const initial = { revision: 1, orgProfiles: [], personalProfiles: [] };
    let complete: ((value: typeof initial) => void) | undefined;
    const queryFn = jest
      .fn<() => Promise<typeof initial>>()
      .mockResolvedValueOnce(initial)
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            complete = resolve;
          })
      );
    const options = { ...readQueryOptions(useMetadata), queryFn };
    await queryClient.query(options);

    clock.mockReturnValue(now + 16 * 60_000);
    const observer = new QueryObserver(queryClient, options);
    const unsubscribe = observer.subscribe(() => {});
    expect(observer.getCurrentResult()).toMatchObject({
      data: { revision: 1 },
      isLoading: false,
      isFetching: true,
    });
    const refreshed = queryClient.query(options);
    if (!complete) throw new Error('Metadata refresh did not start');
    complete({ ...initial, revision: 2 });
    await refreshed;
    expect(observer.getCurrentResult().data).toMatchObject({ revision: 2 });
    unsubscribe();
  });
});

it('keeps personal, organization, model-audience, and profile caches separate', () => {
  const keys = [
    readQueryOptions(() => useModelSelectorList(undefined)).queryKey,
    readQueryOptions(() => useModelSelectorList('org-1')).queryKey,
    readQueryOptions(() => useModelSelectorList('org-2')).queryKey,
    readQueryOptions(() => useModelSelectorList('org-1', true, 'shared_services')).queryKey,
    readQueryOptions(() => useProfiles()).queryKey,
    readQueryOptions(() => useProfiles({ organizationId: 'org-1' })).queryKey,
    readQueryOptions(() => useProfiles({ organizationId: 'org-2' })).queryKey,
    readQueryOptions(() => useProfile('profile-1')).queryKey,
    readQueryOptions(() => useProfile('profile-2')).queryKey,
    readQueryOptions(() => useProfile('profile-1', { organizationId: 'org-1' })).queryKey,
  ];

  expect(new Set(keys.map(key => JSON.stringify(key))).size).toBe(keys.length);
});

it('preserves the default model cache policy outside Cloud Agent', () => {
  const options = readQueryOptions(() => useModelSelectorList('org-1'));
  expect(options.staleTime).toBe(60_000);
});

it.each(['personal', 'organization'] as const)(
  'invalidates every organization picker after a personal default changes in %s context',
  async context => {
    const trpc = createTRPCOptionsProxy<RootRouter>({ client: trpcClient, queryClient });
    const combinedKeys = ['org-1', 'org-2'].map(organizationId =>
      trpc.agentProfiles.listCombined.queryKey({ organizationId })
    );
    for (const key of combinedKeys) {
      queryClient.setQueryData(key, {
        orgProfiles: [],
        personalProfiles: [],
        effectiveDefaultId: null,
      });
    }

    let changeDefault: (() => Promise<unknown>) | undefined;
    renderHook(() => {
      const mutations =
        context === 'personal'
          ? useProfileMutations()
          : useCombinedProfileMutations({ organizationId: 'org-1' });
      changeDefault = () => mutations.setAsDefault.mutateAsync({ profileId: 'profile-1' });
    });
    if (!changeDefault) throw new Error('Profile mutation was not registered');
    await changeDefault();

    for (const key of combinedKeys) {
      expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
    }
  }
);
