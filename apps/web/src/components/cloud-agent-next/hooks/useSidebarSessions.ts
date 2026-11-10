/**
 * Hook for managing sidebar session list
 *
 * Fetches v2 sessions and maintains them in Jotai atoms
 * for reactive updates across the UI. Supports search and platform filtering.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import {
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { useTRPC } from '@/lib/trpc/utils';
import type { inferRouterOutputs } from '@trpc/server';
import type { RootRouter } from '@/routers/root-router';
import { useUserWebConnection } from '../CloudAgentProvider';
import type {
  AgentStatus,
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
import type { AssociatedPr } from '../utils/github-pr-link';
import { getChatDisplayTitle, keepRealSessionTitle } from '../utils/session-title';
import { getCachedWorktreeDetails, getLoadingWorktreeIds } from './worktree-details-placeholder';
import {
  sidebarListInput,
  sidebarUpdatedSince,
  sidebarWorkspaceListInput,
  worktreeDetailsBatches,
} from './sidebar-queries';
import { buildWorkspaceStacks, type WorkspaceStackNode } from '../workspace-stacks';
import { repositoryKey } from '../worktree-meta';
import type { WorkspaceOrder } from '../sidebar-ordering';

/**
 * Extract "owner/repo" from a git URL for display.
 * Branch is returned separately via StoredSession.branch.
 */
function extractRepoDisplay(gitUrl: string | null | undefined): string {
  return extractRepoFromGitUrl(gitUrl) ?? '';
}

function readLastActivityAt(value: object): string | null {
  if (!('last_activity_at' in value)) return null;
  const candidate = value.last_activity_at;
  return typeof candidate === 'string' ? candidate : null;
}

export function getStoredSessionActivityTime(
  session: Pick<StoredSession, 'lastActivityAt' | 'createdAt'>
): number {
  return new Date(session.lastActivityAt ?? session.createdAt).getTime();
}

export function getDbSessionActivityTime(
  session: Pick<DbSession | DbSessionV2, 'last_activity_at' | 'created_at'>
): number {
  return (session.last_activity_at ?? session.created_at).getTime();
}

export function dbSessionToStoredSession(session: DbSession | DbSessionV2): StoredSession {
  const title = getChatDisplayTitle(session.title);

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
    lastActivityAt: dbSession.last_activity_at?.toISOString() ?? null,
    messages: [],
    cloudAgentSessionId: session.cloud_agent_session_id,
    createdOnPlatform: dbSession.created_on_platform ?? null,
    sessionStatus: session.status,
    sessionStatusUpdatedAt: session.status_updated_at?.toISOString() ?? null,
    latestRunFailureKind: session.latest_run_failure_kind ?? null,
    latestRunTerminalAt: session.latest_run_terminal_at ?? null,
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
  agentStatus?: Pick<AgentStatus, 'type'>;
};

type ForegroundSessionStatus = 'permission' | 'question' | 'retry' | 'busy' | 'idle' | 'failed';

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
  agentStatus,
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

  if (agentStatus?.type === 'error' || cloudStatus?.type === 'error') return 'failed';

  return 'idle';
}

export function getSidebarSessionStatus(
  session: Pick<
    StoredSession,
    'sessionStatus' | 'sessionStatusUpdatedAt' | 'latestRunFailureKind' | 'latestRunTerminalAt'
  >
): string | null {
  const status = session.sessionStatus;
  if (
    session.latestRunFailureKind &&
    session.latestRunTerminalAt &&
    new Date(session.latestRunTerminalAt).getTime() >=
      new Date(session.sessionStatusUpdatedAt ?? 0).getTime()
  )
    return session.latestRunFailureKind;
  return !status || status === 'idle' ? (session.latestRunFailureKind ?? status ?? null) : status;
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
    // A chat this client created gives way to the server's row as soon as it exists.
    if (cachedSession.localSync) continue;

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

export function mergeSidebarFolderSessions(
  recentSessions: StoredSession[],
  folderSessions: StoredSession[]
): StoredSession[] {
  const sessions = new Map(folderSessions.map(session => [session.sessionId, session]));
  for (const session of recentSessions) {
    const existing = sessions.get(session.sessionId);
    if (
      !existing ||
      getStoredSessionActivityTime(session) >= getStoredSessionActivityTime(existing)
    ) {
      sessions.set(session.sessionId, session);
    }
  }
  return [...sessions.values()].sort(compareStoredSessionsByActivityDesc);
}

type WorktreeDetailsQueryData = inferRouterOutputs<RootRouter>['cliSessionsV2']['worktreeDetails'];
type WorkspaceListQueryData = inferRouterOutputs<RootRouter>['cliSessionsV2']['listWorkspaces'];

/**
 * The workspace list may also carry the representative chat and repository of
 * a worktree whose chats have aged out of the five-day list.
 */
export type SidebarWorkspaceListRow = WorkspaceListQueryData['workspaces'][number] & {
  latestSessionId?: string | null;
  rootSessionId?: string | null;
  gitUrl?: string | null;
};

type SidebarSessionActivity = Pick<
  StoredSession,
  | 'sessionId'
  | 'sessionStatus'
  | 'sessionStatusUpdatedAt'
  | 'updatedAt'
  | 'latestRunFailureKind'
  | 'latestRunTerminalAt'
> &
  Partial<Pick<StoredSession, 'createdAt' | 'lastActivityAt'>>;

export type SidebarForegroundSessionStatus = {
  sessionId: string;
  status: string;
};

export type SidebarWorktreeDetails = {
  name: string | null;
  defaultTitle: string | null;
  prSession: StoredSession | null;
  sessions: SidebarSessionActivity[];
  branch?: string | null;
  parentWorktreeId?: string | null;
  baseBranch?: string | null;
  baseSha?: string | null;
  folderId?: string | null;
  sidebarPosition?: string | null;
  createdAt?: string | null;
  gitUrl?: string | null;
};

export type SidebarWorktreeGroup = {
  type: 'worktree';
  worktreeId: string;
  sessions: StoredSession[];
  latestSession: StoredSession;
  details?: SidebarWorktreeDetails;
  stackLayers?: SidebarWorktreeGroup[];
  stackDepth?: number;
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

export type SidebarSortPins = ReadonlyMap<string, number>;

/**
 * Sort-time refresh cadence for running sessions. Their `updated_at` changes on
 * every turn, which would otherwise reshuffle the sidebar continuously, so a
 * running session only advances once per interval.
 */
export const SIDEBAR_RUNNING_BUMP_INTERVAL_MS = 60_000;

export function getRunningSessionSortTime(session: StoredSession, isRunning: boolean): number {
  const activityAt = getStoredSessionActivityTime(session);
  if (!isRunning) return activityAt;
  const createdAt = new Date(session.createdAt).getTime();
  return (
    createdAt +
    Math.floor((activityAt - createdAt) / SIDEBAR_RUNNING_BUMP_INTERVAL_MS) *
      SIDEBAR_RUNNING_BUMP_INTERVAL_MS
  );
}

function getSidebarSessionItemSortTime(
  item: SidebarSessionItem,
  sortPins: SidebarSortPins
): number {
  if (item.type === 'session') {
    return sortPins.get(item.session.sessionId) ?? getStoredSessionActivityTime(item.session);
  }
  let latest = Number.NEGATIVE_INFINITY;
  for (const session of item.sessions) {
    const time = sortPins.get(session.sessionId) ?? getStoredSessionActivityTime(session);
    if (time > latest) latest = time;
  }
  return Number.isFinite(latest) ? latest : getStoredSessionActivityTime(item.latestSession);
}

function compareStoredSessionsByActivityDesc(
  a: Pick<StoredSession, 'sessionId' | 'lastActivityAt' | 'updatedAt'> &
    Partial<Pick<StoredSession, 'createdAt'>>,
  b: Pick<StoredSession, 'sessionId' | 'lastActivityAt' | 'updatedAt'> &
    Partial<Pick<StoredSession, 'createdAt'>>
): number {
  const activityTime = (
    session: Pick<StoredSession, 'lastActivityAt'> & Partial<Pick<StoredSession, 'createdAt'>>
  ) => new Date(session.lastActivityAt ?? session.createdAt ?? 0).getTime();
  const difference = activityTime(b) - activityTime(a);
  if (difference !== 0) return difference;
  return b.sessionId.localeCompare(a.sessionId);
}

export function groupSidebarSessions(
  sessions: StoredSession[],
  worktreeDetails: Record<string, SidebarWorktreeDetails> = {},
  sortPins: SidebarSortPins = new Map()
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
    item.sessions.sort(compareStoredSessionsByActivityDesc);
    item.latestSession = item.sessions[0] ?? item.latestSession;
  }

  const stackedItems = attachWorkspaceStackLayers(items);
  return stackedItems.sort(
    (a, b) =>
      getSidebarSessionItemSortTime(b, sortPins) - getSidebarSessionItemSortTime(a, sortPins)
  );
}

function getWorktreeStackNode(group: SidebarWorktreeGroup): WorkspaceStackNode {
  const details = group.details;
  const pr = details?.prSession?.associatedPr;
  return {
    worktreeId: group.worktreeId,
    parentWorktreeId: details?.parentWorktreeId ?? null,
    branch: details?.branch ?? group.latestSession.branch ?? null,
    baseBranch: details?.baseBranch ?? null,
    repositoryKey: repositoryKey({
      gitUrl: details?.gitUrl,
      repository: group.latestSession.repository,
      platform: pr?.platform,
    }),
    pr: pr
      ? {
          number: pr.number ?? null,
          url: pr.url ?? null,
          state: pr.state ?? null,
          baseRef: pr.baseRef ?? null,
          stackNumber: pr.stackNumber ?? null,
          stackPosition: pr.stackPosition ?? null,
          stackSize: pr.stackSize ?? null,
          headSha: pr.headSha ?? null,
        }
      : null,
  };
}

export function buildSidebarWorkspaceStackNodes(
  sessions: readonly StoredSession[],
  worktreeDetails: Record<string, SidebarWorktreeDetails> = {}
): WorkspaceStackNode[] {
  const groups = new Map<string, SidebarWorktreeGroup>();
  for (const session of sessions) {
    if (!session.worktreeId || groups.has(session.worktreeId)) continue;
    groups.set(session.worktreeId, {
      type: 'worktree',
      worktreeId: session.worktreeId,
      sessions: [session],
      latestSession: session,
      details: worktreeDetails[session.worktreeId],
    });
  }
  return [...groups.values()].map(getWorktreeStackNode);
}

export function attachWorkspaceStackLayers(items: SidebarSessionItem[]): SidebarSessionItem[] {
  const worktreeItems = items.filter(
    (item): item is SidebarWorktreeGroup => item.type === 'worktree'
  );
  if (worktreeItems.length < 2) return items;

  const itemsById = new Map(worktreeItems.map(item => [item.worktreeId, item]));
  const stacks = buildWorkspaceStacks(worktreeItems.map(getWorktreeStackNode));
  const nestedIds = new Set<string>();

  for (const stack of stacks) {
    if (stack.entries.length < 2) continue;
    const [rootEntry, ...layerEntries] = stack.entries;
    const root = rootEntry ? itemsById.get(rootEntry.node.worktreeId) : undefined;
    if (!root) continue;
    root.stackDepth = 0;
    root.stackLayers = layerEntries.flatMap(entry => {
      const layer = itemsById.get(entry.node.worktreeId);
      if (!layer) return [];
      nestedIds.add(layer.worktreeId);
      layer.stackDepth = entry.depth;
      return [layer];
    });
  }

  return nestedIds.size === 0
    ? items
    : items.filter(item => item.type !== 'worktree' || !nestedIds.has(item.worktreeId));
}

export function groupSidebarSessionsByDate(
  sessions: StoredSession[],
  now = new Date(),
  worktreeDetails: Record<string, SidebarWorktreeDetails> = {},
  sortPins: SidebarSortPins = new Map()
): SidebarSessionDateGroup[] {
  const today: SidebarSessionItem[] = [];
  const yesterday: SidebarSessionItem[] = [];
  const namedDayBuckets = new Map<string, { daysAgo: number; items: SidebarSessionItem[] }>();
  const older: SidebarSessionItem[] = [];
  const todayStart = startOfDay(now);

  for (const item of groupSidebarSessions(sessions, worktreeDetails, sortPins)) {
    const date = new Date(getSidebarSessionItemSortTime(item, sortPins));
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
        getSidebarSessionItemSortTime(b, sortPins) - getSidebarSessionItemSortTime(a, sortPins)
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
  // Known untitled: named like its chats until Kilo titles it. Unknown details keep the repository.
  if (group.details) return getChatDisplayTitle(null);

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
  foregroundSession?: SidebarForegroundSessionStatus | null,
  now = Date.now()
): SidebarWorktreeActivity {
  const sessionsById = new Map(authoritativeSessions.map(session => [session.sessionId, session]));
  for (const session of sessions) {
    const existing = sessionsById.get(session.sessionId);
    if (
      !existing ||
      new Date(session.sessionStatusUpdatedAt ?? 0).getTime() >
        new Date(existing.sessionStatusUpdatedAt ?? 0).getTime() ||
      (session.sessionStatusUpdatedAt === existing.sessionStatusUpdatedAt &&
        new Date(session.updatedAt).getTime() >= new Date(existing.updatedAt).getTime())
    ) {
      sessionsById.set(
        session.sessionId,
        existing
          ? {
              ...session,
              latestRunFailureKind: existing.latestRunFailureKind,
              latestRunTerminalAt: existing.latestRunTerminalAt,
            }
          : session
      );
    }
  }

  const latestSession = [...sessionsById.values()].reduce<SidebarSessionActivity | undefined>(
    (latest, session) =>
      !latest || compareStoredSessionsByActivityDesc(session, latest) < 0 ? session : latest,
    undefined
  );
  let selectedStatus: string | null = null;
  let selectedStatusUpdatedAt: string | null = null;
  let selectedPriority = 0;
  let isLive = false;

  for (const session of sessionsById.values()) {
    const activeStatus = activeSessionStatuses.get(session.sessionId);
    if (activeStatus !== undefined) isLive = true;
    const foregroundStatus =
      foregroundSession?.sessionId === session.sessionId ? foregroundSession.status : undefined;
    const storedStatus =
      (session.sessionStatus === 'busy' || session.sessionStatus === 'retry') &&
      now - new Date(session.updatedAt).getTime() >= 20 * 60_000
        ? null
        : (session.sessionStatus ?? null);
    const statuses =
      foregroundStatus !== undefined
        ? [
            foregroundStatus === 'idle'
              ? getSidebarSessionStatus({ ...session, sessionStatus: foregroundStatus })
              : foregroundStatus,
          ]
        : activeStatus === 'idle'
          ? [getSidebarSessionStatus({ ...session, sessionStatus: activeStatus })]
          : [
              getSidebarSessionStatus({ ...session, sessionStatus: storedStatus }),
              session.latestRunFailureKind &&
              session.latestRunTerminalAt &&
              getSidebarSessionStatus(session) === session.latestRunFailureKind
                ? null
                : (activeStatus ?? null),
            ];
    for (const status of statuses) {
      if (
        (status === 'failed' || status === 'system_interrupted') &&
        session.sessionId !== latestSession?.sessionId
      ) {
        continue;
      }
      const priority =
        status === 'question' || status === 'permission'
          ? 3
          : status === 'busy' || status === 'retry'
            ? 2
            : status === 'failed' || status === 'system_interrupted'
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
  update: Omit<SidebarSessionActivity, 'updatedAt'> & { updatedAt?: string }
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
        existing.sessionStatusUpdatedAt === update.sessionStatusUpdatedAt &&
        (update.updatedAt === undefined || existing.updatedAt === update.updatedAt))
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
              ...getSidebarRunOutcomeAfterStatus(
                session,
                update.sessionStatus,
                update.sessionStatusUpdatedAt
              ),
              sessionStatus: update.sessionStatus ?? null,
              sessionStatusUpdatedAt: update.sessionStatusUpdatedAt ?? null,
              updatedAt: update.updatedAt ?? session.updatedAt,
            }
          : session
      ),
    };
  }
  return changed ? { ...data, worktrees } : data;
}

/**
 * Stable string key for a single session list entry.
 * Used to detect changes that should trigger a Jotai atom update, including
 * PR state changes that arrive via webhook without modifying the session row.
 */
export function sessionCacheKey(s: {
  session_id: string;
  updated_at: string;
  last_activity_at?: string | null;
  status: string | null;
  status_updated_at: string | null;
  cloud_agent_worktree_id?: string | null;
  latest_run_status?: string | null;
  latest_run_failure_kind?: string | null;
  latest_run_terminal_at?: string | null;
  associatedPr?: {
    state: string;
    lastSyncedAt: string;
    reviewDecision: string | null;
    reviewDecisionPending: boolean;
    observations?: AssociatedPr['observations'];
  } | null;
}): string {
  return `${s.session_id}-${s.updated_at}-${s.last_activity_at ?? ''}-${s.status ?? ''}-${s.status_updated_at ?? ''}-${s.cloud_agent_worktree_id ?? ''}-${s.latest_run_status ?? ''}-${s.latest_run_failure_kind ?? ''}-${s.latest_run_terminal_at ?? ''}-${s.associatedPr?.state ?? ''}-${s.associatedPr?.lastSyncedAt ?? ''}-${s.associatedPr?.reviewDecision ?? ''}-${s.associatedPr?.reviewDecisionPending ?? false}-${JSON.stringify(s.associatedPr?.observations ?? null)}`;
}

/**
 * Polling cadence used while any row in the list reports
 * `associatedPr.reviewDecisionPending`. The server's batched GraphQL fetch
 * typically lands within a few seconds, so we re-query at this interval until
 * the flag clears, then stop.
 */
const REVIEW_DECISION_POLL_INTERVAL_MS = 5_000;

export function getSidebarWorktreeRefetchInterval(
  data: WorktreeDetailsQueryData | undefined,
  hasVisibleCloudSession = false
): number | false {
  if (!data) return false;
  const details = Object.values(data.worktrees);
  if (details.some(worktree => worktree.prSession?.associatedPr?.reviewDecisionPending === true))
    return REVIEW_DECISION_POLL_INTERVAL_MS;
  return hasVisibleCloudSession ||
    details.some(worktree => worktree.sessions.some(session => session.latest_run_status != null))
    ? SIDEBAR_RECONCILE_DELAY_MS
    : false;
}

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

function compareDbSessionsByActivityDesc(
  a: DbSession | DbSessionV2,
  b: DbSession | DbSessionV2
): number {
  const diff = getDbSessionActivityTime(b) - getDbSessionActivityTime(a);
  if (diff !== 0) return diff;
  return b.session_id.localeCompare(a.session_id);
}

export function sortSidebarDbSessions(
  sessions: (DbSession | DbSessionV2)[]
): (DbSession | DbSessionV2)[] {
  return [...sessions].sort(compareDbSessionsByActivityDesc);
}

export function getSidebarRunOutcomeAfterStatus(
  session: Pick<
    DbSessionV2,
    'latest_run_status' | 'latest_run_failure_kind' | 'latest_run_terminal_at'
  >,
  status: string | null | undefined,
  statusUpdatedAt: Date | string | null | undefined
) {
  if (
    status === 'busy' &&
    session.latest_run_failure_kind &&
    session.latest_run_terminal_at &&
    statusUpdatedAt &&
    new Date(statusUpdatedAt).getTime() > new Date(session.latest_run_terminal_at).getTime()
  ) {
    return {
      latest_run_status: null,
      latest_run_failure_kind: null,
      latest_run_terminal_at: null,
    };
  }
  return {
    latest_run_status: session.latest_run_status ?? null,
    latest_run_failure_kind: session.latest_run_failure_kind ?? null,
    latest_run_terminal_at: session.latest_run_terminal_at ?? null,
  };
}

function mergeSidebarDbSession(
  existing: DbSession | DbSessionV2 | undefined,
  next: DbSessionV2
): DbSessionV2 {
  if (!existing) return next;

  const previousOutcome = getSidebarRunOutcomeAfterStatus(
    existing,
    next.status,
    next.status_updated_at
  );
  const merged = {
    ...next,
    title: keepRealSessionTitle(existing.title, next.title) ?? null,
    latest_run_status:
      next.latest_run_status === undefined
        ? previousOutcome.latest_run_status
        : next.latest_run_status,
    latest_run_failure_kind:
      next.latest_run_failure_kind === undefined
        ? previousOutcome.latest_run_failure_kind
        : next.latest_run_failure_kind,
    latest_run_terminal_at:
      next.latest_run_terminal_at === undefined
        ? previousOutcome.latest_run_terminal_at
        : next.latest_run_terminal_at,
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

function workspaceRowRepresentativeSession(row: SidebarWorkspaceListRow): StoredSession | null {
  const sessionId = row.latestSessionId ?? row.rootSessionId ?? null;
  if (!sessionId) return null;

  return {
    sessionId,
    repository: extractRepoDisplay(row.gitUrl),
    branch: row.branch,
    worktreeId: row.worktreeId,
    prompt: row.name || row.defaultTitle || getChatDisplayTitle(null),
    mode: 'code',
    model: '',
    status: 'active',
    createdAt: row.createdAt,
    updatedAt: row.lastActivityAt,
    lastActivityAt: row.lastActivityAt,
    messages: [],
    cloudAgentSessionId: null,
    createdOnPlatform: null,
    sessionStatus: row.status.sessionStatus,
    sessionStatusUpdatedAt: row.status.statusUpdatedAt,
    latestRunFailureKind: row.status.latestRunFailureKind,
    latestRunTerminalAt: row.status.latestRunTerminalAt,
    associatedPr: row.pr,
  };
}

export function workspaceRowToSidebarDetails(row: SidebarWorkspaceListRow): SidebarWorktreeDetails {
  const session = workspaceRowRepresentativeSession(row);
  return {
    name: row.name,
    defaultTitle: row.defaultTitle,
    prSession: session
      ? {
          ...session,
          associatedPr: row.pr,
        }
      : null,
    sessions:
      session === null
        ? []
        : [
            {
              sessionId: session.sessionId,
              sessionStatus: session.sessionStatus ?? null,
              sessionStatusUpdatedAt: session.sessionStatusUpdatedAt ?? null,
              updatedAt: session.updatedAt,
              latestRunFailureKind: session.latestRunFailureKind ?? null,
              latestRunTerminalAt: session.latestRunTerminalAt ?? null,
            },
          ],
    branch: row.branch,
    parentWorktreeId: row.parentWorktreeId,
    baseBranch: row.baseBranch,
    folderId: row.folderId,
    sidebarPosition: row.sidebarPosition,
    createdAt: row.createdAt,
    gitUrl: row.gitUrl,
  };
}

/** Row metadata only fills gaps in the per-chat details, which load first. */
export function mergeWorkspaceRowDetails(
  details: Record<string, SidebarWorktreeDetails>,
  rows: readonly SidebarWorkspaceListRow[]
): Record<string, SidebarWorktreeDetails> {
  const merged = { ...details };
  for (const row of rows) {
    if (!row.worktreeId) continue;
    const worktreeId = row.worktreeId;
    const current = merged[worktreeId];
    if (!current) {
      merged[worktreeId] = workspaceRowToSidebarDetails(row);
      continue;
    }
    merged[worktreeId] = {
      name: current.name ?? row.name,
      defaultTitle: current.defaultTitle ?? row.defaultTitle,
      prSession: current.prSession ?? workspaceRowToSidebarDetails(row).prSession,
      sessions: current.sessions,
      branch: current.branch ?? row.branch,
      parentWorktreeId: current.parentWorktreeId ?? row.parentWorktreeId,
      baseBranch: current.baseBranch ?? row.baseBranch,
      folderId: current.folderId ?? row.folderId,
      sidebarPosition: current.sidebarPosition ?? row.sidebarPosition,
      createdAt: current.createdAt ?? row.createdAt,
      gitUrl: current.gitUrl ?? row.gitUrl,
    };
  }
  return merged;
}

/**
 * Workspace rows include worktrees whose chats are outside the five-day list,
 * so a workspace stays visible and openable after its last chat ages out.
 */
export function groupSidebarWorkspaces(
  sessions: readonly StoredSession[],
  details: Record<string, SidebarWorktreeDetails> = {},
  rows: readonly SidebarWorkspaceListRow[] = []
): SidebarWorktreeGroup[] {
  const groups = new Map<string, SidebarWorktreeGroup>();

  for (const session of sessions) {
    if (!session.worktreeId) continue;
    const existing = groups.get(session.worktreeId);
    if (existing) {
      existing.sessions.push(session);
      continue;
    }
    groups.set(session.worktreeId, {
      type: 'worktree',
      worktreeId: session.worktreeId,
      sessions: [session],
      latestSession: session,
      details: details[session.worktreeId],
    });
  }

  for (const row of rows) {
    if (!row.worktreeId || groups.has(row.worktreeId)) continue;
    const session = workspaceRowRepresentativeSession(row);
    if (!session) continue;
    groups.set(row.worktreeId, {
      type: 'worktree',
      worktreeId: row.worktreeId,
      sessions: [session],
      latestSession: session,
      details: details[row.worktreeId] ?? workspaceRowToSidebarDetails(row),
    });
  }

  for (const group of groups.values()) {
    group.sessions.sort(compareStoredSessionsByActivityDesc);
    group.latestSession = group.sessions[0] ?? group.latestSession;
  }

  return attachWorkspaceStackLayers([...groups.values()]).filter(
    (item): item is SidebarWorktreeGroup => item.type === 'worktree'
  );
}

type UseSidebarSessionsOptions = {
  organizationId?: string | null;
  /** From the server, so the list's key matches its server prefetch. */
  updatedSince?: string;
  searchQuery?: string;
  createdOnPlatform?: string | string[];
  gitUrl?: string | string[];
};

type UseSidebarSessionsReturn = {
  sessions: StoredSession[];
  cachedSessions: StoredSession[];
  worktreeDetails: Record<string, SidebarWorktreeDetails>;
  loadingWorktreeIds: readonly string[];
  /** Workspace rows and their stacks, loaded independently of the chat list. */
  workspaceGroups: SidebarWorktreeGroup[];
  workspaceRows: SidebarWorkspaceListRow[];
  workspaceOrder: WorkspaceOrder;
  workspaceRowsTruncated: boolean;
  isLoading: boolean;
  refetchSessions: () => void;
  renameSessionLocally: (sessionId: string, newTitle: string) => void;
};

export const PR_LINK_ATTEMPT_HISTORY_LIMIT = 1000;

export function recordPrLinkVerificationAttempt(
  attempted: Map<string, string>,
  sessionId: string,
  verificationKey: string
) {
  attempted.delete(sessionId);
  attempted.set(sessionId, verificationKey);
  if (attempted.size > PR_LINK_ATTEMPT_HISTORY_LIMIT) {
    const oldestSessionId = attempted.keys().next().value;
    if (oldestSessionId !== undefined) attempted.delete(oldestSessionId);
  }
}

export function shouldRetryPrLinkVerification(failureCount: number, error: unknown): boolean {
  if (failureCount >= 1 || !(error instanceof TRPCClientError)) return false;
  const code: unknown = error.data?.code;
  return (
    code === 'INTERNAL_SERVER_ERROR' ||
    code === 'BAD_GATEWAY' ||
    code === 'SERVICE_UNAVAILABLE' ||
    code === 'GATEWAY_TIMEOUT' ||
    code === 'TIMEOUT' ||
    (code === undefined && error.cause instanceof TypeError)
  );
}

export function nextPrLinkVerification(
  sessions: readonly { session_id: string; prLinkVerificationKey?: string }[],
  attempted: ReadonlyMap<string, string>
) {
  return sessions.find(
    session =>
      session.prLinkVerificationKey !== undefined &&
      attempted.get(session.session_id) !== session.prLinkVerificationKey
  );
}

export function useSidebarSessions(options?: UseSidebarSessionsOptions): UseSidebarSessionsReturn {
  const {
    organizationId,
    updatedSince: serverUpdatedSince,
    searchQuery = '',
    createdOnPlatform,
    gitUrl,
  } = options ?? {};
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const sharedConnection = useUserWebConnection();
  const reconcileSidebarQueries = useCallback(() => {
    void queryClient.invalidateQueries(trpc.cliSessionsV2.list.pathFilter());
    void queryClient.invalidateQueries(trpc.cliSessionsV2.search.pathFilter());
    void queryClient.invalidateQueries(trpc.cliSessionsV2.recentRepositories.pathFilter());
    void queryClient.invalidateQueries(trpc.cliSessionsV2.worktreeDetails.pathFilter());
    void queryClient.invalidateQueries(trpc.cliSessionsV2.listWorkspaces.pathFilter());
  }, [queryClient, trpc]);
  const queryReconciler = useMemo(
    () => createSidebarQueryReconciler(reconcileSidebarQueries),
    [reconcileSidebarQueries]
  );

  useEffect(() => () => queryReconciler.dispose(), [queryReconciler]);

  const recentSessions = useAtomValue(recentSessionsAtom);
  const setDbSessions = useSetAtom(dbSessionsAtom);

  const isSearchActive = searchQuery.length > 0;

  const [updatedSince] = useState(() => serverUpdatedSince ?? sidebarUpdatedSince(new Date()));
  const listInput = useMemo(
    () => sidebarListInput({ updatedSince, organizationId, createdOnPlatform, gitUrl }),
    [updatedSince, organizationId, createdOnPlatform, gitUrl]
  );
  const { data: listData, isLoading: isListLoading } = useQuery({
    ...trpc.cliSessionsV2.list.queryOptions(listInput),
    staleTime: 5000,
    enabled: !isSearchActive,
    // Run telemetry can settle after the final session status event.
    refetchInterval: query => {
      const hasPending = query.state.data?.cliSessions?.some(
        s => s.associatedPr?.reviewDecisionPending === true
      );
      return hasPending
        ? REVIEW_DECISION_POLL_INTERVAL_MS
        : query.state.data?.cliSessions.some(session => session.cloud_agent_session_id)
          ? SIDEBAR_RECONCILE_DELAY_MS
          : false;
    },
  });

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
    refetchInterval: query =>
      query.state.data?.results.some(session => session.cloud_agent_session_id)
        ? SIDEBAR_RECONCILE_DELAY_MS
        : false,
  });

  const attemptedPrLinks = useRef(new Map<string, string>());
  const { mutate: verifyPrLink, isPending: isVerifyingPrLink } = useMutation({
    ...trpc.cliSessionsV2.refreshAssociatedPullRequest.mutationOptions(),
    retry: shouldRetryPrLinkVerification,
    onSuccess: result => {
      if (result.associatedPr !== null) reconcileSidebarQueries();
    },
  });
  const verificationSessions = isSearchActive ? searchData?.results : listData?.cliSessions;
  useEffect(() => {
    if (isVerifyingPrLink || !verificationSessions) return;
    const session = nextPrLinkVerification(verificationSessions, attemptedPrLinks.current);
    if (!session?.prLinkVerificationKey) return;
    recordPrLinkVerificationAttempt(
      attemptedPrLinks.current,
      session.session_id,
      session.prLinkVerificationKey
    );
    verifyPrLink({ sessionId: session.session_id });
  }, [verificationSessions, isVerifyingPrLink, verifyPrLink]);

  const workspaceListInput = useMemo(
    () =>
      sidebarWorkspaceListInput({
        organizationId,
        createdOnPlatform,
        gitUrl,
        search: searchQuery,
      }),
    [organizationId, createdOnPlatform, gitUrl, searchQuery]
  );
  // Load only the first page. The list shows a banner when the server truncates it.
  const workspaceListQuery = useInfiniteQuery({
    ...trpc.cliSessionsV2.listWorkspaces.infiniteQueryOptions(workspaceListInput, {
      getNextPageParam: lastPage => lastPage.nextCursor ?? undefined,
    }),
    staleTime: 5000,
  });
  const workspacePreferencesQuery = useQuery({
    ...trpc.cloudAgentSettings.getWorkspaceOrder.queryOptions(),
    staleTime: 60_000,
  });
  const workspaceRows = useMemo<SidebarWorkspaceListRow[]>(
    () => workspaceListQuery.data?.pages.flatMap(page => page.workspaces) ?? [],
    [workspaceListQuery.data?.pages]
  );

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
        setDbSessions(previous => {
          const previousTitles = new Map(
            previous.map(session => [session.session_id, session.title] as const)
          );
          return listData.cliSessions.map(session => {
            const mapped = apiSessionToDbSession(session);
            const previousTitle = previousTitles.get(mapped.session_id);
            const title = keepRealSessionTitle(previousTitle, mapped.title);
            return title === mapped.title ? mapped : { ...mapped, title: title ?? null };
          });
        });
      }
    }
  }, [listData?.cliSessions, setDbSessions, isSearchActive]);

  const cachedSessions = useMemo<StoredSession[]>(() => {
    const rows =
      recentSessions.length === 0 && listData?.cliSessions && !isSearchActive
        ? listData.cliSessions.map(apiSessionToDbSession)
        : recentSessions;
    return rows
      .filter(session => organizationId === undefined || session.organization_id === organizationId)
      .map(dbSessionToStoredSession);
  }, [isSearchActive, listData?.cliSessions, organizationId, recentSessions]);

  // Convert search results directly to StoredSession[] (no Jotai atoms)
  const searchSessions = useMemo<StoredSession[]>(() => {
    if (!searchData?.results) return [];
    return searchData.results.map(row => ({
      sessionId: row.session_id,
      repository: extractRepoDisplay(row.git_url),
      branch: row.git_branch,
      worktreeId: row.cloud_agent_worktree_id ?? null,
      prompt: getChatDisplayTitle(row.title),
      mode: 'code',
      model: '',
      status: row.cloud_agent_session_id ? ('active' as const) : ('completed' as const),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastActivityAt: readLastActivityAt(row),
      messages: [],
      cloudAgentSessionId: row.cloud_agent_session_id,
      createdOnPlatform: row.created_on_platform,
      sessionStatus: row.status,
      sessionStatusUpdatedAt: row.status_updated_at,
      latestRunFailureKind: row.latest_run_failure_kind,
      latestRunTerminalAt: row.latest_run_terminal_at,
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
      last_activity_at: session.last_activity_at?.toISOString() ?? null,
      version: session.version,
      created_on_platform: session.created_on_platform ?? 'unknown',
      organization_id: session.organization_id,
      git_url: session.git_url,
      git_branch: session.git_branch,
      parent_session_id: session.parent_session_id,
      status: session.status,
      status_updated_at: session.status_updated_at?.toISOString() ?? null,
      associatedPr: session.associatedPr
        ? {
            ...session.associatedPr,
            baseRef: session.associatedPr.baseRef ?? null,
            stackNumber: session.associatedPr.stackNumber ?? null,
            stackPosition: session.associatedPr.stackPosition ?? null,
            stackSize: session.associatedPr.stackSize ?? null,
          }
        : null,
      total_cost_microdollars: session.total_cost_microdollars ?? null,
      latest_run_status: session.latest_run_status ?? null,
      latest_run_failure_kind: session.latest_run_failure_kind ?? null,
      latest_run_terminal_at: session.latest_run_terminal_at ?? null,
    };
  }

  function sortSearchRows(rows: SearchRow[]): SearchRow[] {
    return [...rows].sort((a, b) => {
      const activityA = new Date(readLastActivityAt(a) ?? a.created_at).getTime();
      const activityB = new Date(readLastActivityAt(b) ?? b.created_at).getTime();
      const diff = activityB - activityA;
      if (diff !== 0) return diff;
      return b.session_id.localeCompare(a.session_id);
    });
  }

  useEffect(() => {
    if (!sharedConnection) return;

    const filters = { organizationId, createdOnPlatform, gitUrl } satisfies SidebarSessionFilters;
    const patchWorktreeStatus = (
      update: Parameters<typeof patchSidebarWorktreeSessionStatus>[1]
    ) => {
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
              ...getSidebarRunOutcomeAfterStatus(
                existing,
                session.status,
                session.status_updated_at
              ),
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
          ...getSidebarRunOutcomeAfterStatus(existing, payload.status, payload.statusUpdatedAt),
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
        updatedAt: payload.session.updatedAt,
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
          updatedAt: payload.updatedAt ?? undefined,
        });
        setDbSessions(prev =>
          sortSidebarDbSessions(
            prev.map(s =>
              s.session_id === payload.sessionId
                ? {
                    ...s,
                    ...getSidebarRunOutcomeAfterStatus(s, payload.status, payload.statusUpdatedAt),
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

  const sessions = useMemo(
    () => (isSearchActive ? searchSessions : cachedSessions),
    [isSearchActive, searchSessions, cachedSessions]
  );
  const worktreeIdBatches = useMemo(
    () =>
      worktreeDetailsBatches([
        ...sessions.map(session => session.worktreeId),
        ...workspaceRows.map(row => row.worktreeId),
      ]),
    [sessions, workspaceRows]
  );
  const worktreeDetailsQueries = useQueries({
    queries: worktreeIdBatches.map(worktreeIds =>
      trpc.cliSessionsV2.worktreeDetails.queryOptions(
        { worktreeIds, organizationId: organizationId ?? null },
        {
          staleTime: 5000,
          placeholderData: () =>
            getCachedWorktreeDetails(
              queryClient.getQueriesData<WorktreeDetailsQueryData>(
                trpc.cliSessionsV2.worktreeDetails.pathFilter()
              ),
              worktreeIds,
              organizationId ?? null
            ),
          refetchInterval: query =>
            getSidebarWorktreeRefetchInterval(
              query.state.data,
              sessions.some(
                session =>
                  session.cloudAgentSessionId &&
                  worktreeIds.some(worktreeId => worktreeId === session.worktreeId)
              )
            ),
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
            sessions: worktree.sessions.map(session => ({
              ...session,
              latestRunFailureKind: session.latest_run_failure_kind,
              latestRunTerminalAt: session.latest_run_terminal_at,
            })),
            prSession: worktree.prSession
              ? dbSessionToStoredSession(apiSessionToDbSession(worktree.prSession))
              : null,
            branch: worktree.branch,
            parentWorktreeId: worktree.parentWorktreeId,
            baseBranch: worktree.baseBranch,
            baseSha: worktree.baseSha,
            folderId: worktree.folderId,
            sidebarPosition: worktree.sidebarPosition,
            createdAt: worktree.createdAt,
          };
        }
      }
      return {
        details,
        loadingWorktreeIds: getLoadingWorktreeIds(queries, worktreeIdBatches),
      };
    },
  });
  const mergedWorktreeDetails = useMemo(
    () => mergeWorkspaceRowDetails(worktreeDetailsQueries.details, workspaceRows),
    [worktreeDetailsQueries.details, workspaceRows]
  );
  const workspaceGroups = useMemo(
    () => groupSidebarWorkspaces(sessions, mergedWorktreeDetails, workspaceRows),
    [mergedWorktreeDetails, sessions, workspaceRows]
  );
  const workspaceRowsTruncated = useMemo(
    () => workspaceListQuery.data?.pages.some(page => page.truncated) ?? false,
    [workspaceListQuery.data?.pages]
  );
  const workspaceOrder = workspacePreferencesQuery.data?.workspaceOrder ?? 'manual';
  const isLoading = isSearchActive
    ? isSearchLoading
    : isListLoading || Boolean(listData?.cliSessions.length && cachedSessions.length === 0);

  const refetchSessions = useCallback(() => {
    void queryClient.invalidateQueries(trpc.cliSessionsV2.list.pathFilter());
    void queryClient.invalidateQueries(trpc.cliSessionsV2.worktreeDetails.pathFilter());
    void queryClient.invalidateQueries(trpc.cliSessionsV2.listWorkspaces.pathFilter());
  }, [queryClient, trpc]);

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
    worktreeDetails: mergedWorktreeDetails,
    loadingWorktreeIds: worktreeDetailsQueries.loadingWorktreeIds,
    workspaceGroups,
    workspaceRows,
    workspaceOrder,
    workspaceRowsTruncated,
    isLoading,
    refetchSessions,
    renameSessionLocally,
  };
}
