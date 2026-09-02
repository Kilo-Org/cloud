/**
 * Hook for managing sidebar session list
 *
 * Fetches v2 sessions and maintains them in Jotai atoms
 * for reactive updates across the UI. Supports search and platform filtering.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import type { inferRouterOutputs } from '@trpc/server';
import type { RootRouter } from '@/routers/root-router';
import {
  cloudAgentWorktreeIdSchema,
  type CloudAgentWorktreeId,
} from '@kilocode/session-ingest-contracts';
import { useUserWebConnection } from '../CloudAgentProvider';
import type {
  CloudStatus,
  MessageDeliveryState,
  ResolvedSession,
  SessionActivity,
  UserWebSessionEventData,
} from '@kilocode/cloud-agent-sdk';
import {
  apiSessionToDbSession,
  dbSessionsAtom,
  recentSessionsAtom,
  type DbSession,
  type DbSessionV2,
} from '../store/db-session-atoms';
import { differenceInCalendarDays, format, isSameDay, startOfDay, subDays } from 'date-fns';
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
    worktreeId: dbSession.cloud_agent_worktree_id ?? null,
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

type ForegroundSessionStatusInput = {
  currentSessionId: string | null;
  organizationId: string | null;
  activeSessionType: ResolvedSession['type'] | null;
  fetchedSessionData: { kiloSessionId: string; organizationId: string | null } | null;
  activity: SessionActivity;
  isStreaming: boolean;
  activeQuestion: { requestId: string } | null;
  activePermission: { requestId: string } | null;
  cloudStatus: CloudStatus | null;
  pendingMessages: ReadonlyMap<string, MessageDeliveryState>;
};

type ForegroundSessionStatus = 'permission' | 'question' | 'retry' | 'busy' | 'idle';

export function deriveForegroundSessionStatus({
  currentSessionId,
  organizationId,
  activeSessionType,
  fetchedSessionData,
  activity,
  isStreaming,
  activeQuestion,
  activePermission,
  cloudStatus,
  pendingMessages,
}: ForegroundSessionStatusInput): ForegroundSessionStatus | null {
  if (
    !currentSessionId ||
    activeSessionType !== 'cloud-agent' ||
    !fetchedSessionData ||
    fetchedSessionData.kiloSessionId !== currentSessionId ||
    fetchedSessionData.organizationId !== organizationId
  ) {
    return null;
  }

  if (activePermission) return 'permission';
  if (activeQuestion) return 'question';
  if (activity.type === 'retrying') return 'retry';

  if (
    activity.type === 'busy' ||
    isStreaming ||
    cloudStatus?.type === 'preparing' ||
    cloudStatus?.type === 'finalizing'
  ) {
    return 'busy';
  }

  for (const message of pendingMessages.values()) {
    if (message.status === 'queued') return 'busy';
  }

  return 'idle';
}

export function mergeWorktreeChatSessions(
  worktreeId: string,
  authoritativeSessions: StoredSession[],
  cachedSessions: StoredSession[]
): StoredSession[] {
  const sessionsById = new Map<string, StoredSession>();

  for (const session of authoritativeSessions) {
    if (session.worktreeId === worktreeId) {
      sessionsById.set(session.sessionId, session);
    }
  }

  for (const cachedSession of cachedSessions) {
    if (cachedSession.worktreeId !== worktreeId) continue;

    const authoritativeSession = sessionsById.get(cachedSession.sessionId);
    if (!authoritativeSession) {
      sessionsById.set(cachedSession.sessionId, cachedSession);
      continue;
    }

    const cachedSessionIsCurrent =
      new Date(cachedSession.updatedAt).getTime() >=
      new Date(authoritativeSession.updatedAt).getTime();
    if (!cachedSessionIsCurrent) continue;

    const cloudAgentSessionId =
      cachedSession.cloudAgentSessionId ?? authoritativeSession.cloudAgentSessionId;
    sessionsById.set(cachedSession.sessionId, {
      ...authoritativeSession,
      ...cachedSession,
      cloudAgentSessionId,
      status:
        cloudAgentSessionId && !cachedSession.cloudAgentSessionId
          ? authoritativeSession.status
          : cachedSession.status,
    });
  }

  return [...sessionsById.values()].sort((a, b) => {
    const createdAtDifference = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    return createdAtDifference === 0 ? a.sessionId.localeCompare(b.sessionId) : createdAtDifference;
  });
}

type WorktreeDetailsQueryData = inferRouterOutputs<RootRouter>['cliSessionsV2']['worktreeDetails'];

type SidebarSessionActivity = Pick<
  StoredSession,
  'sessionId' | 'sessionStatus' | 'sessionStatusUpdatedAt'
>;

export type SidebarForegroundSessionStatus = {
  sessionId: string;
  status: string;
};

export type SidebarWorktreeDetails = {
  name: string | null;
  defaultTitle: string | null;
  prSession: StoredSession | null;
  sessions: SidebarSessionActivity[];
};

export type SidebarWorktreeGroup = {
  type: 'worktree';
  worktreeId: string;
  sessions: StoredSession[];
  latestSession: StoredSession;
  details?: SidebarWorktreeDetails;
};

export type SidebarSessionItem = { type: 'session'; session: StoredSession } | SidebarWorktreeGroup;

export type SidebarSessionDateGroup = {
  label: string;
  items: SidebarSessionItem[];
};

export type SidebarWorktreeActivity = {
  status: string | null;
  statusUpdatedAt: string | null;
  isLive: boolean;
};

function getSidebarSessionItemUpdatedAt(item: SidebarSessionItem): string {
  return item.type === 'worktree' ? item.latestSession.updatedAt : item.session.updatedAt;
}

function compareStoredSessionsByUpdatedAtDesc(a: StoredSession, b: StoredSession): number {
  const difference = new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  if (difference !== 0) return difference;
  return b.sessionId.localeCompare(a.sessionId);
}

export function groupSidebarSessions(
  sessions: StoredSession[],
  worktreeDetails: Record<string, SidebarWorktreeDetails> = {}
): SidebarSessionItem[] {
  const worktreeGroups = new Map<string, StoredSession[]>();
  const items: SidebarSessionItem[] = [];

  for (const session of sessions) {
    if (!session.worktreeId) {
      items.push({ type: 'session', session });
      continue;
    }

    const groupedSessions = worktreeGroups.get(session.worktreeId);
    if (groupedSessions) {
      groupedSessions.push(session);
      continue;
    }

    const nextGroupedSessions = [session];
    worktreeGroups.set(session.worktreeId, nextGroupedSessions);
    items.push({
      type: 'worktree',
      worktreeId: session.worktreeId,
      sessions: nextGroupedSessions,
      latestSession: session,
      details: worktreeDetails[session.worktreeId],
    });
  }

  for (const item of items) {
    if (item.type !== 'worktree') continue;
    item.sessions.sort(compareStoredSessionsByUpdatedAtDesc);
    item.latestSession = item.sessions[0] ?? item.latestSession;
  }

  return items.sort(
    (a, b) =>
      new Date(getSidebarSessionItemUpdatedAt(b)).getTime() -
      new Date(getSidebarSessionItemUpdatedAt(a)).getTime()
  );
}

export function groupSidebarSessionsByDate(
  sessions: StoredSession[],
  now = new Date(),
  worktreeDetails: Record<string, SidebarWorktreeDetails> = {}
): SidebarSessionDateGroup[] {
  const today: SidebarSessionItem[] = [];
  const yesterday: SidebarSessionItem[] = [];
  const namedDayBuckets = new Map<string, { daysAgo: number; items: SidebarSessionItem[] }>();
  const older: SidebarSessionItem[] = [];
  const todayStart = startOfDay(now);

  for (const item of groupSidebarSessions(sessions, worktreeDetails)) {
    const date = new Date(getSidebarSessionItemUpdatedAt(item));
    if (isSameDay(date, now)) {
      today.push(item);
    } else if (isSameDay(date, subDays(now, 1))) {
      yesterday.push(item);
    } else {
      const daysAgo = differenceInCalendarDays(todayStart, startOfDay(date));
      if (daysAgo <= 7) {
        const dayName = format(date, 'EEEE');
        const bucket = namedDayBuckets.get(dayName);
        if (bucket) bucket.items.push(item);
        else namedDayBuckets.set(dayName, { daysAgo, items: [item] });
      } else {
        older.push(item);
      }
    }
  }

  const groups: SidebarSessionDateGroup[] = [];
  if (today.length > 0) groups.push({ label: 'Today', items: today });
  if (yesterday.length > 0) groups.push({ label: 'Yesterday', items: yesterday });

  const sortedNamedDays = [...namedDayBuckets.entries()].sort(
    (a, b) => a[1].daysAgo - b[1].daysAgo
  );
  for (const [index, [dayName, bucket]] of sortedNamedDays.entries()) {
    if (index < 3) groups.push({ label: dayName, items: bucket.items });
    else older.push(...bucket.items);
  }

  if (older.length > 0) {
    older.sort(
      (a, b) =>
        new Date(getSidebarSessionItemUpdatedAt(b)).getTime() -
        new Date(getSidebarSessionItemUpdatedAt(a)).getTime()
    );
    groups.push({ label: 'Older', items: older });
  }

  return groups;
}

export function getSidebarWorktreePrSession(group: SidebarWorktreeGroup): StoredSession | null {
  if (group.details) return group.details.prSession;

  return (
    group.sessions.find(session => session.associatedPr != null) ??
    group.sessions.find(session => session.associatedPr === undefined && session.branch) ??
    null
  );
}

export function getSidebarWorktreeLabel(group: SidebarWorktreeGroup): string {
  const name = group.details?.name || group.details?.defaultTitle;
  if (name) return name;

  const repository =
    group.latestSession.repository ||
    group.sessions.find(session => session.repository)?.repository;
  const branch =
    group.latestSession.branch ?? group.sessions.find(session => session.branch)?.branch ?? null;
  return branch ? `${repository || 'Repository'} · ${branch}` : repository || 'Repository';
}

export function getSidebarWorktreeActivity(
  sessions: readonly SidebarSessionActivity[],
  activeSessionStatuses: ReadonlyMap<string, string>,
  authoritativeSessions: readonly SidebarSessionActivity[] = sessions,
  foregroundSession?: SidebarForegroundSessionStatus | null
): SidebarWorktreeActivity {
  const sessionsById = new Map(authoritativeSessions.map(session => [session.sessionId, session]));
  for (const session of sessions) {
    const existing = sessionsById.get(session.sessionId);
    if (
      !existing ||
      new Date(session.sessionStatusUpdatedAt ?? 0).getTime() >=
        new Date(existing.sessionStatusUpdatedAt ?? 0).getTime()
    ) {
      sessionsById.set(session.sessionId, session);
    }
  }

  let selectedStatus: string | null = null;
  let selectedStatusUpdatedAt: string | null = null;
  let selectedPriority = 0;
  let isLive = false;

  for (const session of sessionsById.values()) {
    const activeStatus = activeSessionStatuses.get(session.sessionId);
    if (activeStatus !== undefined) isLive = true;
    const foregroundStatus =
      foregroundSession?.sessionId === session.sessionId ? foregroundSession.status : undefined;
    const statuses =
      foregroundStatus !== undefined
        ? [foregroundStatus]
        : activeStatus === 'idle'
          ? [activeStatus]
          : [session.sessionStatus ?? null, activeStatus ?? null];
    for (const status of statuses) {
      const priority =
        status === 'question' || status === 'permission'
          ? 2
          : status === 'busy' || status === 'retry'
            ? 1
            : 0;
      if (priority <= selectedPriority) continue;
      selectedPriority = priority;
      selectedStatus = status;
      selectedStatusUpdatedAt =
        foregroundStatus === undefined && status === session.sessionStatus
          ? (session.sessionStatusUpdatedAt ?? null)
          : null;
    }
  }

  return { status: selectedStatus, statusUpdatedAt: selectedStatusUpdatedAt, isLive };
}

export function patchSidebarWorktreeSessionStatus(
  data: WorktreeDetailsQueryData,
  update: SidebarSessionActivity
): WorktreeDetailsQueryData {
  const worktrees = { ...data.worktrees };
  let changed = false;
  for (const [worktreeId, worktree] of Object.entries(worktrees)) {
    const existing = worktree.sessions.find(session => session.sessionId === update.sessionId);
    if (
      !existing ||
      new Date(update.sessionStatusUpdatedAt ?? 0).getTime() <
        new Date(existing.sessionStatusUpdatedAt ?? 0).getTime() ||
      (existing.sessionStatus === update.sessionStatus &&
        existing.sessionStatusUpdatedAt === update.sessionStatusUpdatedAt)
    ) {
      continue;
    }
    changed = true;
    worktrees[worktreeId] = {
      ...worktree,
      sessions: worktree.sessions.map(session =>
        session.sessionId === update.sessionId
          ? {
              ...session,
              sessionStatus: update.sessionStatus ?? null,
              sessionStatusUpdatedAt: update.sessionStatusUpdatedAt ?? null,
            }
          : session
      ),
    };
  }
  return changed ? { ...data, worktrees } : data;
}

const SIDEBAR_LIST_LIMIT = 200;

/**
 * Stable string key for a single session list entry.
 * Used to detect changes that should trigger a Jotai atom update, including
 * PR state changes that arrive via webhook without modifying the session row.
 */
export function sessionCacheKey(s: {
  session_id: string;
  updated_at: string;
  status: string | null;
  status_updated_at: string | null;
  cloud_agent_worktree_id?: string | null;
  associatedPr?: {
    state: string;
    lastSyncedAt: string;
    reviewDecision: string | null;
    reviewDecisionPending: boolean;
  } | null;
}): string {
  return `${s.session_id}-${s.updated_at}-${s.status ?? ''}-${s.status_updated_at ?? ''}-${s.cloud_agent_worktree_id ?? ''}-${s.associatedPr?.state ?? ''}-${s.associatedPr?.lastSyncedAt ?? ''}-${s.associatedPr?.reviewDecision ?? ''}-${s.associatedPr?.reviewDecisionPending ?? false}`;
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

export function eventRowToDbSession(
  row: UserWebSessionEventData<'session.created'>['session']
): DbSessionV2 {
  return {
    session_id: row.sessionId,
    title: row.title,
    cloud_agent_session_id: null,
    cloud_agent_worktree_id: row.worktreeId,
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
    cloud_agent_worktree_id:
      next.cloud_agent_worktree_id ?? existing.cloud_agent_worktree_id ?? null,
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
  cachedSessions: StoredSession[];
  worktreeDetails: Record<string, SidebarWorktreeDetails>;
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
    void queryClient.invalidateQueries(trpc.cliSessionsV2.worktreeDetails.pathFilter());
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
  const cachedSessions = useMemo<StoredSession[]>(() => {
    return recentSessions
      .filter(session => organizationId === undefined || session.organization_id === organizationId)
      .map(dbSessionToStoredSession);
  }, [organizationId, recentSessions]);

  // Convert search results directly to StoredSession[] (no Jotai atoms)
  const searchSessions = useMemo<StoredSession[]>(() => {
    if (!searchData?.results) return [];
    return searchData.results.map(row => ({
      sessionId: row.session_id,
      repository: extractRepoDisplay(row.git_url),
      branch: row.git_branch,
      worktreeId: row.cloud_agent_worktree_id ?? null,
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
      cloud_agent_worktree_id: session.cloud_agent_worktree_id ?? null,
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
      total_cost_microdollars: session.total_cost_microdollars ?? null,
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
    const patchWorktreeStatus = (update: SidebarSessionActivity) => {
      const queries = queryClient.getQueriesData<WorktreeDetailsQueryData>(
        trpc.cliSessionsV2.worktreeDetails.pathFilter()
      );
      for (const [queryKey, data] of queries) {
        if (
          !data ||
          !Object.values(data.worktrees).some(worktree =>
            worktree.sessions.some(session => session.sessionId === update.sessionId)
          )
        ) {
          continue;
        }
        void queryClient
          .cancelQueries({ queryKey, exact: true }, { revert: false, silent: true })
          .then(() => {
            queryClient.setQueryData<WorktreeDetailsQueryData>(queryKey, current =>
              current ? patchSidebarWorktreeSessionStatus(current, update) : current
            );
          });
      }
    };
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
              cloud_agent_worktree_id:
                session.cloud_agent_worktree_id ?? existing.cloud_agent_worktree_id ?? null,
              associatedPr: existing.associatedPr ?? session.associatedPr,
            }
          : session;
        const shouldKeep =
          filterResult === true &&
          (existing !== undefined || dbSessionMatchesSearch(session, searchQuery));
        if (!shouldKeep) {
          if (!existing) return current;
          return { ...current, results: withoutSession };
        }
        if (!existing) {
          return {
            ...current,
            results: sortSearchRows([dbSessionToSearchRow(mergedSession), ...withoutSession]),
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
        return { ...current, results: withoutSession };
      });
    };
    const patchRow = (
      payload: UserWebSessionEventData<'session.created'>,
      reconciliation: 'immediate' | 'delayed'
    ) => {
      if (payload.source !== 'v2') return;
      patchWorktreeStatus({
        sessionId: payload.session.sessionId,
        sessionStatus: payload.session.status,
        sessionStatusUpdatedAt: payload.session.statusUpdatedAt,
      });
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
        patchWorktreeStatus({
          sessionId: payload.sessionId,
          sessionStatus: payload.status,
          sessionStatusUpdatedAt: payload.statusUpdatedAt,
        });
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
    trpc,
  ]);

  const sessions = isSearchActive ? searchSessions : cachedSessions;
  const isLoading = isSearchActive ? isSearchLoading : isListLoading;
  const worktreeIdBatches = useMemo(() => {
    const ids = [
      ...new Set(
        sessions.flatMap(session => {
          const parsed = cloudAgentWorktreeIdSchema.safeParse(session.worktreeId);
          return parsed.success ? [parsed.data] : [];
        })
      ),
    ].sort();
    const batches: CloudAgentWorktreeId[][] = [];
    for (let index = 0; index < ids.length; index += 200) {
      batches.push(ids.slice(index, index + 200));
    }
    return batches;
  }, [sessions]);
  const worktreeDetails = useQueries({
    queries: worktreeIdBatches.map(worktreeIds =>
      trpc.cliSessionsV2.worktreeDetails.queryOptions(
        { worktreeIds, organizationId: organizationId ?? null },
        {
          staleTime: 5000,
          refetchInterval: query =>
            Object.values(query.state.data?.worktrees ?? {}).some(
              details => details.prSession?.associatedPr?.reviewDecisionPending === true
            )
              ? REVIEW_DECISION_POLL_INTERVAL_MS
              : false,
        }
      )
    ),
    combine: queries => {
      const details: Record<string, SidebarWorktreeDetails> = {};
      for (const query of queries) {
        for (const [worktreeId, worktree] of Object.entries(query.data?.worktrees ?? {})) {
          details[worktreeId] = {
            name: worktree.name,
            defaultTitle: worktree.defaultTitle,
            sessions: worktree.sessions,
            prSession: worktree.prSession
              ? dbSessionToStoredSession(apiSessionToDbSession(worktree.prSession))
              : null,
          };
        }
      }
      return details;
    },
  });

  // Refetch sessions by invalidating the query cache
  const refetchSessions = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: listQueryKey });
    void queryClient.invalidateQueries(trpc.cliSessionsV2.worktreeDetails.pathFilter());
  }, [queryClient, listQueryKey, trpc]);

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

  return {
    sessions,
    cachedSessions,
    worktreeDetails,
    isLoading,
    refetchSessions,
    renameSessionLocally,
  };
}
