import type { SmartFolderPreset } from './workspace-folders';

export const WORKSPACE_STALE_STATUS_MS = 3 * 60 * 60_000;
export const WORKSPACE_FOLDER_LIMIT = 500;
export const UNGROUPED_WORKSPACE_LIMIT = 50;

export type WorkspaceSessionActivity = {
  sessionId: string;
  sessionStatus: string | null;
  sessionStatusUpdatedAt: string | null;
  latestRunFailureKind: 'failed' | 'system_interrupted' | null;
  latestRunTerminalAt: string | null;
  createdAt: string;
  lastActivityAt: string | null;
  updatedAt: string;
};

export function workspaceSessionStatus(
  session: WorkspaceSessionActivity,
  now: number
): string | null {
  const failureAt = Date.parse(session.latestRunTerminalAt ?? '');
  const statusAt = Date.parse(session.sessionStatusUpdatedAt ?? '');
  if (session.latestRunFailureKind && (!Number.isFinite(statusAt) || failureAt >= statusAt)) {
    return session.latestRunFailureKind;
  }
  if (
    (session.sessionStatus === 'busy' || session.sessionStatus === 'retry') &&
    now - Date.parse(session.sessionStatusUpdatedAt ?? session.updatedAt) >=
      WORKSPACE_STALE_STATUS_MS
  )
    return null;
  return session.sessionStatus;
}

export function workspaceStatusPriority(status: string | null): number {
  if (status === 'question' || status === 'permission') return 3;
  if (status === 'busy' || status === 'retry') return 2;
  if (status === 'failed' || status === 'system_interrupted') return 1;
  return 0;
}

export function aggregateWorkspaceActivity(
  sessions: readonly WorkspaceSessionActivity[],
  now = Date.now()
) {
  const rows = [...sessions].sort(
    (a, b) =>
      Date.parse(b.lastActivityAt ?? b.createdAt) - Date.parse(a.lastActivityAt ?? a.createdAt) ||
      b.sessionId.localeCompare(a.sessionId)
  );
  let selected = rows[0];
  let selectedStatus: string | null = null;
  let priority = 0;
  for (const session of rows) {
    const status = workspaceSessionStatus(session, now);
    const rank = workspaceStatusPriority(status);
    if (rank === 1 && session !== rows[0]) continue;
    if (rank <= priority) continue;
    selected = session;
    selectedStatus = status;
    priority = rank;
  }
  return {
    kind:
      priority === 3
        ? ('attention' as const)
        : priority === 2
          ? ('running' as const)
          : priority === 1
            ? ('failed' as const)
            : ('idle' as const),
    sessionId: selected?.sessionId ?? null,
    sessionStatus: selectedStatus,
    statusUpdatedAt: selected?.sessionStatusUpdatedAt
      ? new Date(selected.sessionStatusUpdatedAt).toISOString()
      : null,
    latestRunFailureKind: priority === 1 ? (selected?.latestRunFailureKind ?? null) : null,
    latestRunTerminalAt:
      priority === 1 && selected?.latestRunTerminalAt
        ? new Date(selected.latestRunTerminalAt).toISOString()
        : null,
  };
}

export type WorkspaceDestination =
  | { kind: 'manual'; folderId: string }
  | { kind: 'smart'; preset: SmartFolderPreset }
  | { kind: 'ungrouped' };

type DestinationRow = {
  folderId: string | null;
  prState: string | null;
  status: string | null;
  hasPendingQuestion?: boolean;
  lastTurnFailed?: boolean;
};

export function workspaceDestination(
  group: { root: DestinationRow; layers: readonly DestinationRow[] },
  folders: readonly { id: string; kind: string; smartPreset: SmartFolderPreset | null }[]
): WorkspaceDestination {
  const rows = [group.root, ...group.layers];
  const enabled = (preset: SmartFolderPreset) =>
    folders.some(folder => folder.kind === 'smart' && folder.smartPreset === preset);
  const needsYou = rows.some(
    row =>
      row.hasPendingQuestion ||
      row.lastTurnFailed ||
      workspaceStatusPriority(row.status) === 3 ||
      workspaceStatusPriority(row.status) === 1
  );
  if (enabled('needs_you') && needsYou) return { kind: 'smart', preset: 'needs_you' };
  const folderId = group.root.folderId;
  if (folderId && folders.some(folder => folder.kind === 'manual' && folder.id === folderId))
    return { kind: 'manual', folderId };
  if (
    !needsYou &&
    enabled('in_review') &&
    rows.some(row => row.prState === 'open' || row.prState === 'draft')
  )
    return { kind: 'smart', preset: 'in_review' };
  if (
    !needsYou &&
    enabled('done') &&
    rows.some(row => row.prState !== null) &&
    rows.every(row => row.prState === 'merged' || row.prState === 'closed')
  )
    return { kind: 'smart', preset: 'done' };
  return { kind: 'ungrouped' };
}

export function workspaceDestinationKey(destination: WorkspaceDestination): string {
  return destination.kind === 'manual'
    ? destination.folderId
    : destination.kind === 'smart'
      ? destination.preset
      : 'ungrouped';
}

export function selectVisibleWorkspaceGroups<
  T extends {
    root: { worktreeId: string; lastActivityAt: string; destination: WorkspaceDestination };
    layers: readonly { lastActivityAt: string }[];
  },
>(groups: readonly T[]) {
  const totals: Record<string, number> = {};
  const counts = new Map<string, number>();
  const ordered = [...groups].sort((a, b) => {
    const activity = (group: T) =>
      Math.max(...[group.root, ...group.layers].map(row => Date.parse(row.lastActivityAt)));
    return activity(b) - activity(a) || a.root.worktreeId.localeCompare(b.root.worktreeId);
  });
  const visible = ordered.filter(group => {
    const destination = group.root.destination;
    const key = workspaceDestinationKey(destination);
    totals[key] = (totals[key] ?? 0) + 1;
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    const limit =
      destination.kind === 'ungrouped'
        ? UNGROUPED_WORKSPACE_LIMIT
        : destination.kind === 'smart' && destination.preset === 'needs_you'
          ? Infinity
          : WORKSPACE_FOLDER_LIMIT;
    return count <= limit;
  });
  return { groups: visible, totals };
}
