import {
  UNGROUPED_WORKSPACE_LIMIT,
  WORKSPACE_FOLDER_LIMIT,
  workspaceDestinationKey,
} from '@/lib/cloud-agent/workspace-activity';
import type { WorkspaceSummary } from './useWorkspaceSummaries';

export function workspaceRefreshChangesMembership(
  current: readonly WorkspaceSummary[],
  refreshed: readonly WorkspaceSummary[],
  requestedIds: readonly string[]
): boolean {
  const known = new Map(current.map(row => [row.worktreeId, row]));
  const refreshedIds = new Set(refreshed.map(row => row.worktreeId));
  if (requestedIds.some(id => known.has(id) && !refreshedIds.has(id))) return true;
  return refreshed.some(row => {
    const old = known.get(row.worktreeId);
    if (old)
      return (
        workspaceDestinationKey(old.destination) !== workspaceDestinationKey(row.destination) ||
        old.stackRootId !== row.stackRootId
      );
    if (known.has(row.stackRootId)) return true;
    if (row.destination.kind === 'smart' && row.destination.preset === 'needs_you') return true;
    const destination = workspaceDestinationKey(row.destination);
    const roots = current.filter(
      candidate =>
        candidate.stackRootId === candidate.worktreeId &&
        workspaceDestinationKey(candidate.destination) === destination
    );
    const limit =
      row.destination.kind === 'ungrouped' ? UNGROUPED_WORKSPACE_LIMIT : WORKSPACE_FOLDER_LIMIT;
    if (roots.length < limit) return true;
    const activity = (root: WorkspaceSummary) =>
      Math.max(
        ...current
          .filter(candidate => candidate.stackRootId === root.worktreeId)
          .map(candidate => Date.parse(candidate.lastActivityAt))
      );
    return Date.parse(row.lastActivityAt) > Math.min(...roots.map(activity));
  });
}

export function acceptsSidebarStatusUpdate(
  current: { statusUpdatedAt: string | null; updatedAt: string },
  incoming: { statusUpdatedAt: string | null; updatedAt: string }
): boolean {
  return (
    Date.parse(incoming.statusUpdatedAt ?? incoming.updatedAt) >=
    Date.parse(current.statusUpdatedAt ?? current.updatedAt)
  );
}
