/* eslint-disable import/max-dependencies */
/* eslint-disable max-lines -- Cohesive list component; splitting Active/History sections would reduce clarity */
import { useQuery, useQueryClient, useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { AlertTriangle, Bot, History, Plus, Search, WifiOff } from 'lucide-react';
import { useExtensionAgents } from './agents-provider';

// ---------------------------------------------------------------------------
// Pinned query keys — same constants for queries and invalidations
// ---------------------------------------------------------------------------

const activeSessionsQueryKey = (organizationId: string | null) =>
  ['agents', 'active-sessions', organizationId] as const;

const sessionHistoryQueryKey = (organizationId: string | null) =>
  ['agents', 'session-history', organizationId] as const;

const sessionSearchQueryKey = (organizationId: string | null, query: string) =>
  ['agents', 'session-search', organizationId, query] as const;

// Exported for focused test coverage.
export { activeSessionsQueryKey, sessionHistoryQueryKey, sessionSearchQueryKey };

const HISTORY_PAGE_LIMIT = 30;
const SEARCH_LIMIT = 50;
const MIN_SEARCH_LENGTH = 2;
const ACTIVE_POLL_CONNECTED_MS = 30_000;
const ACTIVE_POLL_DISCONNECTED_MS = 10_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ActiveSessionRow {
  id: string;
  title: string | null;
  status: string | null;
  repository: string | null;
  gitBranch: string | null;
  isCloudAgent: boolean;
}

/**
 * Maps a typed active session wire row to the row the UI expects.
 * Extracted so tests can assert the `connectionId === 'cloud-agent'`
 * marker and gitUrl/gitBranch/status field access.
 */
export function mapActiveSessionRow(params: {
  id: string;
  title: string;
  status: string;
  connectionId: string;
  gitUrl?: string;
  gitBranch?: string;
}): ActiveSessionRow {
  return {
    gitBranch: params.gitBranch ?? null,
    id: params.id,
    isCloudAgent: params.connectionId === 'cloud-agent',
    repository: params.gitUrl ?? null,
    status: params.status,
    title: params.title ?? null,
  };
}

interface HistorySessionRow {
  id: string;
  title: string | null;
  updatedAt: string;
}

/**
 * Maps a typed history/list wire row (as received from cliSessionsV2.list or
 * cliSessionsV2.search) to the UI row. Extracted so tests can assert the
 * `results`/`cliSessions` field mapping without rendering the component.
 */
export function mapHistorySessionRow(params: {
  session_id: string;
  title: string | null;
  updated_at: string;
}): HistorySessionRow {
  return {
    id: params.session_id,
    title: params.title,
    updatedAt: params.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Status badge classifier
// ---------------------------------------------------------------------------

export const sessionStatusBadge = (
  status: string | null
): { label: string; className: string } | null => {
  if (status === null) {
    return null;
  }
  const lowerStatus = status.toLowerCase();
  if (lowerStatus === 'question' || lowerStatus === 'permission') {
    return { className: 'bg-status-yellow-500/15 text-status-yellow-500', label: 'Needs input' };
  }
  if (lowerStatus === 'running') {
    return { className: 'bg-status-green-500/15 text-status-green-500', label: 'Running' };
  }
  return { className: 'bg-surface-selected text-foreground-muted', label: status };
};

// ---------------------------------------------------------------------------
// Active sessions section
// ---------------------------------------------------------------------------

const ActiveSessionsSection = ({
  onOpenSession,
  organizationId,
}: {
  onOpenSession: (kiloSessionId: string) => void;
  organizationId: string | null;
}): JSX.Element => {
  const { trpcClient, userWebConnection } = useExtensionAgents();
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(() => userWebConnection.isConnected());

  useEffect(() => {
    const unsubscribe = userWebConnection.onConnectionChange((connectedStatus: boolean) => {
      setConnected(connectedStatus);
    });
    return unsubscribe;
  }, [userWebConnection]);

  // Subscribe UserWeb events → invalidate active list
  useEffect(() => {
    const eventNames = [
      'session.created',
      'session.updated',
      'session.status.updated',
      'session.deleted',
    ] as const;

    const unsubs = eventNames.map(event =>
      userWebConnection.onSessionEvent(event, () => {
        void queryClient.invalidateQueries({ queryKey: activeSessionsQueryKey(organizationId) });
      })
    );

    return () => {
      for (const unsub of unsubs) {
        unsub();
      }
    };
  }, [userWebConnection, queryClient, organizationId]);

  const listInput = useMemo(
    () =>
      ({
        includeCloudAgentSessions: true,
        organizationId,
      }) satisfies { organizationId: string | null; includeCloudAgentSessions: boolean },
    [organizationId]
  );

  const { data, error, isError, isLoading, refetch, isRefetching } = useQuery({
    queryFn: () => trpcClient.activeSessions.list.query(listInput),
    queryKey: activeSessionsQueryKey(organizationId),
    refetchInterval: connected ? ACTIVE_POLL_CONNECTED_MS : ACTIVE_POLL_DISCONNECTED_MS,
  });

  const sessions: ActiveSessionRow[] = useMemo(
    () => data?.sessions.map(session => mapActiveSessionRow(session)) ?? [],
    [data]
  );

  if (isLoading) {
    return (
      <div className="space-y-1 px-4 py-2">
        <div className="flex items-center gap-2">
          <Bot className="size-4 text-foreground-muted" />
          <span className="type-label text-foreground-muted">Active</span>
          <span className="h-4 w-12 animate-pulse rounded bg-surface-selected" />
        </div>
      </div>
    );
  }

  if (isError && data === undefined) {
    return (
      <div className="space-y-2 px-4 py-2">
        <div className="flex items-center gap-2">
          <Bot className="size-4 text-foreground-muted" />
          <span className="type-label text-foreground-muted">Active</span>
        </div>
        <div className="rounded-lg border border-border bg-surface-raised p-3">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-status-red-400" />
            <div className="min-w-0 flex-1">
              <p className="type-label text-status-red-400">Failed to load active sessions</p>
              <p className="type-label mt-0.5 text-foreground-muted">
                {error instanceof Error ? error.message : 'An unexpected error occurred'}
              </p>
            </div>
            <button
              className="h-8 shrink-0 rounded-md border border-border bg-surface-overlay px-3 type-label text-foreground-on-secondary transition hover:bg-surface-hover outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring"
              disabled={isRefetching}
              onClick={() => void refetch()}
              type="button"
            >
              {isRefetching ? 'Retrying…' : 'Retry'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1 px-4 py-2">
      <div className="flex items-center gap-2">
        <Bot className="size-4 text-foreground-muted" />
        <span className="type-label text-foreground-muted">Active</span>
        {connected ? null : (
          <span className="flex items-center gap-1 rounded-full bg-surface-selected px-1.5 py-0.5 type-label text-foreground-muted">
            <WifiOff className="size-3" />
            Offline
          </span>
        )}
      </div>
      {isError ? (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-surface-raised p-2">
          <AlertTriangle className="size-4 shrink-0 text-status-red-400" />
          <p className="min-w-0 flex-1 truncate type-label text-status-red-400">
            Failed to refresh active sessions
          </p>
          <button
            className="h-7 shrink-0 rounded-md border border-border bg-surface-overlay px-2 type-label text-foreground-on-secondary transition hover:bg-surface-hover outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring"
            disabled={isRefetching}
            onClick={() => void refetch()}
            type="button"
          >
            {isRefetching ? 'Retrying…' : 'Retry'}
          </button>
        </div>
      ) : null}
      {sessions.length === 0 ? (
        <p className="type-label text-foreground-muted pl-6">No active sessions</p>
      ) : (
        <div className="space-y-0.5">
          {sessions.map(session => {
            const badge = sessionStatusBadge(session.status);
            return (
              <button
                className="w-full rounded-md px-2 py-1.5 text-left type-body transition hover:bg-surface-hover outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring"
                key={session.id}
                onClick={() => {
                  onOpenSession(session.id);
                }}
                type="button"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-foreground">
                    {session.title ?? 'Unnamed session'}
                  </span>
                  {badge ? (
                    <span
                      className={`shrink-0 rounded-full px-1.5 py-0.5 type-label ${badge.className}`}
                    >
                      {badge.label}
                    </span>
                  ) : null}
                </div>
                {session.repository === null && session.gitBranch === null ? null : (
                  <div className="mt-0.5 flex items-center gap-1.5 truncate type-label text-foreground-muted">
                    {session.repository === null ? null : <span>{session.repository}</span>}
                    {session.gitBranch === null ? null : <span>{session.gitBranch}</span>}
                  </div>
                )}
                {session.isCloudAgent ? (
                  <div className="mt-0.5">
                    <span className="rounded-full bg-surface-selected px-1.5 py-0.5 type-label text-foreground-muted">
                      Cloud
                    </span>
                  </div>
                ) : null}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// History sessions section
// ---------------------------------------------------------------------------

const relativeTime = (dateStr: string): string => {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) {
    return 'Just now';
  }
  if (diffMin < 60) {
    return `${diffMin}m ago`;
  }
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) {
    return `${diffDays}d ago`;
  }
  const diffMonths = Math.floor(diffDays / 30);
  return `${diffMonths}mo ago`;
};

const HistorySessionsSection = ({
  onOpenSession,
  organizationId,
}: {
  onOpenSession: (kiloSessionId: string) => void;
  organizationId: string | null;
}): JSX.Element => {
  const { trpcClient } = useExtensionAgents();
  const [searchQuery, setSearchQuery] = useState('');
  const isSearching = searchQuery.trim().length >= MIN_SEARCH_LENGTH;

  const {
    data: searchData,
    error: searchError,
    isError: isSearchError,
    isLoading: isSearchLoading,
    refetch: searchRefetch,
    isRefetching: isSearchRefetching,
  } = useQuery({
    enabled: isSearching,
    queryFn: () =>
      trpcClient.cliSessionsV2.search.query({
        limit: SEARCH_LIMIT,
        organizationId,
        search_string: searchQuery.trim(),
      }),
    queryKey: sessionSearchQueryKey(organizationId, searchQuery.trim()),
  });

  const {
    data: historyData,
    error: historyError,
    isError: isHistoryError,
    isLoading: isHistoryLoading,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    refetch: historyRefetch,
    isRefetching: isHistoryRefetching,
  } = useInfiniteQuery({
    enabled: !isSearching,
    getNextPageParam: lastPage =>
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- tRPC infinite query page shape
      (lastPage as { nextCursor?: string }).nextCursor ?? undefined,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      trpcClient.cliSessionsV2.list.query({
        includeChildren: false,
        limit: HISTORY_PAGE_LIMIT,
        orderBy: 'updated_at',
        organizationId,
        ...(pageParam === undefined ? {} : { cursor: pageParam }),
      }),
    queryKey: sessionHistoryQueryKey(organizationId),
  });

  /* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-type-assertion -- tRPC infinite query page type is unknown */
  const allHistoryRows: HistorySessionRow[] = useMemo(
    () =>
      historyData?.pages.flatMap(
        page =>
          (
            page as {
              cliSessions?: { session_id: string; title: string | null; updated_at: string }[];
            }
          ).cliSessions?.map(session => mapHistorySessionRow(session)) ?? []
      ) ?? [],
    [historyData]
  );
  /* eslint-enable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-type-assertion */

  const searchRows: HistorySessionRow[] = useMemo(
    () =>
      searchData ? (searchData.results?.map(session => mapHistorySessionRow(session)) ?? []) : [],
    [searchData]
  );

  const errorMessage =
    (searchError instanceof Error ? searchError.message : undefined) ??
    (historyError instanceof Error ? historyError.message : undefined) ??
    'Failed to load history';

  const hasError = isSearching ? isSearchError : isHistoryError;
  const isLoading = isSearching ? isSearchLoading : isHistoryLoading;
  const refetch = () => {
    if (isSearching) {
      void searchRefetch();
    } else {
      void historyRefetch();
    }
  };
  const isRefetching = isSearching ? isSearchRefetching : isHistoryRefetching;
  const rows = isSearching ? searchRows : allHistoryRows;
  const hasNoResults = !isLoading && !hasError && rows.length === 0;

  return (
    <div className="space-y-2 px-4 py-3">
      <div className="flex items-center gap-2">
        <History className="size-4 text-foreground-muted" />
        <span className="type-label text-foreground-muted">History</span>
      </div>

      {/* Search box */}
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-foreground-muted" />
        <input
          aria-label="Search sessions"
          className="h-8 w-full rounded-md border border-border bg-input-bg pl-7.5 pr-2 type-body text-foreground placeholder:text-foreground-muted outline-none transition focus-visible:ring-2 focus-visible:ring-brand-primary-ring"
          onChange={changeEvent => {
            setSearchQuery(changeEvent.currentTarget.value);
          }}
          placeholder="Search sessions…"
          type="search"
          value={searchQuery}
        />
      </div>

      {/* Error state */}
      {hasError ? (
        <div className="rounded-lg border border-border bg-surface-raised p-3">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-status-red-400" />
            <div className="min-w-0 flex-1">
              <p className="type-label text-status-red-400">{errorMessage}</p>
            </div>
            <button
              className="h-8 shrink-0 rounded-md border border-border bg-surface-overlay px-3 type-label text-foreground-on-secondary transition hover:bg-surface-hover outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring"
              disabled={isRefetching}
              onClick={refetch}
              type="button"
            >
              {isRefetching ? 'Retrying…' : 'Retry'}
            </button>
          </div>
        </div>
      ) : null}

      {/* Loading state */}
      {isLoading ? (
        <div className="space-y-2 py-1">
          {[1, 2, 3].map(idx => (
            <div className="flex items-center gap-2 px-2 py-1.5" key={idx}>
              <span className="h-3 flex-1 animate-pulse rounded bg-surface-selected" />
              <span className="h-3 w-10 animate-pulse rounded bg-surface-selected" />
            </div>
          ))}
        </div>
      ) : null}

      {/* Empty state */}
      {hasNoResults ? (
        <div className="py-3 text-center">
          <p className="type-body text-foreground-muted">
            {isSearching
              ? 'No sessions match your search.'
              : 'No sessions yet. Create your first cloud session!'}
          </p>
        </div>
      ) : null}

      {/* Row list */}
      {!hasError && !isLoading && rows.length > 0 ? (
        <div className="space-y-0.5">
          {rows.map(session => (
            <button
              className="w-full rounded-md px-2 py-1.5 text-left type-body transition hover:bg-surface-hover outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring"
              key={session.id}
              onClick={() => {
                onOpenSession(session.id);
              }}
              type="button"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-foreground">{session.title ?? 'New session'}</span>
                <span className="shrink-0 type-label text-foreground-muted">
                  {relativeTime(session.updatedAt)}
                </span>
              </div>
            </button>
          ))}
        </div>
      ) : null}

      {/* Load more */}
      {!isSearching && hasNextPage ? (
        <button
          className="h-8 w-full rounded-md border border-border bg-surface-overlay type-label text-foreground-on-secondary transition hover:bg-surface-hover outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring disabled:cursor-not-allowed disabled:opacity-50"
          disabled={isFetchingNextPage}
          onClick={() => {
            void fetchNextPage();
          }}
          type="button"
        >
          {isFetchingNextPage ? 'Loading…' : 'Load more'}
        </button>
      ) : null}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Session list root
// ---------------------------------------------------------------------------

// eslint-disable-next-line max-lines -- Cohesive list component; splitting Active/History sections would reduce clarity
export const AgentsSessionList = ({
  onNewSession,
  onOpenSession,
}: {
  onNewSession: () => void;
  onOpenSession: (kiloSessionId: string) => void;
}): JSX.Element => {
  const { organizationId } = useExtensionAgents();

  return (
    <div className="agent-conversation-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto">
      {/* New session CTA */}
      <div className="shrink-0 px-4 pt-3">
        <button
          className="flex h-10 w-full items-center justify-center gap-2 rounded-md bg-brand-primary type-label font-medium text-brand-primary-foreground transition hover:bg-brand-primary-hover outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring ring-offset-2 ring-offset-surface-background"
          onClick={onNewSession}
          type="button"
        >
          <Plus className="size-4" />
          New session
        </button>
      </div>

      <ActiveSessionsSection onOpenSession={onOpenSession} organizationId={organizationId} />
      <HistorySessionsSection onOpenSession={onOpenSession} organizationId={organizationId} />
    </div>
  );
};
