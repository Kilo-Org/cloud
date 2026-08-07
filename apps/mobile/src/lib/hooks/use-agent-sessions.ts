import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef } from 'react';

import { createOperationCoordinator } from '@/components/agents/use-history-backfill';
import { sortActiveSessionsByCreatedAt } from '@/lib/active-session-order';
import {
  buildActiveSessionsTrayInput,
  filterActiveSessionsByOrganization,
  selectActiveExclusionIds,
} from '@/lib/active-sessions-live';
import { refreshActiveSessionsNow } from '@/lib/active-sessions-live-sync';
import {
  buildAgentSessionListInput,
  buildAgentSessionSearchInput,
} from '@/lib/agent-session-input';
import { collectSearchPages, collectUnfilteredPages } from '@/lib/agent-session-pages';
import { groupAgentSessionsByDate } from '@/lib/agent-session-groups';
import {
  type AgentSessionSortBy,
  DEFAULT_AGENT_SESSION_SORT,
  parseAgentSessionSortBy,
} from '@/lib/agent-session-sort';
import { useTRPC } from '@/lib/trpc';
import { useUserWebConnectionState } from '@/lib/hooks/use-user-web-connection-state';

// ── Types ────────────────────────────────────────────────────────────

type RouterOutputs = inferRouterOutputs<MobileRouter>;

export type StoredSession = RouterOutputs['cliSessionsV2']['list']['cliSessions'][number];

export type ActiveSession = RouterOutputs['activeSessions']['list']['sessions'][number];

type UseAgentSessionsOptions = {
  createdOnPlatform?: string | string[];
  gitUrl?: string | string[];
  organizationId?: string | null;
  enabled?: boolean;
  /**
   * Field to order by. Defaults to `updated_at` so callers that don't
   * care (e.g. Home's session surface) keep the legacy behavior bit-for-bit.
   */
  sortBy?: AgentSessionSortBy;
  /**
   * Native window-focus (OS app foreground) refetch for the stored-sessions
   * query. Defaults to React Query's native behavior (`true`) so Home and
   * the Share Gate keep their foreground refresh. The Agents list passes
   * `false`: its screen drives app-foreground refresh through an AppState
   * callback that runs the wrapped `refetch` behind the shared operation
   * coordinator, so the native query lifecycle must not start a stored
   * refetch that bypasses that queue (see `buildStoredSessionsQueryOptions`).
   */
  refetchOnWindowFocus?: boolean;
};

type UseRecentAgentRepositoriesOptions = {
  organizationId?: string | null;
  enabled?: boolean;
};

// ── Query-input builders ─────────────────────────────────────────────

/**
 * Resolve the effective sort once and use it for both the server `orderBy`
 * field and the client-side date grouping, so the section a row lands in
 * always agrees with the timestamp it shows.
 */
function resolveSortBy(sortBy: AgentSessionSortBy | undefined): AgentSessionSortBy {
  return parseAgentSessionSortBy(sortBy ?? DEFAULT_AGENT_SESSION_SORT);
}

// ── Date helpers ─────────────────────────────────────────────────────

function getStartOfDay(date: Date): Date {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  return result;
}

function subDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() - days);
  return result;
}

function getUpdatedSince(days: number): string {
  return getStartOfDay(subDays(new Date(), days)).toISOString();
}

// ── Queries ──────────────────────────────────────────────────────────

/**
 * Build the stored-sessions infinite-query options shared by every stored
 * refetch path on the Agents screen (focus return, pull-to-refresh, retry,
 * departure trigger, backfill). Kept as a pure builder so the query options
 * are executable-tested without mounting the hook.
 */
export function buildStoredSessionsQueryOptions(
  trpc: ReturnType<typeof useTRPC>,
  options?: UseAgentSessionsOptions
) {
  return trpc.cliSessionsV2.list.infiniteQueryOptions(buildAgentSessionListInput(options ?? {}), {
    staleTime: 30_000,
    enabled: options?.enabled,
    getNextPageParam: lastPage => lastPage.nextCursor,
    // Native window-focus refetch stays on by default so Home and the Share
    // Gate keep their OS-foreground refresh. The Agents list opts out: its
    // screen runs an AppState 'active' callback through the wrapped refetch,
    // so the native query lifecycle must not start a stored refetch that
    // bypasses the operation coordinator shared with backfill and departure.
    refetchOnWindowFocus: options?.refetchOnWindowFocus ?? true,
  });
}

function useStoredSessions(options?: UseAgentSessionsOptions) {
  const trpc = useTRPC();

  return useInfiniteQuery(buildStoredSessionsQueryOptions(trpc, options));
}

function useActiveSessions(options?: UseAgentSessionsOptions) {
  const trpc = useTRPC();
  // Cloud rows have no WS channel — discovery from other devices and departure
  // on session stop need a floor poll even while connected. WS writes remain
  // the instant path for CLI rows; the poll uses the same wholesale-replace
  // semantics as the existing enrichment refresh. When the socket is down,
  // poll every 10s so a transient outage still updates the tray.
  const wsConnected = useUserWebConnectionState();
  const input = useMemo(
    () => buildActiveSessionsTrayInput(options?.organizationId),
    [options?.organizationId]
  );
  return useQuery(
    trpc.activeSessions.list.queryOptions(input, {
      refetchInterval: wsConnected ? 30_000 : 10_000,
      staleTime: 5000,
      enabled: options?.enabled,
    })
  );
}

export function useRecentAgentRepositories(options?: UseRecentAgentRepositoriesOptions) {
  const trpc = useTRPC();
  const updatedSince = useMemo(() => getUpdatedSince(30), []);

  return useQuery(
    trpc.cliSessionsV2.recentRepositories.queryOptions(
      {
        organizationId: options?.organizationId,
        updatedSince,
      },
      { staleTime: 60_000, enabled: options?.enabled }
    )
  );
}

// ── Search ───────────────────────────────────────────────────────────

type UseAgentSessionSearchOptions = UseAgentSessionsOptions & {
  searchQuery: string;
};

/**
 * Server-side session search, now cursor-paginated for consistent
 * page size and dedupe across pages. Uses `useInfiniteQuery` with
 * `keepPreviousData` so stale rows stay visible during a search-text
 * refinement while the footer spinner signals the next-page fetch.
 */
export function useAgentSessionSearch(options: UseAgentSessionSearchOptions) {
  const trpc = useTRPC();
  const sortBy = resolveSortBy(options.sortBy);

  const query = useInfiniteQuery(
    trpc.cliSessionsV2.search.infiniteQueryOptions(buildAgentSessionSearchInput(options), {
      staleTime: 30_000,
      enabled: (options.enabled ?? true) && options.searchQuery.length > 0,
      placeholderData: keepPreviousData,
      getNextPageParam: lastPage => lastPage.nextCursor,
    })
  );

  const sessions = useMemo(() => collectSearchPages(query.data?.pages), [query.data]);
  const dateGroups = useMemo(() => groupAgentSessionsByDate(sessions, sortBy), [sessions, sortBy]);

  return {
    dateGroups,
    isPending: query.isPending,
    // Header-level fetch only — footer spinner has its own flag.
    isFetching: query.isFetching && !query.isFetchingNextPage,
    isError: query.isError,
    refetch: query.refetch,
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    isPlaceholderData: query.isPlaceholderData,
    fetchNextPage: query.fetchNextPage,
  };
}

// ── Main hook ────────────────────────────────────────────────────────

export function useAgentSessions(options?: UseAgentSessionsOptions) {
  const sortBy = resolveSortBy(options?.sortBy);
  const stored = useStoredSessions(options);
  const active = useActiveSessions(options);

  // One coordinator per hook instance, shared by the stored list's next-page
  // fetch and every stored refetch (focus return, pull-to-refresh, retry,
  // departure trigger). The backfill selector's `isFetching` gate only sees
  // the previous render, so the backfill effect and the focus effect can fire
  // in the same commit; serializing both operations guarantees they never
  // overlap the same infinite query. The query methods are aliased because
  // React Query memoizes them, and listing the object itself would rebuild the
  // callbacks every render (the backfill effect depends on their stability).
  const enqueueStoredOperation = useMemo(() => createOperationCoordinator(), []);
  const storedRefetchFn = stored.refetch;
  const storedFetchNextPage = stored.fetchNextPage;
  const storedRefetch = useCallback(async () => {
    await enqueueStoredOperation(storedRefetchFn);
  }, [enqueueStoredOperation, storedRefetchFn]);
  const fetchNextPage = useCallback(async () => {
    await enqueueStoredOperation(storedFetchNextPage);
  }, [enqueueStoredOperation, storedFetchNextPage]);

  // A session can repeat across pages when it is updated while older pages
  // load (the cursor follows the selected sort field). Dedupe by session_id
  // using the shared collection helper.
  const storedSessions = useMemo(() => collectUnfilteredPages(stored.data?.pages), [stored.data]);

  // The server already filters by context; this covers the window where a WS
  // heartbeat has introduced a row the client has not enriched yet (see
  // `filterActiveSessionsByOrganization`).
  const activeSessions = useMemo(
    () =>
      sortActiveSessionsByCreatedAt(
        filterActiveSessionsByOrganization(
          active.data?.sessions ?? [],
          options?.organizationId ?? null
        )
      ),
    [active.data, options?.organizationId]
  );

  const activeSessionIds = useMemo(() => new Set(activeSessions.map(s => s.id)), [activeSessions]);

  // Unfiltered cache ids for history exclusion. Differs from
  // `activeSessionIds` (org-filtered, tray-oriented) by also covering live
  // rows the org filter hides until enrichment — the Agents list excludes
  // those from history immediately (direct move into the tray at enrichment).
  // The departure-refetch effect below intentionally keeps diffing the
  // filtered set: an unenriched row that disappears re-renders from the
  // already-loaded stored pages as soon as the exclusion lifts.
  const activeExclusionIds = useMemo(
    () => selectActiveExclusionIds(active.data?.sessions ?? []),
    [active.data]
  );

  const dateGroups = useMemo(
    () => groupAgentSessionsByDate(storedSessions, sortBy),
    [storedSessions, sortBy]
  );

  // Departure-triggered stored refetch. Only the active poll has a refetch
  // interval (10s); the stored/history list does not. When a session id
  // leaves the active set, the just-terminated session has not yet shown up
  // in history, so refetching once makes it reappear. We use `refetch()` so
  // the fresh fetch bypasses the 30s `staleTime` that would otherwise keep
  // the cached page hidden. The refetch only refreshes loaded pages —
  // sufficient because a just-terminated session always lands on page 1.
  //
  // The guard is strictly "id present before, absent now": the empty→populated
  // transition (first poll) is ignored, and the initial mount with a non-empty
  // set is ignored (no "before" to compare against).
  const previousActiveIdsRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    const previous = previousActiveIdsRef.current;
    previousActiveIdsRef.current = activeSessionIds;
    if (!previous) {
      return;
    }
    let departedId: string | undefined = undefined;
    for (const id of previous) {
      if (!activeSessionIds.has(id)) {
        departedId = id;
        break;
      }
    }
    if (departedId) {
      void storedRefetch();
    }
  }, [activeSessionIds, storedRefetch]);

  return {
    storedSessions,
    activeSessions,
    activeSessionIds,
    activeExclusionIds,
    dateGroups,
    isLoading: stored.isLoading || active.isLoading,
    isError: stored.isError || active.isError,
    // Stored and active sessions come from independent queries with very
    // different failure modes: a transient active-poll blip (10s interval)
    // is common and should never hide stored history, while a stored-list
    // failure is the one that actually blocks showing sessions at all.
    // Callers that need to tell these apart (e.g. deciding promo vs error
    // vs "keep showing stale data") should use these instead of `isError`.
    storedIsError: stored.isError,
    storedIsSuccess: stored.isSuccess,
    // Any stored-list fetch in flight (initial load, refetch, next page),
    // used by the backfill selector to serialize automatic fetches behind
    // user- or focus-driven refetches on the same infinite query. The selector
    // only observes the previous render, so `createOperationCoordinator`
    // closes the same-commit gap where the backfill effect and a focus
    // refetch fire before these flags update.
    storedIsFetching: stored.isFetching,
    // Loaded stored pages; the backfill bound is `data.pages.length`, not the
    // rendered row count, because active-set exclusion can hide whole pages.
    storedLoadedPageCount: stored.data?.pages.length ?? 0,
    activeIsError: active.isError,
    hasNextPage: stored.hasNextPage,
    isFetchingNextPage: stored.isFetchingNextPage,
    fetchNextPage,
    refetch: async () => {
      await Promise.all([
        storedRefetch(),
        (async () => {
          // The live-sync owner writes and cancels this same query key, so a
          // plain refetch alone can be swallowed by it. Drive the owner when
          // one is attached — it is keyed to the same organization context
          // this hook is given — and fall back to the plain refetch otherwise.
          if (await refreshActiveSessionsNow()) {
            return;
          }
          await active.refetch();
        })(),
      ]);
    },
  };
}
