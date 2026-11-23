import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';

/** What one artifact list read answers. */
type ListWorkspaceArtifacts =
  inferRouterOutputs<MobileRouter>['cloudAgentNext']['listWorkspaceArtifacts'];

/** One saved file, typed from the procedure rather than copied by hand. */
export type WorkspaceArtifactEntry = ListWorkspaceArtifacts['entries'][number];

/** One folder of saved files: the directory, the label the sheet paints, and its files. */
export type WorkspaceArtifactFolder = {
  readonly directory: string;
  readonly label: string;
  readonly files: readonly WorkspaceArtifactEntry[];
};

/**
 * The files grouped by the folder that holds them, in the order the sheet
 * paints them: folders by directory, files by path. A file at the root has no
 * directory, so it keeps the empty directory and takes the caller's fallback
 * label — the copy belongs to the surface, not here.
 */
export function groupWorkspaceArtifactsByFolder(
  entries: readonly WorkspaceArtifactEntry[],
  rootLabel: string
): WorkspaceArtifactFolder[] {
  const groups = new Map<string, WorkspaceArtifactEntry[]>();
  for (const entry of entries) {
    const separator = entry.relativePath.lastIndexOf('/');
    const directory = separator === -1 ? '' : entry.relativePath.slice(0, separator);
    const existing = groups.get(directory);
    if (existing) {
      existing.push(entry);
    } else {
      groups.set(directory, [entry]);
    }
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([directory, files]) => ({
      directory,
      label: directory.length > 0 ? directory : rootLabel,
      files: [...files].sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
    }));
}

/** The last segment of a file's path, which is what a row paints. */
export function workspaceArtifactFileName(entry: Pick<WorkspaceArtifactEntry, 'relativePath'>) {
  return entry.relativePath.slice(entry.relativePath.lastIndexOf('/') + 1);
}

/**
 * The sandbox states whose files stay saved but stop syncing. The sheet says so
 * above the list instead of naming each state: a stopped, stopping or failed
 * sandbox all mean the same thing to a reader looking at saved files.
 */
const SANDBOX_NOT_RUNNING_STATUSES = {
  sleeping: true,
  stopping: true,
  error: true,
} satisfies Record<string, true>;

export function isSandboxNotRunning(status: string | null | undefined): boolean {
  return (
    status !== null && status !== undefined && Object.hasOwn(SANDBOX_NOT_RUNNING_STATUSES, status)
  );
}
