import { type inferRouterOutputs, type RootRouter } from '@kilocode/trpc';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef } from 'react';

import {
  buildAgentSessionListInput,
  buildAgentSessionSearchInput,
} from '@/lib/agent-session-input';
import { groupAgentSessionsByDate } from '@/lib/agent-session-groups';
import {
  type AgentSessionSortBy,
  DEFAULT_AGENT_SESSION_SORT,
  parseAgentSessionSortBy,
} from '@/lib/agent-session-sort';
import { useTRPC } from '@/lib/trpc';

// ── Types ────────────────────────────────────────────────────────────

type RouterOutputs = inferRouterOutputs<RootRouter>;

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

function useStoredSessions(options?: UseAgentSessionsOptions) {
  const trpc = useTRPC();

  return useInfiniteQuery(
    trpc.cliSessionsV2.list.infiniteQueryOptions(buildAgentSessionListInput(options ?? {}), {
      staleTime: 30_000,
      enabled: options?.enabled,
      getNextPageParam: lastPage => lastPage.nextCursor,
    })
  );
}

function useActiveSessions(options?: UseAgentSessionsOptions) {
  const trpc = useTRPC();
  return useQuery(
    trpc.activeSessions.list.queryOptions(undefined, {
      refetchInterval: 10_000,
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
 * Server-side session search. The list itself is cursor-paginated, so
 * client-side filtering would only see the pages loaded so far — this
 * searches the user's full history instead.
 */
export function useAgentSessionSearch(options: UseAgentSessionSearchOptions) {
  const trpc = useTRPC();
  const sortBy = resolveSortBy(options.sortBy);

  const query = useQuery(
    trpc.cliSessionsV2.search.queryOptions(buildAgentSessionSearchInput(options), {
      staleTime: 30_000,
      enabled: (options.enabled ?? true) && options.searchQuery.length > 0,
      placeholderData: keepPreviousData,
    })
  );

  const sessions = useMemo(() => query.data?.results ?? [], [query.data]);
  const dateGroups = useMemo(() => groupAgentSessionsByDate(sessions, sortBy), [sessions, sortBy]);

  return {
    dateGroups,
    isPending: query.isPending,
    isError: query.isError,
    refetch: query.refetch,
  };
}

// ── Main hook ────────────────────────────────────────────────────────

export function useAgentSessions(options?: UseAgentSessionsOptions) {
  const sortBy = resolveSortBy(options?.sortBy);
  const stored = useStoredSessions(options);
  const active = useActiveSessions(options);

  // A session can repeat across pages when it is updated while older pages
  // load (the cursor follows the selected sort field), so dedupe by
  // session_id.
  const storedSessions = useMemo(() => {
    const seen = new Set<string>();
    const sessions: StoredSession[] = [];
    for (const page of stored.data?.pages ?? []) {
      for (const session of page.cliSessions) {
        if (!seen.has(session.session_id)) {
          seen.add(session.session_id);
          sessions.push(session);
        }
      }
    }
    return sessions;
  }, [stored.data]);

  const activeSessions = useMemo(() => active.data?.sessions ?? [], [active.data]);

  const activeSessionIds = useMemo(() => new Set(activeSessions.map(s => s.id)), [activeSessions]);

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
  const refetch = stored.refetch;
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
      void refetch();
    }
  }, [activeSessionIds, refetch]);

  return {
    storedSessions,
    activeSessions,
    activeSessionIds,
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
    activeIsError: active.isError,
    hasNextPage: stored.hasNextPage,
    isFetchingNextPage: stored.isFetchingNextPage,
    fetchNextPage: stored.fetchNextPage,
    refetch: async () => {
      await Promise.all([stored.refetch(), active.refetch()]);
    },
  };
}
