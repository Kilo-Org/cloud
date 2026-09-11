import { z } from 'zod';
import { cloudAgentWorktreeIdSchema } from '@kilocode/session-ingest-contracts';
import type { WorkspaceFolder, WorkspaceFolderColor } from '@/lib/cloud-agent/workspace-folders';
import type { SidebarSessionDateGroup, SidebarWorktreeGroup } from './hooks/useSidebarSessions';

export const workspaceFolderColors = [
  { value: 'default', label: 'Default', css: 'var(--muted-foreground)' },
  { value: 'red', label: 'Red', css: 'var(--status-red-400)' },
  { value: 'orange', label: 'Orange', css: 'var(--status-orange-400)' },
  { value: 'yellow', label: 'Yellow', css: 'var(--status-yellow-400)' },
  { value: 'green', label: 'Green', css: 'var(--status-green-400)' },
  { value: 'teal', label: 'Teal', css: 'var(--status-teal-400)' },
  { value: 'blue', label: 'Blue', css: 'var(--status-blue-400)' },
  { value: 'purple', label: 'Purple', css: 'var(--status-purple-400)' },
] satisfies { value: WorkspaceFolderColor; label: string; css: string }[];

export function getWorkspaceFolderColor(color: WorkspaceFolderColor): string {
  return (
    workspaceFolderColors.find(option => option.value === color)?.css ?? 'var(--muted-foreground)'
  );
}

const controlPlaneSessionIdSchema = z.templateLiteral(['workspace_', z.uuid()]);
const collapsedFolderIdsSchema = z.array(z.uuid());

export function isFolderWorkspace(group: SidebarWorktreeGroup): boolean {
  return (
    cloudAgentWorktreeIdSchema.safeParse(group.worktreeId).success &&
    group.sessions.some(
      session => controlPlaneSessionIdSchema.safeParse(session.cloudAgentSessionId).success
    )
  );
}

export function getWorkspaceFolderId(
  folders: readonly WorkspaceFolder[],
  worktreeId: string
): string | null {
  return folders.find(folder => folder.worktreeIds.includes(worktreeId))?.id ?? null;
}

export function groupWorkspacesByFolder(
  dateGroups: readonly SidebarSessionDateGroup[],
  folders: readonly WorkspaceFolder[]
) {
  const folderGroups = folders.map<{ folder: WorkspaceFolder; worktrees: SidebarWorktreeGroup[] }>(
    folder => ({ folder, worktrees: [] })
  );
  const groupsByWorktree = new Map(
    folderGroups.flatMap(group => group.folder.worktreeIds.map(id => [id, group] as const))
  );
  const ungrouped = dateGroups.flatMap(group => {
    const items = group.items.filter(item => {
      if (item.type !== 'worktree' || !isFolderWorkspace(item)) return true;
      const folderGroup = groupsByWorktree.get(item.worktreeId);
      if (!folderGroup) return true;
      folderGroup.worktrees.push(item);
      return false;
    });
    return items.length > 0 ? [{ ...group, items }] : [];
  });
  return { folderGroups, ungrouped };
}

export type WorkspaceFolderDragItem =
  | { type: 'worktree'; id: string }
  | { type: 'folder'; id: string };

export type WorkspaceFolderDropTarget =
  | { type: 'folder'; id: string; placement: 'before' | 'after' }
  | { type: 'ungrouped' };

export type WorkspaceFolderDropAction =
  | { type: 'move-worktree'; worktreeId: string; folderId: string | null }
  | { type: 'reorder-folders'; folderIds: string[] };

export function getWorkspaceFolderDropAction(
  drag: WorkspaceFolderDragItem | null,
  target: WorkspaceFolderDropTarget | null,
  folders: readonly WorkspaceFolder[],
  worktreeIds: ReadonlySet<string>
): WorkspaceFolderDropAction | null {
  if (!drag || !target) return null;
  if (target.type === 'folder' && !folders.some(folder => folder.id === target.id)) return null;

  if (drag.type === 'worktree') {
    if (!worktreeIds.has(drag.id)) return null;
    const folderId = target.type === 'folder' ? target.id : null;
    if (getWorkspaceFolderId(folders, drag.id) === folderId) return null;
    return { type: 'move-worktree', worktreeId: drag.id, folderId };
  }

  if (target.type !== 'folder' || drag.id === target.id) return null;
  const folderIds = folders.map(folder => folder.id);
  if (!folderIds.includes(drag.id)) return null;
  const reordered = folderIds.filter(id => id !== drag.id);
  const index = reordered.indexOf(target.id) + (target.placement === 'after' ? 1 : 0);
  reordered.splice(index, 0, drag.id);
  return reordered.every((id, position) => id === folderIds[position])
    ? null
    : { type: 'reorder-folders', folderIds: reordered };
}

export function getCollapsedWorkspaceFoldersStorageKey(
  userId: string,
  organizationId?: string
): string {
  return `cloud-workspace-folders:collapsed:${encodeURIComponent(userId)}:${organizationId ? `org:${encodeURIComponent(organizationId)}` : 'personal'}`;
}

export function parseCollapsedWorkspaceFolders(value: string): string[] {
  try {
    const parsed = collapsedFolderIdsSchema.safeParse(JSON.parse(value));
    return parsed.success ? [...new Set(parsed.data)] : [];
  } catch {
    return [];
  }
}
