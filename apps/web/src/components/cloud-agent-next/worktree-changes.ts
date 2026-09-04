import type { QueryClient, QueryKey } from '@tanstack/react-query';
import {
  getWorktreeChangesOutputSchema,
  type GetWorktreeChangesOutput,
  type RefreshWorktreeChangesOutput,
  type WorktreeChangesSnapshot,
} from '@kilocode/worker-utils/cloud-agent-worktree-changes';

export type WorktreeChangesViewMode = 'flat' | 'tree';

export type WorktreeChangesFile = WorktreeChangesSnapshot['files'][number];

export type WorktreeChangesTreeNode =
  | {
      kind: 'directory';
      name: string;
      path: string;
      children: WorktreeChangesTreeNode[];
    }
  | {
      kind: 'file';
      name: string;
      path: string;
      file: WorktreeChangesFile;
    };

export function getWorktreeChangesTotals(
  snapshot: WorktreeChangesSnapshot | null | undefined
): { fileCount: number; additions: number; deletions: number; countsComplete: boolean } | null {
  if (!snapshot) return null;

  let additions = 0;
  let deletions = 0;
  let countsComplete = !snapshot.truncated;

  for (const file of snapshot.files) {
    if (file.binary) continue;
    additions += file.additions;
    deletions += file.deletions;
    countsComplete = countsComplete && file.countsComplete;
  }

  return { fileCount: snapshot.files.length, additions, deletions, countsComplete };
}

export function deserializeWorktreeChangesViewMode(value: string): WorktreeChangesViewMode {
  try {
    const mode: unknown = JSON.parse(value);
    return mode === 'flat' || mode === 'tree' ? mode : 'flat';
  } catch {
    return 'flat';
  }
}

export function groupWorktreeChangesByDirectory(
  files: readonly WorktreeChangesFile[]
): { directory: string; files: WorktreeChangesFile[] }[] {
  const directories = new Map<string, WorktreeChangesFile[]>();

  for (const file of files) {
    const separator = file.path.lastIndexOf('/');
    const directory = separator === -1 ? '' : file.path.slice(0, separator);
    const group = directories.get(directory);
    if (group) group.push(file);
    else directories.set(directory, [file]);
  }

  return Array.from(directories, ([directory, files]) => ({
    directory,
    files: files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  })).sort((a, b) => (a.directory < b.directory ? -1 : a.directory > b.directory ? 1 : 0));
}

export function formatWorktreeChangesBaseBranch(baseRef: string): string {
  return baseRef.replace(/^refs\/remotes\/[^/]+\//, '');
}

export function buildWorktreeChangesTree(
  files: readonly WorktreeChangesFile[]
): WorktreeChangesTreeNode[] {
  const tree: WorktreeChangesTreeNode[] = [];
  const directories = new Map<string, Extract<WorktreeChangesTreeNode, { kind: 'directory' }>>();

  for (const file of files) {
    const parts = file.path.split('/');
    let siblings = tree;
    let path = '';

    for (const [index, name] of parts.entries()) {
      if (index === parts.length - 1) {
        siblings.push({ kind: 'file', name, path: file.path, file });
        break;
      }

      path = index === 0 ? name : `${path}/${name}`;
      let directory = directories.get(path);
      if (!directory) {
        directory = { kind: 'directory', name, path, children: [] };
        directories.set(path, directory);
        siblings.push(directory);
      }
      siblings = directory.children;
    }
  }

  const compareNodes = (a: WorktreeChangesTreeNode, b: WorktreeChangesTreeNode): number => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  };

  tree.sort(compareNodes);
  for (const directory of directories.values()) {
    directory.children.sort(compareNodes);
  }
  return tree;
}

export function canOpenWorktreeChanges(
  cloudAgentSessionId: string | null | undefined,
  isReadOnly: boolean
): boolean {
  return !isReadOnly && cloudAgentSessionId?.startsWith('workspace_') === true;
}

export function preserveNewerWorktreeChanges(
  previous: unknown,
  incoming: unknown
): GetWorktreeChangesOutput {
  const next = getWorktreeChangesOutputSchema.parse(incoming);
  const current =
    previous === undefined ? undefined : getWorktreeChangesOutputSchema.parse(previous);
  if (
    current?.snapshot &&
    (!next.snapshot || current.snapshot.revision >= next.snapshot.revision)
  ) {
    return current;
  }
  return next;
}

export function createWorktreeChangesRefresher(queryClient: QueryClient, queryKey: QueryKey) {
  const filters = { queryKey, exact: true };
  let pending: { revision: number; force: boolean } | undefined;
  let inFlight: Promise<void> | undefined;
  let activeRevision: number | undefined;
  let disposed = false;

  async function drain(): Promise<void> {
    try {
      await queryClient.cancelQueries(filters, { silent: true, revert: false });
      while (!disposed && pending) {
        const request = pending;
        pending = undefined;
        const cached = queryClient.getQueryData<GetWorktreeChangesOutput>(queryKey);
        if (!request.force && (cached?.snapshot?.revision ?? 0) >= request.revision) continue;
        activeRevision = request.revision;
        await queryClient.invalidateQueries(
          { ...filters, refetchType: 'active' },
          { cancelRefetch: false }
        );
        activeRevision = undefined;
      }
    } finally {
      activeRevision = undefined;
      inFlight = undefined;
    }
  }

  return {
    request(request: { revision: number; force: boolean }): Promise<void> {
      if (disposed) return Promise.resolve();
      pending = {
        revision: Math.max(pending?.revision ?? 0, request.revision),
        force: pending?.force === true || request.force,
      };
      if (activeRevision === 0 && request.revision > 0) {
        activeRevision = undefined;
        void queryClient.cancelQueries(filters, { silent: true, revert: false });
      }
      inFlight ??= drain();
      return inFlight;
    },
    dispose(): void {
      disposed = true;
      pending = undefined;
    },
  };
}

export function worktreeChangesMessages({
  snapshot,
  savedReadPending,
  savedReadFailed,
  refreshPending,
  refreshFailed,
  refreshStatus,
}: {
  snapshot: WorktreeChangesSnapshot | null | undefined;
  savedReadPending: boolean;
  savedReadFailed: boolean;
  refreshPending: boolean;
  refreshFailed: boolean;
  refreshStatus: RefreshWorktreeChangesOutput['status'] | undefined;
}): { notice: string | null; empty: string | null } {
  let notice: string | null = null;
  if (refreshPending) {
    notice = 'Refreshing…';
  } else if (refreshFailed || refreshStatus === 'failed') {
    notice = snapshot ? 'Refresh failed · showing saved changes.' : 'Refresh failed.';
  } else if (refreshStatus === 'offline') {
    notice = snapshot ? 'Offline · showing saved changes.' : 'Sandbox offline.';
  }

  if (snapshot) {
    return {
      notice: notice ?? (savedReadFailed ? 'Load failed · showing saved changes.' : null),
      empty: snapshot.files.length === 0 && !snapshot.truncated ? 'No changes.' : null,
    };
  }

  return {
    notice,
    empty: savedReadPending
      ? 'Loading saved changes…'
      : savedReadFailed
        ? 'Could not load saved changes.'
        : 'No saved changes yet.',
  };
}
