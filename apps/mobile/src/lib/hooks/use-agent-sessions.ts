import { type inferRouterOutputs, type RootRouter } from '@kilocode/trpc';
import { useQuery } from '@tanstack/react-query';
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

function useStoredSessions(options?: UseAgentSessionsOptions) {
  const trpc = useTRPC();
  const updatedSince = useMemo(() => getUpdatedSince(5), []);

  return useQuery(
    trpc.cliSessionsV2.list.queryOptions(
      {
        updatedSince,
        orderBy: 'updated_at',
        includeChildren: false,
        createdOnPlatform: options?.createdOnPlatform,
        gitUrl: options?.gitUrl,
        organizationId: options?.organizationId,
      },
      { staleTime: 30_000, enabled: options?.enabled }
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

// ── Main hook ────────────────────────────────────────────────────────

export function useAgentSessions(options?: UseAgentSessionsOptions) {
  const stored = useStoredSessions(options);
  const active = useActiveSessions(options);

  const storedSessions = useMemo(() => stored.data?.cliSessions ?? [], [stored.data]);

  const activeSessions = useMemo(() => active.data?.sessions ?? [], [active.data]);

  const activeSessionIds = useMemo(() => new Set(activeSessions.map(s => s.id)), [activeSessions]);

  const liveStoredSessions = useMemo(
    () => storedSessions.filter(s => activeSessionIds.has(s.session_id)),
    [storedSessions, activeSessionIds]
  );

  const offlineSessions = useMemo(
    () => storedSessions.filter(s => !activeSessionIds.has(s.session_id)),
    [storedSessions, activeSessionIds]
  );

  const dateGroups = useMemo(() => groupSessionsByDate(storedSessions), [storedSessions]);

  return {
    storedSessions,
    activeSessions,
    activeSessionIds,
    liveStoredSessions,
    offlineSessions,
    dateGroups,
    isLoading: stored.isLoading || active.isLoading,
    isError: stored.isError || active.isError,
    refetch: async () => {
      await Promise.all([stored.refetch(), active.refetch()]);
    },
  };
}
