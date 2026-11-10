import { positionBetween } from '@/lib/todos/position';
import type {
  SmartFolderPreset,
  WorkspaceFolder,
  WorkspaceFolderSortMode,
} from '@/lib/cloud-agent/workspace-folders';

/** Workspace rows are ordered independently of single-session rows. */
export type WorkspaceOrder = WorkspaceFolderSortMode;

export type SidebarWorkspaceRow = {
  worktreeId: string;
  createdAt: string;
  lastActivityAt: string;
  sidebarPosition: string | null;
  folderId: string | null;
  parentWorktreeId: string | null;
  prState: string | null;
  status: string | null;
  statusUpdatedAt: string | null;
  hasPendingQuestion: boolean;
  lastTurnFailed: boolean;
};

export type SidebarWorkspaceGroup = {
  root: SidebarWorkspaceRow;
  layers: SidebarWorkspaceRow[];
};

export type WorkspaceDestinations = {
  manual: Map<string, SidebarWorkspaceGroup[]>;
  smart: Map<SmartFolderPreset, SidebarWorkspaceGroup[]>;
  unfiled: SidebarWorkspaceGroup[];
};

const VALID_POSITION_KEY = /^[0-9a-z]*[1-9a-z]$/;

/** PostgreSQL's `collate "C"` ordering and JavaScript string ordering agree. */
export function comparePositionKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function isValidPositionKey(value: string | null | undefined): value is string {
  return typeof value === 'string' && VALID_POSITION_KEY.test(value);
}

export function getPositionBetween(before: string | null, after: string | null): string {
  return positionBetween(before, after);
}

function time(value: string): number {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareRecentFirst(
  a: SidebarWorkspaceRow,
  b: SidebarWorkspaceRow,
  pick: (row: SidebarWorkspaceRow) => string
): number {
  return time(pick(b)) - time(pick(a)) || comparePositionKeys(a.worktreeId, b.worktreeId);
}

function compareManual(a: SidebarWorkspaceRow, b: SidebarWorkspaceRow): number {
  if (isValidPositionKey(a.sidebarPosition) && isValidPositionKey(b.sidebarPosition)) {
    const position = comparePositionKeys(a.sidebarPosition, b.sidebarPosition);
    if (position !== 0) return position;
  } else if (isValidPositionKey(a.sidebarPosition)) {
    return 1;
  } else if (isValidPositionKey(b.sidebarPosition)) {
    return -1;
  }
  return compareRecentFirst(a, b, row => row.createdAt);
}

function compareRoots(
  a: SidebarWorkspaceRow,
  b: SidebarWorkspaceRow,
  order: WorkspaceOrder
): number {
  if (order === 'manual') return compareManual(a, b);
  if (order === 'created') return compareRecentFirst(a, b, row => row.createdAt);
  return (
    compareRecentFirst(a, b, row => row.lastActivityAt) ||
    compareRecentFirst(a, b, row => row.createdAt)
  );
}

export function sortWorkspaceGroups(
  groups: readonly SidebarWorkspaceGroup[],
  order: WorkspaceOrder
): SidebarWorkspaceGroup[] {
  return [...groups].sort((a, b) => compareRoots(a.root, b.root, order));
}

function groupNeedsYou(group: SidebarWorkspaceGroup): boolean {
  return [group.root, ...group.layers].some(
    row =>
      row.hasPendingQuestion ||
      row.lastTurnFailed ||
      row.status === 'question' ||
      row.status === 'permission' ||
      row.status === 'failed' ||
      row.status === 'system_interrupted'
  );
}

function groupInReview(group: SidebarWorkspaceGroup): boolean {
  return [group.root, ...group.layers].some(
    row => row.prState === 'open' || row.prState === 'draft'
  );
}

function groupDone(group: SidebarWorkspaceGroup): boolean {
  const rows = [group.root, ...group.layers];
  return (
    rows.some(row => row.prState !== null) &&
    rows.every(row => row.prState === 'merged' || row.prState === 'closed')
  );
}

/**
 * A workspace or stack appears exactly once. Manual folders win over the
 * automatic review buckets; only the urgent "Needs you" bucket overrides a
 * manual folder. Automatic buckets are considered only when their folder is
 * enabled (the folder row is present).
 */
export function groupWorkspaceGroupsByDestination(
  orderedGroups: readonly SidebarWorkspaceGroup[],
  folders: readonly WorkspaceFolder[]
): WorkspaceDestinations {
  const manualFolders = new Set(
    folders.filter(folder => folder.kind === 'manual').map(folder => folder.id)
  );
  const smartFolders = new Set(
    folders.flatMap(folder =>
      folder.kind === 'smart' && folder.smartPreset ? [folder.smartPreset] : []
    )
  );
  const manual = new Map<string, SidebarWorkspaceGroup[]>();
  const smart = new Map<SmartFolderPreset, SidebarWorkspaceGroup[]>();
  const unfiled: SidebarWorkspaceGroup[] = [];

  const push = <K>(map: Map<K, SidebarWorkspaceGroup[]>, key: K, group: SidebarWorkspaceGroup) => {
    const bucket = map.get(key);
    if (bucket) bucket.push(group);
    else map.set(key, [group]);
  };

  for (const group of orderedGroups) {
    if (smartFolders.has('needs_you') && groupNeedsYou(group)) {
      push(smart, 'needs_you', group);
      continue;
    }
    const folderId = group.root.folderId;
    if (folderId && manualFolders.has(folderId)) {
      push(manual, folderId, group);
      continue;
    }
    if (smartFolders.has('in_review') && !groupNeedsYou(group) && groupInReview(group)) {
      push(smart, 'in_review', group);
      continue;
    }
    if (smartFolders.has('done') && !groupNeedsYou(group) && groupDone(group)) {
      push(smart, 'done', group);
      continue;
    }
    unfiled.push(group);
  }

  return { manual, smart, unfiled };
}

function waitingTime(group: SidebarWorkspaceGroup): number {
  const waiting = [group.root, ...group.layers].filter(
    row =>
      row.hasPendingQuestion ||
      row.lastTurnFailed ||
      row.status === 'question' ||
      row.status === 'permission' ||
      row.status === 'failed' ||
      row.status === 'system_interrupted'
  );
  const times = waiting.map(row => (row.statusUpdatedAt ? time(row.statusUpdatedAt) : Infinity));
  return times.length > 0 ? Math.min(...times) : Infinity;
}

export function sortSmartFolderGroups(
  groups: readonly SidebarWorkspaceGroup[],
  preset: SmartFolderPreset,
  sortMode: WorkspaceFolderSortMode
): SidebarWorkspaceGroup[] {
  if (preset !== 'needs_you') return sortWorkspaceGroups(groups, sortMode);
  return [...groups].sort((a, b) => {
    const aTime = waitingTime(a);
    const bTime = waitingTime(b);
    if (aTime !== bTime) return aTime - bTime;
    return comparePositionKeys(a.root.worktreeId, b.root.worktreeId);
  });
}
