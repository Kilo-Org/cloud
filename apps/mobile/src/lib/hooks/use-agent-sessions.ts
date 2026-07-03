import { type inferRouterOutputs, type RootRouter } from '@kilocode/trpc';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { useTRPC } from '@/lib/trpc';
import { parseTimestamp } from '@/lib/utils';

// ── Types ────────────────────────────────────────────────────────────

type RouterOutputs = inferRouterOutputs<RootRouter>;

export type StoredSession = RouterOutputs['cliSessionsV2']['list']['cliSessions'][number];

export type ActiveSession = RouterOutputs['activeSessions']['list']['sessions'][number];

type DateGroup = {
  label: string;
  sessions: StoredSession[];
};

type UseAgentSessionsOptions = {
  createdOnPlatform?: string | string[];
  gitUrl?: string | string[];
  organizationId?: string | null;
  enabled?: boolean;
};

type UseRecentAgentRepositoriesOptions = {
  organizationId?: string | null;
  enabled?: boolean;
};

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

const SESSIONS_PAGE_SIZE = 30;

function useStoredSessions(options?: UseAgentSessionsOptions) {
  const trpc = useTRPC();

  return useInfiniteQuery(
    trpc.cliSessionsV2.list.infiniteQueryOptions(
      {
        limit: SESSIONS_PAGE_SIZE,
        orderBy: 'updated_at',
        includeChildren: false,
        createdOnPlatform: options?.createdOnPlatform,
        gitUrl: options?.gitUrl,
        organizationId: options?.organizationId,
      },
      {
        staleTime: 30_000,
        enabled: options?.enabled,
        getNextPageParam: lastPage => lastPage.nextCursor,
      }
    )
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

// ── Date grouping ────────────────────────────────────────────────────

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function getWeekdayName(date: Date): string {
  return new Intl.DateTimeFormat('en-US', { weekday: 'long' }).format(date);
}

function groupSessionsByDate(sessions: StoredSession[]): DateGroup[] {
  const now = new Date();
  const yesterday = addDays(now, -1);

  const buckets = new Map<string, StoredSession[]>();
  const bucketOrder: string[] = [];

  function addToBucket(label: string, session: StoredSession) {
    const existing = buckets.get(label);
    if (existing) {
      existing.push(session);
    } else {
      buckets.set(label, [session]);
      bucketOrder.push(label);
    }
  }

  for (const session of sessions) {
    const date = parseTimestamp(session.updated_at);

    if (isSameDay(date, now)) {
      addToBucket('Today', session);
    } else if (isSameDay(date, yesterday)) {
      addToBucket('Yesterday', session);
    } else {
      const diffMs = now.getTime() - date.getTime();
      const diffDays = diffMs / (1000 * 60 * 60 * 24);
      if (diffDays <= 7) {
        addToBucket(getWeekdayName(date), session);
      } else {
        addToBucket('Older', session);
      }
    }
  }

  // Sort "Older" bucket by updated_at descending
  const olderBucket = buckets.get('Older');
  if (olderBucket) {
    olderBucket.sort(
      (a, b) => parseTimestamp(b.updated_at).getTime() - parseTimestamp(a.updated_at).getTime()
    );
  }

  return bucketOrder.map(label => ({
    label,
    sessions: buckets.get(label) ?? [],
  }));
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

  const query = useQuery(
    trpc.cliSessionsV2.search.queryOptions(
      {
        search_string: options.searchQuery,
        // Endpoint max; no offset paging — past 50 matches, refining the query is the answer.
        limit: 50,
        includeChildren: false,
        createdOnPlatform: options.createdOnPlatform,
        gitUrl: options.gitUrl,
        organizationId: options.organizationId,
      },
      {
        staleTime: 30_000,
        enabled: (options.enabled ?? true) && options.searchQuery.length > 0,
        placeholderData: keepPreviousData,
      }
    )
  );

  const sessions = useMemo(() => query.data?.results ?? [], [query.data]);
  const dateGroups = useMemo(() => groupSessionsByDate(sessions), [sessions]);

  return { dateGroups, isPending: query.isPending, isError: query.isError };
}

// ── Main hook ────────────────────────────────────────────────────────

export function useAgentSessions(options?: UseAgentSessionsOptions) {
  const stored = useStoredSessions(options);
  const active = useActiveSessions(options);

  // A session can repeat across pages when it is updated while older pages
  // load (the cursor is its updated_at), so dedupe by session_id.
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

  const dateGroups = useMemo(() => groupSessionsByDate(storedSessions), [storedSessions]);

  return {
    storedSessions,
    activeSessions,
    activeSessionIds,
    dateGroups,
    isLoading: stored.isLoading || active.isLoading,
    isError: stored.isError || active.isError,
    hasNextPage: stored.hasNextPage,
    isFetchingNextPage: stored.isFetchingNextPage,
    fetchNextPage: stored.fetchNextPage,
    refetch: async () => {
      await Promise.all([stored.refetch(), active.refetch()]);
    },
  };
}
