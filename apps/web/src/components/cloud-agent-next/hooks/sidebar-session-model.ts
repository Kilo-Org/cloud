import { differenceInCalendarDays, format, isSameDay, startOfDay, subDays } from 'date-fns';
import type {
  AgentStatus,
  CloudStatus,
  MessageDeliveryState,
  ResolvedSession,
  SessionActivity,
} from '@kilocode/cloud-agent-sdk';
import type { DbSession, DbSessionV2 } from '../store/db-session-atoms';
import type { StoredSession } from '../types';
import { extractRepoFromGitUrl } from '../utils/git-utils';
import { getChatDisplayTitle } from '../utils/session-title';
import type { WorkspaceSummary } from './useWorkspaceSummaries';

export type SidebarWorkspaceListRow = WorkspaceSummary;
export type SidebarForegroundSessionStatus = { sessionId: string; status: string };
export type SidebarWorktreeActivity = {
  status: string | null;
  statusUpdatedAt: string | null;
  isLive: boolean;
};
export type SidebarWorktreeDetails = {
  name: string | null;
  defaultTitle: string | null;
  prSession: StoredSession | null;
  sessions: Pick<
    StoredSession,
    'sessionId' | 'sessionStatus' | 'sessionStatusUpdatedAt' | 'updatedAt'
  >[];
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
  summary?: WorkspaceSummary;
  stackLayers?: SidebarWorktreeGroup[];
  stackDepth?: number;
};
export type SidebarSessionItem = { type: 'session'; session: StoredSession } | SidebarWorktreeGroup;
export type SidebarSessionDateGroup = { label: string; items: SidebarSessionItem[] };
export type SidebarSortPins = ReadonlyMap<string, number>;
export const SIDEBAR_RUNNING_BUMP_INTERVAL_MS = 60_000;

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
  return {
    sessionId: session.session_id,
    repository: extractRepoFromGitUrl(session.git_url) ?? '',
    branch: session.git_branch ?? null,
    worktreeId: session.cloud_agent_worktree_id ?? null,
    prompt: getChatDisplayTitle(session.title),
    mode: 'last_mode' in session ? (session.last_mode ?? 'code') : 'code',
    model: 'last_model' in session ? (session.last_model ?? '') : '',
    status: session.cloud_agent_session_id ? 'active' : 'completed',
    createdAt: session.created_at.toISOString(),
    updatedAt: session.updated_at.toISOString(),
    lastActivityAt: session.last_activity_at?.toISOString() ?? null,
    messages: [],
    cloudAgentSessionId: session.cloud_agent_session_id,
    createdOnPlatform: session.created_on_platform ?? null,
    sessionStatus: session.status,
    sessionStatusUpdatedAt: session.status_updated_at?.toISOString() ?? null,
    latestRunFailureKind: session.latest_run_failure_kind ?? null,
    latestRunTerminalAt: session.latest_run_terminal_at ?? null,
    associatedPr: 'associatedPr' in session ? (session.associatedPr ?? null) : undefined,
  };
}

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
}: {
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
}): 'permission' | 'question' | 'retry' | 'busy' | 'idle' | 'failed' | null {
  if (
    !currentSessionId ||
    activeSessionType !== 'cloud-agent' ||
    fetchedSessionData?.kiloSessionId !== currentSessionId ||
    fetchedSessionData.organizationId !== organizationId
  )
    return null;
  if (activePermission) return 'permission';
  if (activeQuestion) return 'question';
  if (activity.type === 'retrying') return 'retry';
  if (
    activity.type === 'busy' ||
    isStreaming ||
    cloudStatus?.type === 'preparing' ||
    cloudStatus?.type === 'finalizing'
  )
    return 'busy';
  for (const message of pendingMessages.values()) if (message.status === 'queued') return 'busy';
  if (agentStatus?.type === 'error' || cloudStatus?.type === 'error') return 'failed';
  return 'idle';
}

export function getSidebarSessionStatus(
  session: Pick<
    StoredSession,
    'sessionStatus' | 'sessionStatusUpdatedAt' | 'latestRunFailureKind' | 'latestRunTerminalAt'
  >
): string | null {
  if (
    session.latestRunFailureKind &&
    session.latestRunTerminalAt &&
    new Date(session.latestRunTerminalAt).getTime() >=
      new Date(session.sessionStatusUpdatedAt ?? 0).getTime()
  )
    return session.latestRunFailureKind;
  const status = session.sessionStatus;
  return !status || status === 'idle' ? (session.latestRunFailureKind ?? status ?? null) : status;
}

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

export function getSidebarWorktreeLabel(group: SidebarWorktreeGroup): string {
  if (group.details)
    return group.details.name || group.details.defaultTitle || getChatDisplayTitle(null);
  const repository = group.latestSession.repository || 'Repository';
  return group.latestSession.branch ? `${repository} · ${group.latestSession.branch}` : repository;
}

export function getSidebarWorktreePrSession(group: SidebarWorktreeGroup): StoredSession | null {
  if (group.details) return group.details.prSession;
  return (
    group.sessions.find(session => session.associatedPr != null) ??
    group.sessions.find(session => session.associatedPr === undefined && session.branch) ??
    null
  );
}

export function getSidebarWorktreeActivity(
  group: SidebarWorktreeGroup,
  activeSessionStatuses: ReadonlyMap<string, string>,
  foregroundSession?: SidebarForegroundSessionStatus | null
): SidebarWorktreeActivity {
  const summary = group.summary;
  if (!summary) return { status: null, statusUpdatedAt: null, isLive: false };
  const sourceId = summary.status.sessionId;
  const liveStatus = sourceId ? activeSessionStatuses.get(sourceId) : undefined;
  const foregroundStatus =
    sourceId && foregroundSession?.sessionId === sourceId ? foregroundSession.status : undefined;
  const immediate = foregroundStatus ?? liveStatus;
  const status = immediate ?? summary.sessionStatus;
  return {
    status: status === 'idle' ? null : status,
    statusUpdatedAt: immediate === undefined ? summary.status.statusUpdatedAt : null,
    isLive: immediate !== undefined && immediate !== 'idle',
  };
}

function itemActivityTime(item: SidebarSessionItem, pins: SidebarSortPins): number {
  if (item.type === 'session')
    return pins.get(item.session.sessionId) ?? getStoredSessionActivityTime(item.session);
  return Math.max(
    pins.get(item.worktreeId) ?? getStoredSessionActivityTime(item.latestSession),
    ...(item.stackLayers ?? []).map(layer => itemActivityTime(layer, pins))
  );
}

export function groupSidebarSessionsByDate(
  sessions: StoredSession[],
  now = new Date(),
  sortPins: SidebarSortPins = new Map()
): SidebarSessionDateGroup[] {
  return groupSidebarItemsByDate(
    sessions.map(session => ({ type: 'session', session })),
    now,
    sortPins
  );
}

export function groupSidebarItemsByDate(
  items: readonly SidebarSessionItem[],
  now = new Date(),
  sortPins: SidebarSortPins = new Map()
): SidebarSessionDateGroup[] {
  const buckets = new Map<string, { daysAgo: number; items: SidebarSessionItem[] }>();
  const sorted = [...items].sort(
    (a, b) => itemActivityTime(b, sortPins) - itemActivityTime(a, sortPins)
  );
  for (const item of sorted) {
    const date = new Date(itemActivityTime(item, sortPins));
    const daysAgo = differenceInCalendarDays(startOfDay(now), startOfDay(date));
    const label = isSameDay(date, now)
      ? 'Today'
      : isSameDay(date, subDays(now, 1))
        ? 'Yesterday'
        : daysAgo <= 7
          ? format(date, 'EEEE')
          : 'Older';
    const bucket = buckets.get(label);
    if (bucket) bucket.items.push(item);
    else buckets.set(label, { daysAgo, items: [item] });
  }
  const groups: SidebarSessionDateGroup[] = [];
  const older: SidebarSessionItem[] = [];
  let namedDays = 0;
  for (const [label, bucket] of [...buckets].sort((a, b) => a[1].daysAgo - b[1].daysAgo)) {
    if (label === 'Older' || (label !== 'Today' && label !== 'Yesterday' && namedDays++ >= 3))
      older.push(...bucket.items);
    else groups.push({ label, items: bucket.items });
  }
  if (older.length) groups.push({ label: 'Older', items: older });
  return groups;
}
