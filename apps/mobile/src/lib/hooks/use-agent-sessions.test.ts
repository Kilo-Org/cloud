import { InfiniteQueryObserver, QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import {
  buildActiveSessionsInput,
  buildAgentSessionListInput,
  buildAgentSessionSearchInput,
} from '@/lib/agent-session-input';
import { SESSION_HISTORY_MAX_PAGES } from '@/lib/agent-session-pages';
import {
  buildAgentSessionSearchQueryOptions,
  buildStoredSessionsQueryOptions,
} from '@/lib/agent-session-queries';
import { INFINITE_QUERY_MAX_PAGES } from '@/lib/query/infinite-retention';

// The hook module transitively imports react-native (via the user-web-
// connection lifecycle) and the real tRPC client (via `@/lib/trpc`), which the
// node vitest pipeline cannot transform. The options builder itself is pure,
// so only the module-load chain needs these mocks; no hook is mounted.
vi.mock('@/lib/trpc', () => ({
  useTRPC: vi.fn(),
}));
vi.mock('@/lib/auth/auth-context', () => ({ useAuth: vi.fn() }));
vi.mock('@/lib/organization-context', () => ({ useOrganization: vi.fn() }));
vi.mock('@/components/agents/user-web-connection-provider', () => ({
  useUserWebConnection: vi.fn(),
}));

vi.mock('@/lib/hooks/use-user-web-connection-state', () => ({
  useUserWebConnectionState: () => false,
}));

vi.mock('@/lib/active-sessions-live-sync', () => ({
  refreshActiveSessionsNow: vi.fn().mockResolvedValue(false),
}));

vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
}));
vi.mock('@/lib/query/schedule-cache-maintenance', () => ({
  scheduleCacheMaintenance: vi.fn(),
}));

function createTrpcStub(infiniteQueryOptions: unknown) {
  const stub = { cliSessionsV2: { list: { infiniteQueryOptions } } };
  return stub as never;
}

function createSearchTrpcStub(infiniteQueryOptions: unknown) {
  const stub = { cliSessionsV2: { search: { infiniteQueryOptions } } };
  return stub as never;
}

describe('buildAgentSessionListInput', () => {
  it('defaults to updated_at when sortBy is omitted (matches pre-feature behavior)', () => {
    expect(
      buildAgentSessionListInput({
        createdOnPlatform: 'cli',
        organizationId: null,
      })
    ).toMatchObject({
      orderBy: 'updated_at',
      limit: 30,
      includeChildren: false,
      createdOnPlatform: 'cli',
      organizationId: null,
    });
  });

  it('passes updated_at through when explicitly requested', () => {
    expect(
      buildAgentSessionListInput({
        sortBy: 'updated_at',
      }).orderBy
    ).toBe('updated_at');
  });

  it('passes created_at through when explicitly requested', () => {
    expect(
      buildAgentSessionListInput({
        sortBy: 'created_at',
      }).orderBy
    ).toBe('created_at');
  });

  it('falls back to updated_at for an unknown sort value (defensive default)', () => {
    expect(
      buildAgentSessionListInput({
        sortBy: 'title' as unknown as 'updated_at',
      }).orderBy
    ).toBe('updated_at');
  });

  it('forwards filter fields alongside the sort', () => {
    expect(
      buildAgentSessionListInput({
        sortBy: 'created_at',
        createdOnPlatform: ['cli', 'extension'],
        gitUrl: ['https://github.com/foo/bar'],
        organizationId: 'org-1',
      })
    ).toEqual({
      limit: 30,
      orderBy: 'created_at',
      includeChildren: false,
      createdOnPlatform: ['cli', 'extension'],
      gitUrl: ['https://github.com/foo/bar'],
      organizationId: 'org-1',
    });
  });
});

describe('buildActiveSessionsInput', () => {
  it('collapses null to { organizationId: null }', () => {
    expect(buildActiveSessionsInput(null)).toEqual({ organizationId: null });
  });

  it('passes a uuid through unchanged', () => {
    expect(buildActiveSessionsInput('a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toEqual({
      organizationId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    });
  });

  it('collapses undefined to { organizationId: null }', () => {
    expect(buildActiveSessionsInput(undefined)).toEqual({ organizationId: null });
  });

  it('produces the same key for null and undefined (key-stability rule)', () => {
    expect(buildActiveSessionsInput(null)).toEqual(buildActiveSessionsInput(undefined));
  });
});

describe('buildAgentSessionSearchInput', () => {
  it('defaults to updated_at when sortBy is omitted', () => {
    expect(buildAgentSessionSearchInput({ searchQuery: 'hello' })).toMatchObject({
      search_string: 'hello',
      orderBy: 'updated_at',
      limit: 30,
      includeChildren: false,
    });
  });

  it('uses created_at when explicitly requested', () => {
    expect(
      buildAgentSessionSearchInput({ searchQuery: 'hello', sortBy: 'created_at' })
    ).toMatchObject({
      search_string: 'hello',
      orderBy: 'created_at',
      limit: 30,
    });
  });

  it('falls back to updated_at for an unknown sort value', () => {
    expect(
      buildAgentSessionSearchInput({
        searchQuery: 'hello',
        sortBy: 'name' as unknown as 'updated_at',
      }).orderBy
    ).toBe('updated_at');
  });

  it('forwards filter fields alongside the sort', () => {
    expect(
      buildAgentSessionSearchInput({
        searchQuery: 'hello',
        sortBy: 'created_at',
        createdOnPlatform: 'cli',
        gitUrl: 'https://github.com/foo/bar',
        organizationId: 'org-1',
      })
    ).toEqual({
      search_string: 'hello',
      limit: 30,
      orderBy: 'created_at',
      includeChildren: false,
      createdOnPlatform: 'cli',
      gitUrl: 'https://github.com/foo/bar',
      organizationId: 'org-1',
    });
  });

  it('has no cursor key — the query framework injects it', () => {
    const input = buildAgentSessionSearchInput({
      searchQuery: 'hello',
      organizationId: 'org-1',
    });
    expect(input).not.toHaveProperty('cursor');
  });
});

describe('buildStoredSessionsQueryOptions', () => {
  it('leaves the native window-focus refetch off by default so the hook owns the foreground reconcile', () => {
    const infiniteQueryOptions = vi.fn((_input: unknown, options: object) => options);
    const result = buildStoredSessionsQueryOptions(createTrpcStub(infiniteQueryOptions), {});

    // The hook registers its own `useAppLifecycle` foreground edge and
    // reconciles page one; React Query's native window-focus refetch would
    // instead re-request every retained page.
    expect(infiniteQueryOptions).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 30 }),
      expect.objectContaining({ refetchOnWindowFocus: false })
    );
    expect(result.refetchOnWindowFocus).toBe(false);
  });

  it('keeps the native window-focus refetch off when the caller opts out of the hook edge', () => {
    const infiniteQueryOptions = vi.fn((_input: unknown, options: object) => options);
    const result = buildStoredSessionsQueryOptions(createTrpcStub(infiniteQueryOptions), {
      refetchOnWindowFocus: false,
    });

    // The Agents list drives foreground through its own callback, so the
    // native fan-out stays off there too.
    expect(infiniteQueryOptions).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 30 }),
      expect.objectContaining({ refetchOnWindowFocus: false })
    );
    expect(result.refetchOnWindowFocus).toBe(false);
  });

  it('keeps the explicit fetch paths enabled (enabled passthrough)', () => {
    const infiniteQueryOptions = vi.fn((_input: unknown, options: object) => options);
    const result = buildStoredSessionsQueryOptions(createTrpcStub(infiniteQueryOptions), {
      enabled: false,
    });

    expect(result.enabled).toBe(false);
  });

  it('carries a numeric maxPages retention bound', () => {
    const infiniteQueryOptions = vi.fn((_input: unknown, options: object) => options);
    const result = buildStoredSessionsQueryOptions(createTrpcStub(infiniteQueryOptions), {});

    expect(result.maxPages).toBeTypeOf('number');
  });

  it('retains the browsable history past the shared front-eviction bound', () => {
    const infiniteQueryOptions = vi.fn((_input: unknown, options: object) => options);
    const result = buildStoredSessionsQueryOptions(createTrpcStub(infiniteQueryOptions), {});

    // The history browser pages forward and scrolls back over everything it
    // loaded. The shared 5-page bound front-evicts the oldest page on every
    // later fetch (`addToEnd` slices index 0), so past five pages the top of
    // the history disappears and the list cannot scroll back to it. The
    // signed-in e2e history needs 8 pages of 30 sessions.
    expect(result.maxPages).toBeGreaterThan(INFINITE_QUERY_MAX_PAGES);
    expect(result.maxPages).toBeGreaterThanOrEqual(8);
  });

  it('caps retention so one focus/foreground refetch stays bounded', () => {
    const infiniteQueryOptions = vi.fn((_input: unknown, options: object) => options);
    const result = buildStoredSessionsQueryOptions(createTrpcStub(infiniteQueryOptions), {});

    // React Query re-requests every page retained in the cache on `refetch()`
    // (see the fan-out test in `infinite-retention.test.ts`), and the history
    // list refetches on focus return and app foreground. `maxPages` is
    // therefore also the refetch fan-out, so it stays near the browsable
    // requirement instead of letting one refetch issue 100 page requests.
    expect(result.maxPages).toBeLessThanOrEqual(20);
  });
});

describe('buildAgentSessionSearchQueryOptions', () => {
  it('carries a numeric maxPages retention bound', () => {
    const infiniteQueryOptions = vi.fn((_input: unknown, options: object) => options);
    const result = buildAgentSessionSearchQueryOptions(createSearchTrpcStub(infiniteQueryOptions), {
      searchQuery: 'hello',
    });

    expect(result.maxPages).toBeTypeOf('number');
  });

  it('keeps the search-text gating (enabled passthrough)', () => {
    const infiniteQueryOptions = vi.fn((_input: unknown, options: object) => options);
    const result = buildAgentSessionSearchQueryOptions(createSearchTrpcStub(infiniteQueryOptions), {
      searchQuery: 'hello',
    });

    expect(result.enabled).toBe(true);
  });
});

type SessionPage = {
  cliSessions: { session_id: string }[];
  nextCursor: string;
};

const echoInfiniteQueryOptions = (input: unknown, options: object) => ({ ...options, input });

type StoredOptions = {
  maxPages: number;
  getNextPageParam: (lastPage: SessionPage, pages: SessionPage[]) => string | undefined;
};

function readStoredOptions(options: object): StoredOptions {
  return options as unknown as StoredOptions;
}

/**
 * Drive a builder's real options through React Query's infinite-query
 * behavior, paging forward past the retention bound. React Query trims index 0
 * of the pages array on a forward fetch (`addToEnd`), and index 0 is page one —
 * the newest page — so this walk is what proves the head stays cached.
 */
async function walkPastRetentionBound(options: StoredOptions) {
  const queryClient = new QueryClient();
  let fetched = 0;
  const observer = new InfiniteQueryObserver(queryClient, {
    queryKey: ['session-history-retention'],
    initialPageParam: 'cursor-0',
    // eslint-disable-next-line require-await -- the recipe pins an async queryFn; the body needs no await.
    queryFn: async ({ pageParam }: { pageParam: string }) => {
      const index = Number(pageParam.replace('cursor-', ''));
      fetched += 1;
      return { cliSessions: [{ session_id: `ses-${index}` }], nextCursor: `cursor-${index + 1}` };
    },
    getNextPageParam: options.getNextPageParam,
    maxPages: options.maxPages,
    staleTime: Infinity,
    retry: false,
  });
  // eslint-disable-next-line no-empty-function -- a real listener is required to activate the observer; the body is intentionally empty.
  const unsubscribe = observer.subscribe(() => {});

  await observer.refetch();
  for (let loaded = 1; loaded <= SESSION_HISTORY_MAX_PAGES + 2; loaded += 1) {
    // eslint-disable-next-line no-await-in-loop -- each page's cursor is the previous page's result.
    await observer.fetchNextPage();
  }

  const result = observer.getCurrentResult();
  const ids = (result.data?.pages ?? []).flatMap(page =>
    page.cliSessions.map(session => session.session_id)
  );
  unsubscribe();
  return { ids, fetched, hasNextPage: result.hasNextPage };
}

describe('newest-first session paging at the retention bound', () => {
  it('refuses the page after the bound in the stored history query', () => {
    const { getNextPageParam } = readStoredOptions(
      buildStoredSessionsQueryOptions(createTrpcStub(echoInfiniteQueryOptions), {})
    );
    const page: SessionPage = { cliSessions: [], nextCursor: 'cursor-1' };
    const atBound = Array.from({ length: SESSION_HISTORY_MAX_PAGES }, () => page);
    const belowBound = atBound.slice(0, SESSION_HISTORY_MAX_PAGES - 1);

    expect(getNextPageParam(page, belowBound)).toBe('cursor-1');
    expect(getNextPageParam(page, atBound)).toBeUndefined();
  });

  it('refuses the page after the bound in the search query', () => {
    const searchOptions = buildAgentSessionSearchQueryOptions(
      createSearchTrpcStub(echoInfiniteQueryOptions),
      { searchQuery: 'hello' }
    ) as unknown as { getNextPageParam: (lastPage: unknown, pages: unknown[]) => unknown };
    const page = { results: [], nextCursor: 30 };
    const atBound = Array.from({ length: SESSION_HISTORY_MAX_PAGES }, () => page);
    const belowBound = atBound.slice(0, SESSION_HISTORY_MAX_PAGES - 1);

    expect(searchOptions.getNextPageParam(page, belowBound)).toBe(30);
    expect(searchOptions.getNextPageParam(page, atBound)).toBeUndefined();
  });

  it('keeps page one cached when the list pages past the bound', async () => {
    const { ids, fetched, hasNextPage } = await walkPastRetentionBound(
      readStoredOptions(buildStoredSessionsQueryOptions(createTrpcStub(echoInfiniteQueryOptions), {}))
    );

    // The newest page (`ses-0`) is still at the front, the walk stopped at the
    // bound, and the list reports no next page so the footer cannot page on.
    expect(ids[0]).toBe('ses-0');
    expect(ids).toHaveLength(SESSION_HISTORY_MAX_PAGES);
    expect(fetched).toBe(SESSION_HISTORY_MAX_PAGES);
    expect(hasNextPage).toBe(false);
  });
});
