import type { SnapshotFileDiff } from '@kilocode/sdk/v2';
import {
  MAX_WORKTREE_SNAPSHOT_BYTES,
  worktreeChangesBaseRef,
  worktreeSnapshotCaptureSchema,
  type SessionGitSummaryPayload,
  type WorktreeSnapshotCapture,
} from '../../../src/shared/worktree-changes-wire.js';
import { pathBelowCwd } from '../../../src/shared/environment-workspace.js';
import type { GroupedWorktreeSnapshot } from '../../../src/shared/worktree-groups.js';
import { omittedRecord } from '../control/worktree-changes.js';
import { WorktreeFileCaptureError } from '../control/worktree-file-capture.js';
import { isEnvironmentRoot, type RouteRoot } from './workspace-roots.js';

/**
 * The comparison ref of one root. A root on a branch somebody requested compares
 * with that branch on the remote. A root on the generated branch compares with
 * the repository's default branch, which the capture resolves when it gets no
 * ref. A synthetic review ref is not a remote branch, so it also gets the default.
 */
export function rootBaseRef(root: RouteRoot): string | undefined {
  const { requestedBranch } = root;
  if (requestedBranch === undefined || requestedBranch.startsWith('refs/')) return undefined;
  return worktreeChangesBaseRef(requestedBranch);
}

export type CaptureRoot = (
  directory: string,
  payload: SessionGitSummaryPayload
) => Promise<WorktreeSnapshotCapture>;

/** Captures every root of a V2 route, each against its own base. One failing root fails the capture. */
export async function captureRootSnapshots(input: {
  roots: readonly RouteRoot[];
  revision: number;
  capture: CaptureRoot;
}): Promise<GroupedWorktreeSnapshot> {
  const repositories = await Promise.all(
    input.roots.map(async root => {
      if (!isEnvironmentRoot(root)) {
        throw new Error('A multi-repository route names every repository');
      }
      const baseRef = rootBaseRef(root);
      const capture = await input.capture(root.directory, {
        revision: input.revision,
        ...(baseRef === undefined ? {} : { baseRef }),
      });
      return { directory: root.directory, repoFullName: root.repoFullName, capture };
    })
  );
  return fitSnapshotBudget({ repositories });
}

const encodedBytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

/**
 * Keeps the grouped result inside the snapshot budget. Each repository's own
 * capture is bounded, but the total of several is not. A result that is too big
 * keeps its records in order while they fit, and the rest are omitted as
 * `budget_exhausted`, as one repository's capture does. The file lists stay.
 */
export function fitSnapshotBudget(
  grouped: GroupedWorktreeSnapshot,
  limit: number = MAX_WORKTREE_SNAPSHOT_BYTES
): GroupedWorktreeSnapshot {
  if (encodedBytes(grouped) <= limit) return grouped;
  const omitted = grouped.repositories.map(group => ({
    ...group,
    capture: {
      ...group.capture,
      files: group.capture.files.map(record =>
        omittedRecord(record.revision, record.path, 'budget_exhausted')
      ),
    },
  }));
  let total = encodedBytes({ repositories: omitted });
  for (const [repository, group] of grouped.repositories.entries()) {
    const kept = omitted[repository]?.capture.files;
    if (kept === undefined) continue;
    for (const [index, record] of group.capture.files.entries()) {
      const placeholder = kept[index];
      if (placeholder === undefined) continue;
      const next = total - encodedBytes(placeholder) + encodedBytes(record);
      if (next > limit) continue;
      total = next;
      kept[index] = record;
    }
  }
  return { repositories: omitted };
}

/**
 * Kilo's file diffs for one captured repository, from its bounded worktree
 * patches. `prefix` puts the repository's files below the Kilo cwd: `''` when
 * the repository is the cwd.
 */
export function snapshotFileDiffs(
  capture: WorktreeSnapshotCapture,
  prefix: string
): SnapshotFileDiff[] {
  const snapshot = worktreeSnapshotCaptureSchema.parse(capture);
  if (snapshot.summary.truncated) throw new WorktreeFileCaptureError('too_large');
  const records = new Map(snapshot.files.map(file => [file.path, file]));
  return snapshot.summary.files.map((file): SnapshotFileDiff => {
    const record = records.get(file.path);
    if (!record) throw new Error('Worktree diff is incomplete');
    if (record.diff.status === 'omitted' && record.diff.reason !== 'binary') {
      throw new WorktreeFileCaptureError(record.diff.reason);
    }
    return {
      file: pathBelowCwd(prefix, file.path),
      additions: file.additions,
      deletions: file.deletions,
      status: file.status,
      patch: record.diff.status === 'available' ? record.diff.patch : '',
    };
  });
}
