import type { WorktreeChangesSnapshot } from '@kilocode/worker-utils/cloud-agent-worktree-changes';
import { z } from 'zod';
import {
  MAX_WORKTREE_CHANGES_BYTES,
  MAX_WORKTREE_CHANGES_FILES,
  MAX_WORKTREE_SNAPSHOT_BYTES,
  worktreeSnapshotCaptureSchema,
  type WorktreeSnapshotCapture,
} from './worktree-changes-wire.js';
import { pathBelowCwd, rootPathPrefix } from './environment-workspace.js';

/**
 * The worktree snapshot of a V2 route: one capture for each repository, each
 * with repository-relative paths and its own comparison. The wrapper answers a
 * V2 route's `worktree.snapshot` with this, where a V1 route gets a bare
 * `worktreeSnapshotCaptureSchema`.
 */
export const MAX_WORKTREE_REPOSITORIES = 100;

export const groupedWorktreeSnapshotSchema = z
  .object({
    repositories: z
      .array(
        z
          .object({
            /** The git root of the repository, an absolute path inside the route directory. */
            directory: z.string().min(1).max(1024),
            repoFullName: z.string().min(1).max(500),
            capture: worktreeSnapshotCaptureSchema,
          })
          .strict()
      )
      .min(1)
      .max(MAX_WORKTREE_REPOSITORIES),
  })
  .strict()
  .refine(
    grouped =>
      new TextEncoder().encode(JSON.stringify(grouped)).byteLength <= MAX_WORKTREE_SNAPSHOT_BYTES,
    'Worktree snapshots exceed the size limit'
  );

export type GroupedWorktreeSnapshot = z.infer<typeof groupedWorktreeSnapshotSchema>;

const encoded = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;

/** A repository of the route, as the control plane knows it. */
export type RouteRepository = { directory: string; repoFullName: string; launch: boolean };

type SavedRepositories = NonNullable<WorktreeChangesSnapshot['repositories']>;

/** What a wrapper reported for a route, as it is saved: `repositories` is only there for a V2 route. */
export type ReportedSnapshot = {
  capture: WorktreeSnapshotCapture;
  repositories?: SavedRepositories;
};

/**
 * The saved form of a grouped snapshot: one flat list whose paths are relative
 * to the route directory (`web/src/a.ts`), so a path still names a single file
 * and every consumer of the saved snapshot keeps working, plus the identity and
 * comparison of each repository. The top-level comparison is the launch
 * repository's. Files past the saved limits are left out and the repository
 * that lost them is marked truncated, as a single repository's capture is.
 *
 * Returns `null` when the repositories disagree on the revision, or when one is
 * not a repository of the route. The repository name comes from the route, not
 * from the wrapper.
 */
export function flattenGroupedSnapshot(
  grouped: GroupedWorktreeSnapshot,
  cwd: string,
  route: readonly RouteRepository[]
): ReportedSnapshot | null {
  const [first] = grouped.repositories;
  if (first === undefined) return null;
  const { revision } = first.capture.summary;
  if (grouped.repositories.some(group => group.capture.summary.revision !== revision)) return null;
  const entries: Array<{
    group: GroupedWorktreeSnapshot['repositories'][number];
    member: RouteRepository;
    identity: SavedRepositories[number];
  }> = [];
  for (const group of grouped.repositories) {
    const member = route.find(candidate => candidate.directory === group.directory);
    if (member === undefined) return null;
    // `truncated` is set here for the size estimate below; the loop sets the real value.
    const identity = {
      path: rootPathPrefix(cwd, group.directory),
      repoFullName: member.repoFullName,
      comparison: group.capture.summary.comparison,
      truncated: true,
    };
    entries.push({ group, member, identity });
  }
  const comparisonSource =
    (entries.find(entry => entry.member.launch) ?? entries[0])?.group ?? first;

  const summaryFiles: WorktreeSnapshotCapture['summary']['files'] = [];
  const files: WorktreeSnapshotCapture['files'] = [];
  const repositories: SavedRepositories = [];
  // The repositories are saved with the summary, so their bytes count against its limit.
  let summaryBytes = encoded({
    ...first.capture.summary,
    files: [],
    repositories: entries.map(entry => entry.identity),
  });
  let snapshotBytes = 0;
  let full = false;
  for (const { group, identity } of entries) {
    const prefix = identity.path;
    const records = new Map(group.capture.files.map(record => [record.path, record]));
    let truncated = group.capture.summary.truncated;
    for (const listed of group.capture.summary.files) {
      const record = records.get(listed.path);
      if (record === undefined) return null;
      if (full) {
        truncated = true;
        continue;
      }
      const summaryFile = { ...listed, path: pathBelowCwd(prefix, listed.path) };
      const fileRecord = { ...record, path: summaryFile.path };
      const summaryCost = encoded(summaryFile) + 1;
      const recordCost = encoded(fileRecord);
      if (
        summaryFiles.length >= MAX_WORKTREE_CHANGES_FILES ||
        summaryBytes + summaryCost > MAX_WORKTREE_CHANGES_BYTES ||
        snapshotBytes + recordCost > MAX_WORKTREE_SNAPSHOT_BYTES
      ) {
        truncated = true;
        full = true;
        continue;
      }
      summaryBytes += summaryCost;
      snapshotBytes += recordCost;
      summaryFiles.push(summaryFile);
      files.push(fileRecord);
    }
    repositories.push({ ...identity, truncated });
  }
  return {
    capture: {
      summary: {
        ...first.capture.summary,
        comparison: comparisonSource.capture.summary.comparison,
        files: summaryFiles,
        truncated: repositories.some(repository => repository.truncated),
      },
      files,
    },
    repositories,
  };
}

/**
 * The snapshot a wrapper reported for a route, as the saved form. A V1 route
 * (`route` is `undefined`) reports a bare capture, which has no `repositories`.
 * A V2 route reports a grouped one, which is flattened below the route directory.
 * `null` when the result is not the form the route reports.
 */
export function parseReportedSnapshot(
  result: unknown,
  cwd: string,
  route: readonly RouteRepository[] | undefined
): ReportedSnapshot | null {
  if (route === undefined) {
    const bare = worktreeSnapshotCaptureSchema.safeParse(result);
    return bare.success ? { capture: bare.data } : null;
  }
  const grouped = groupedWorktreeSnapshotSchema.safeParse(result);
  return grouped.success ? flattenGroupedSnapshot(grouped.data, cwd, route) : null;
}
