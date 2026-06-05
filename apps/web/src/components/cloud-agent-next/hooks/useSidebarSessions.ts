/**
 * Hook for managing sidebar session list
 *
 * Fetches v2 sessions and maintains them in Jotai atoms
 * for reactive updates across the UI. Supports search and platform filtering.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { useUserWebConnection } from '../CloudAgentProvider';
import type { UserWebSessionEventData } from '@/lib/cloud-agent-sdk';
import {
  apiSessionToDbSession,
  dbSessionsAtom,
  recentSessionsAtom,
  type DbSession,
  type DbSessionV2,
} from '../store/db-session-atoms';
import { startOfDay, subDays } from 'date-fns';
import { extractRepoFromGitUrl } from '../utils/git-utils';
import type { StoredSession } from '../types';

/**
 * Extract "owner/repo" from a git URL for display.
 * Branch is returned separately via StoredSession.branch.
 */
function extractRepoDisplay(gitUrl: string | null | undefined): string {
  return extractRepoFromGitUrl(gitUrl) ?? '';
}

export function dbSessionToStoredSession(session: DbSession | DbSessionV2): StoredSession {
  const title = session.title || `Session ${session.session_id.substring(0, 8)}`;

  const dbSession = session;

  return {
    sessionId: session.session_id,
    repository: extractRepoDisplay(dbSession.git_url),
    branch: dbSession.git_branch ?? null,
    prompt: title,
    mode: 'last_mode' in dbSession ? (dbSession.last_mode ?? 'code') : 'code',
    model: 'last_model' in dbSession ? (dbSession.last_model ?? '') : '',
    status: session.cloud_agent_session_id ? 'active' : 'completed',
    createdAt: session.created_at.toISOString(),
    updatedAt: session.updated_at.toISOString(),
    messages: [],
    cloudAgentSessionId: session.cloud_agent_session_id,
    createdOnPlatform: dbSession.created_on_platform ?? null,
    sessionStatus: session.status,
    sessionStatusUpdatedAt: session.status_updated_at?.toISOString() ?? null,
    associatedPr: 'associatedPr' in dbSession ? (dbSession.associatedPr ?? null) : undefined,
  };
}

const SIDEBAR_LIST_LIMIT = 200;

/**
 * Stable string key for a single session list entry.
 * Used to detect changes that should trigger a Jotai atom update, including
 * PR state changes that arrive via webhook without modifying the session row.
 */
function sessionCacheKey(s: {
  session_id: string;
  updated_at: string;
  status: string | null;
  status_updated_at: string | null;
  associatedPr?: {
    state: string;
    lastSyncedAt: string;
    reviewDecision: string | null;
    reviewDecisionPending: boolean;
  } | null;
}): string {
  return `${s.session_id}-${s.updated_at}-${s.status ?? ''}-${s.status_updated_at ?? ''}-${s.associatedPr?.state ?? ''}-${s.associatedPr?.lastSyncedAt ?? ''}-${s.associatedPr?.reviewDecision ?? ''}-${s.associatedPr?.reviewDecisionPending ?? false}`;
}

/**
 * Polling cadence used while any row in the list reports
 * `associatedPr.reviewDecisionPending`. The server's batched GraphQL fetch
 * typically lands within a few seconds, so we re-query at this interval until
 * the flag clears, then stop.
 */
const REVIEW_DECISION_POLL_INTERVAL_MS = 5_000;

type SidebarSessionFilters = {
  organizationId?: string | null;
  createdOnPlatform?: string | string[];
  gitUrl?: string | string[];
};

function eventRowToDbSession(
  row: UserWebSessionEventData<'session.created'>['session']
): DbSessionV2 {
  return {
    session_id: row.sessionId,
    title: row.title,
    cloud_agent_session_id: null,
    created_on_platform: row.createdOnPlatform,
    organization_id: row.organizationId,
    git_url: row.gitUrl,
    git_branch: row.gitBranch,
    parent_session_id: row.parentSessionId,
    created_at: new Date(row.createdAt),
    updated_at: new Date(row.updatedAt),
    version: 2,
    status: row.status,
    status_updated_at: row.statusUpdatedAt ? new Date(row.statusUpdatedAt) : null,
  };
}

function compareDbSessionsByUpdatedAtDesc(
  a: DbSession | DbSessionV2,
  b: DbSession | DbSessionV2
): number {
  const diff = b.updated_at.getTime() - a.updated_at.getTime();
  if (diff !== 0) return diff;
  return b.session_id.localeCompare(a.session_id);
}

export function sortSidebarDbSessions(
  sessions: (DbSession | DbSessionV2)[]
): (DbSession | DbSessionV2)[] {
  return [...sessions].sort(compareDbSessionsByUpdatedAtDesc);
}

function mergeSidebarDbSession(
  existing: DbSession | DbSessionV2 | undefined,
  next: DbSessionV2
): DbSessionV2 {
  if (!existing) return next;

  const merged = {
    ...next,
    cloud_agent_session_id: existing.cloud_agent_session_id ?? next.cloud_agent_session_id,
  };
  if ('associatedPr' in existing) return { ...merged, associatedPr: existing.associatedPr };
  return merged;
}

export function upsertSidebarDbSession(
  sessions: (DbSession | DbSessionV2)[],
  next: DbSessionV2
): (DbSession | DbSessionV2)[] {
  const existing = sessions.find(session => session.session_id === next.session_id);
  const merged = mergeSidebarDbSession(existing, next);
  return sortSidebarDbSessions([
    ...sessions.filter(session => session.session_id !== next.session_id),
    merged,
  ]);
}

export function removeSidebarDbSession(
  sessions: (DbSession | DbSessionV2)[],
  sessionId: string
): (DbSession | DbSessionV2)[] {
  return sessions.filter(s => s.session_id !== sessionId);
}

function filterValues(value: string | string[] | undefined): string[] | null {
  if (value === undefined) return null;
  return Array.isArray(value) ? value : [value];
}

export function eventRowMatchesSidebarFilters(
  row: UserWebSessionEventData<'session.created'>['session'],
  filters: SidebarSessionFilters
): boolean | null {
  if (row.parentSessionId) return false;

  if (filters.organizationId !== undefined) {
    if ((row.organizationId ?? null) !== filters.organizationId) return false;
  }

  const platforms = filterValues(filters.createdOnPlatform);
  if (platforms) {
    if (platforms.includes('other')) return null;
    if (!row.createdOnPlatform || !platforms.includes(row.createdOnPlatform)) return false;
  }

  const gitUrls = filterValues(filters.gitUrl);
  if (gitUrls) {
    if (!row.gitUrl || !gitUrls.includes(row.gitUrl)) return false;
  }

  return true;
}

export function dbSessionMatchesSearch(session: DbSessionV2, searchQuery: string): boolean {
  const normalizedQuery = searchQuery.trim().toLowerCase();
  if (!normalizedQuery) return true;
  return (
    session.session_id.toLowerCase().includes(normalizedQuery) ||
    (session.title ?? '').toLowerCase().includes(normalizedQuery)
  );
}

/**
 * Status events are patched locally and reconciled in batches so frequent
 * activity transitions do not issue one authoritative refetch per event.
 */
export const SIDEBAR_RECONCILE_DELAY_MS = 30_000;

type SidebarQueryReconciler = {
  schedule: () => void;
  reconcileNow: () => void;
  dispose: () => void;
};

export function createSidebarQueryReconciler(reconcile: () => void): SidebarQueryReconciler {
  let pendingReconciliation: ReturnType<typeof setTimeout> | null = null;

  const clearPendingReconciliation = () => {
    if (pendingReconciliation === null) return;
    clearTimeout(pendingReconciliation);
    pendingReconciliation = null;
  };

  return {
    schedule: () => {
      if (pendingReconciliation !== null) return;
      pendingReconciliation = setTimeout(() => {
        pendingReconciliation = null;
        reconcile();
      }, SIDEBAR_RECONCILE_DELAY_MS);
    },
    reconcileNow: () => {
      clearPendingReconciliation();
      reconcile();
    },
    dispose: clearPendingReconciliation,
  };
}

type UseSidebarSessionsOptions = {
  organizationId?: string | null;
  searchQuery?: string;
  createdOnPlatform?: string | string[];
  gitUrl?: string | string[];
};

type UseSidebarSessionsReturn = {
  sessions: StoredSession[];
  isLoading: boolean;
  refetchSessions: () => void;
  renameSessionLocally: (sessionId: string, newTitle: string) => void;
};

export function useSidebarSessions(options?: UseSidebarSessionsOptions): UseSidebarSessionsReturn {
  const { organizationId, searchQuery = '', createdOnPlatform, gitUrl } = options ?? {};
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const sharedConnection = useUserWebConnection();
  const reconcileSidebarQueries = useCallback(() => {
    void queryClient.invalidateQueries(trpc.cliSessionsV2.list.pathFilter());
    void queryClient.invalidateQueries(trpc.cliSessionsV2.search.pathFilter());
    void queryClient.invalidateQueries(trpc.cliSessionsV2.recentRepositories.pathFilter());
  }, [queryClient, trpc]);
  const queryReconciler = useMemo(
    () => createSidebarQueryReconciler(reconcileSidebarQueries),
    [reconcileSidebarQueries]
  );

  useEffect(() => () => queryReconciler.dispose(), [queryReconciler]);

  const recentSessions = useAtomValue(recentSessionsAtom);
  const setDbSessions = useSetAtom(dbSessionsAtom);

  const isSearchActive = searchQuery.length > 0;

  // --- List query (default, non-search) ---
  const updatedSince = useMemo(() => startOfDay(subDays(new Date(), 5)).toISOString(), []);
  const listInput = useMemo(
    () => ({
      updatedSince,
      limit: SIDEBAR_LIST_LIMIT,
      orderBy: 'updated_at' as const,
      organizationId,
      createdOnPlatform,
      gitUrl,
      fetchReviewDecision: true,
    }),
    [updatedSince, organizationId, createdOnPlatform, gitUrl]
  );
  const listQueryKey = useMemo(
    () => trpc.cliSessionsV2.list.queryKey(listInput),
    [trpc, listInput]
  );

  const { data: listData, isLoading: isListLoading } = useQuery({
    ...trpc.cliSessionsV2.list.queryOptions(listInput),
    staleTime: 5000,
    enabled: !isSearchActive,
    // While the server has flagged any PR for an async review-decision fetch,
    // poll the list so the badge updates without a manual refresh. The poll
    // self-terminates once every row reports `reviewDecisionPending: false`.
    refetchInterval: query => {
      const hasPending = query.state.data?.cliSessions?.some(
        s => s.associatedPr?.reviewDecisionPending === true
      );
      return hasPending ? REVIEW_DECISION_POLL_INTERVAL_MS : false;
    },
  });

  // --- Search query ---
  const searchInput = useMemo(
    () => ({ search_string: searchQuery, createdOnPlatform, organizationId, gitUrl }),
    [searchQuery, createdOnPlatform, organizationId, gitUrl]
  );
  const searchQueryKey = useMemo(
    () => trpc.cliSessionsV2.search.queryKey(searchInput),
    [trpc, searchInput]
  );

  const { data: searchData, isLoading: isSearchLoading } = useQuery({
    ...trpc.cliSessionsV2.search.queryOptions(searchInput),
    staleTime: 5000,
    enabled: isSearchActive,
  });

  // Track last processed data key to avoid unnecessary atom updates
  const lastDataKeyRef = useRef<string | null>(null);

  // Populate Jotai atom when list query data actually changes (NOT for search).
  // Include `associatedPr` signals so a PR webhook or manual refresh updates
  // the atom even when the session row itself is unchanged.
  useEffect(() => {
    if (isSearchActive) return;
    if (listData?.cliSessions) {
      const dataKey = listData.cliSessions.map(sessionCacheKey).join('|');

      if (lastDataKeyRef.current !== dataKey) {
        lastDataKeyRef.current = dataKey;
        const sessions = listData.cliSessions.map(apiSessionToDbSession);
        setDbSessions(sessions);
      }
    }
  }, [listData?.cliSessions, setDbSessions, isSearchActive]);

  // Atom-derived sessions for list mode
  const listSessions = useMemo<StoredSession[]>(() => {
    return recentSessions.map(dbSessionToStoredSession);
  }, [recentSessions]);

  // Convert search results directly to StoredSession[] (no Jotai atoms)
  const searchSessions = useMemo<StoredSession[]>(() => {
    if (!searchData?.results) return [];
    return searchData.results.map(row => ({
      sessionId: row.session_id,
      repository: extractRepoDisplay(row.git_url),
      branch: row.git_branch,
      prompt: row.title || `Session ${row.session_id.substring(0, 8)}`,
      mode: 'code',
      model: '',
      status: row.cloud_agent_session_id ? ('active' as const) : ('completed' as const),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      messages: [],
      cloudAgentSessionId: row.cloud_agent_session_id,
      createdOnPlatform: row.created_on_platform,
      sessionStatus: row.status,
      sessionStatusUpdatedAt: row.status_updated_at,
      associatedPr: row.associatedPr ?? null,
    }));
  }, [searchData?.results]);

  type SearchData = typeof searchData;
  type SearchRow = NonNullable<SearchData>['results'][number];

  function dbSessionToSearchRow(session: DbSessionV2): SearchRow {
    return {
      session_id: session.session_id,
      title: session.title,
      cloud_agent_session_id: session.cloud_agent_session_id,
      created_at: session.created_at.toISOString(),
      updated_at: session.updated_at.toISOString(),
      version: session.version,
      created_on_platform: session.created_on_platform ?? 'unknown',
      organization_id: session.organization_id,
      git_url: session.git_url,
      git_branch: session.git_branch,
      parent_session_id: session.parent_session_id,
      status: session.status,
      status_updated_at: session.status_updated_at?.toISOString() ?? null,
      associatedPr: session.associatedPr ?? null,
    };
  }

  function sortSearchRows(rows: SearchRow[]): SearchRow[] {
    return [...rows].sort((a, b) => {
      const diff = new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
      if (diff !== 0) return diff;
      return b.session_id.localeCompare(a.session_id);
    });
  }

  useEffect(() => {
    if (!sharedConnection) return;

    const filters = { organizationId, createdOnPlatform, gitUrl } satisfies SidebarSessionFilters;
    const patchSearchCacheForRow = (session: DbSessionV2, filterResult: boolean | null) => {
      if (!isSearchActive) return;
      queryClient.setQueryData(searchQueryKey, (current: SearchData | undefined) => {
        if (!current) return current;
        const existing = current.results.find(row => row.session_id === session.session_id);
        const withoutSession = current.results.filter(row => row.session_id !== session.session_id);
        const mergedSession = existing
          ? {
              ...session,
              cloud_agent_session_id:
                existing.cloud_agent_session_id ?? session.cloud_agent_session_id,
              associatedPr: existing.associatedPr ?? session.associatedPr,
            }
          : session;
        const shouldKeep = filterResult === true && dbSessionMatchesSearch(session, searchQuery);
        if (!shouldKeep) {
          if (!existing) return current;
          return { ...current, results: withoutSession, total: Math.max(0, current.total - 1) };
        }
        if (!existing) {
          return {
            ...current,
            results: sortSearchRows([dbSessionToSearchRow(mergedSession), ...withoutSession]),
            total: current.total + 1,
          };
        }
        return {
          ...current,
          results: sortSearchRows([dbSessionToSearchRow(mergedSession), ...withoutSession]),
        };
      });
    };
    const patchSearchCacheForStatus = (
      payload: Extract<UserWebSessionEventData<'session.status.updated'>, { sessionId: string }>
    ) => {
      if (!isSearchActive) return;
      queryClient.setQueryData(searchQueryKey, (current: SearchData | undefined) => {
        if (!current) return current;
        const existing = current.results.find(row => row.session_id === payload.sessionId);
        if (!existing) return current;
        const withoutSession = current.results.filter(row => row.session_id !== payload.sessionId);
        const updated = {
          ...existing,
          status: payload.status,
          status_updated_at: payload.statusUpdatedAt,
          updated_at: payload.updatedAt ?? existing.updated_at,
        };
        return { ...current, results: sortSearchRows([updated, ...withoutSession]) };
      });
    };
    const removeFromSearchCache = (sessionId: string) => {
      if (!isSearchActive) return;
      queryClient.setQueryData(searchQueryKey, (current: SearchData | undefined) => {
        if (!current) return current;
        const withoutSession = current.results.filter(row => row.session_id !== sessionId);
        if (withoutSession.length === current.results.length) return current;
        return { ...current, results: withoutSession, total: Math.max(0, current.total - 1) };
      });
    };
    const patchRow = (
      payload: UserWebSessionEventData<'session.created'>,
      reconciliation: 'immediate' | 'delayed'
    ) => {
      if (payload.source !== 'v2') return;
      const next = eventRowToDbSession(payload.session);
      const filterResult = eventRowMatchesSidebarFilters(payload.session, filters);
      if (filterResult === true) {
        setDbSessions(prev => upsertSidebarDbSession(prev, next));
      } else if (filterResult === false) {
        setDbSessions(prev => removeSidebarDbSession(prev, next.session_id));
      }
      patchSearchCacheForRow(next, filterResult);
      if (reconciliation === 'immediate' || filterResult === null) {
        queryReconciler.reconcileNow();
      } else {
        queryReconciler.schedule();
      }
    };

    const unsubs = [
      sharedConnection.onSessionEvent('session.created', payload => patchRow(payload, 'immediate')),
      sharedConnection.onSessionEvent('session.updated', payload => patchRow(payload, 'immediate')),
      sharedConnection.onSessionEvent('session.status.updated', payload => {
        if (payload.source !== 'v2') return;
        if ('session' in payload) {
          patchRow(
            { source: 'v2', session: payload.session, changedAt: payload.changedAt },
            'delayed'
          );
          return;
        }
        setDbSessions(prev =>
          sortSidebarDbSessions(
            prev.map(s =>
              s.session_id === payload.sessionId
                ? {
                    ...s,
                    status: payload.status,
                    status_updated_at: payload.statusUpdatedAt
                      ? new Date(payload.statusUpdatedAt)
                      : null,
                    updated_at: payload.updatedAt ? new Date(payload.updatedAt) : s.updated_at,
                  }
                : s
            )
          )
        );
        patchSearchCacheForStatus(payload);
        queryReconciler.schedule();
      }),
      sharedConnection.onSessionEvent('session.deleted', payload => {
        if (payload.source !== 'v2') return;
        setDbSessions(prev => removeSidebarDbSession(prev, payload.sessionId));
        removeFromSearchCache(payload.sessionId);
        queryReconciler.reconcileNow();
      }),
      // After a reconnect we may have missed events while the socket was down,
      // and (unlike useActiveSessions) no authoritative snapshot is replayed for
      // the sidebar, so reconcile immediately.
      sharedConnection.onReconnect(queryReconciler.reconcileNow),
    ];
    return () => unsubs.forEach(unsub => unsub());
  }, [
    sharedConnection,
    organizationId,
    createdOnPlatform,
    gitUrl,
    isSearchActive,
    searchQuery,
    searchQueryKey,
    setDbSessions,
    queryClient,
    queryReconciler,
  ]);

  const sessions = isSearchActive ? searchSessions : listSessions;
  const isLoading = isSearchActive ? isSearchLoading : isListLoading;

  // Refetch sessions by invalidating the query cache
  const refetchSessions = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: listQueryKey });
  }, [queryClient, listQueryKey]);

  // Optimistically update a session's title in the Jotai atom so the UI
  // reflects the change immediately (before the server refetch completes).
  const renameSessionLocally = useCallback(
    (sessionId: string, newTitle: string) => {
      setDbSessions(prev =>
        prev.map(s => (s.session_id === sessionId ? { ...s, title: newTitle } : s))
      );
    },
    [setDbSessions]
  );

  return { sessions, isLoading, refetchSessions, renameSessionLocally };
}
