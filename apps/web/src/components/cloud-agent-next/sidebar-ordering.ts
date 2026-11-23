import { positionBetween } from '@/lib/todos/position';
import type {
  SmartFolderPreset,
  WorkspaceFolderSortMode,
} from '@/lib/cloud-agent/workspace-folders';
import type { WorkspaceDestination } from '@/lib/cloud-agent/workspace-activity';

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
  destination: WorkspaceDestination;
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
  const activity = (group: SidebarWorkspaceGroup) =>
    Math.max(...[group.root, ...group.layers].map(row => time(row.lastActivityAt)));
  return [...groups].sort(
    (a, b) =>
      (order === 'activity' ? activity(b) - activity(a) : 0) || compareRoots(a.root, b.root, order)
  );
}

/** New smart-folder members precede the last explicitly saved order. */
export function sortSmartFolderGroups(
  groups: readonly SidebarWorkspaceGroup[],
  order: WorkspaceOrder,
  manualWorktreeOrder: readonly string[]
): SidebarWorkspaceGroup[] {
  if (order !== 'manual') return sortWorkspaceGroups(groups, order);
  const positions = new Map(manualWorktreeOrder.map((id, index) => [id, index]));
  return [...groups].sort((a, b) => {
    const aPosition = positions.get(a.root.worktreeId);
    const bPosition = positions.get(b.root.worktreeId);
    if (aPosition !== undefined && bPosition !== undefined) return aPosition - bPosition;
    if (aPosition !== undefined) return 1;
    if (bPosition !== undefined) return -1;
    const entryTime = (group: SidebarWorkspaceGroup) =>
      Math.max(
        ...[group.root, ...group.layers].map(row => time(row.statusUpdatedAt ?? row.lastActivityAt))
      );
    return entryTime(b) - entryTime(a) || compareRoots(a.root, b.root, 'created');
  });
}

export function groupWorkspaceGroupsByDestination(
  orderedGroups: readonly SidebarWorkspaceGroup[]
): WorkspaceDestinations {
  const manual = new Map<string, SidebarWorkspaceGroup[]>();
  const smart = new Map<SmartFolderPreset, SidebarWorkspaceGroup[]>();
  const unfiled: SidebarWorkspaceGroup[] = [];

  const push = <K>(map: Map<K, SidebarWorkspaceGroup[]>, key: K, group: SidebarWorkspaceGroup) => {
    const bucket = map.get(key);
    if (bucket) bucket.push(group);
    else map.set(key, [group]);
  };

  for (const group of orderedGroups) {
    const destination = group.root.destination;
    if (destination.kind === 'manual') push(manual, destination.folderId, group);
    else if (destination.kind === 'smart') push(smart, destination.preset, group);
    else unfiled.push(group);
  }

  return { manual, smart, unfiled };
}
