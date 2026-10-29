import path from 'node:path';
import { pathBelowCwd, rootPathPrefix } from '../../../src/shared/environment-workspace.js';
import type { WorktreeRecovery } from '../../../src/shared/worktree-changes-wire.js';
import { rootForPath } from '../restore-roots.js';
import type { RestoreDiffSkip } from '../restore-session.js';
import type { restoreWorktreeRecovery } from './worktree-recovery.js';
import type { RouteRoot } from './workspace-roots.js';

export type RootRecoveryDiffs = {
  applied: number;
  skipped: number;
  total: number;
  skippedDiffs: RestoreDiffSkip[];
};

/** The report keeps this many skipped files, as the one-root restore does. */
const MAX_SKIPPED_DIFFS = 100;

type RootRecovery = { root: RouteRoot; recovery: WorktreeRecovery };

/**
 * Splits the saved changes of a route by repository. A saved path is relative
 * to the Kilo cwd, so it starts with its repository's directory below the cwd
 * (`web/src/a.ts`); the patch of the file is relative to the repository and is
 * not touched. A route with one root, or a path in no root, keeps the saved
 * form: a V1 route restores exactly what it saved.
 */
function splitRecovery(
  cwd: string,
  roots: readonly RouteRoot[],
  recovery: WorktreeRecovery
): { perRoot: RootRecovery[]; unrouted: WorktreeRecovery['files'] } {
  const [only] = roots;
  if (only !== undefined && roots.length === 1 && rootPathPrefix(cwd, only.directory) === '') {
    return { perRoot: [{ root: only, recovery }], unrouted: [] };
  }
  const directories = roots.map(root => root.directory);
  const files = new Map<string, WorktreeRecovery['files']>(
    roots.map(root => [path.resolve(root.directory), []])
  );
  const unrouted: WorktreeRecovery['files'] = [];
  for (const file of recovery.files) {
    // A saved path is relative to the cwd; the longest root that contains it owns it.
    const absolute = path.resolve(cwd, file.path);
    const owner = rootForPath(directories, absolute);
    if (owner === undefined || absolute === owner) unrouted.push(file);
    else files.get(owner)?.push({ ...file, path: absolute.slice(owner.length + 1) });
  }
  return {
    perRoot: roots.map(root => ({
      root,
      recovery: { files: files.get(path.resolve(root.directory)) ?? [] },
    })),
    unrouted,
  };
}

/**
 * Restores the saved changes of each root with that root's own repository-
 * relative paths and patches. `onRoot` reports each root as soon as it is
 * restored, so ingest restoration does not overwrite it with older diffs. A root
 * with nothing to restore counts as restored. Each root has its own signal, and
 * a root that fails does not stop the others. After the last root, the first
 * failure propagates, so the caller sees a pass that did not finish.
 */
export async function restoreRootRecoveries(input: {
  cwd: string;
  roots: readonly RouteRoot[];
  recovery: WorktreeRecovery;
  env: NodeJS.ProcessEnv;
  /** Gives one root its own time limit. */
  rootSignal: () => AbortSignal;
  restore: typeof restoreWorktreeRecovery;
  onRoot: (directory: string, recovered: boolean) => void;
}): Promise<RootRecoveryDiffs> {
  const { perRoot, unrouted } = splitRecovery(input.cwd, input.roots, input.recovery);
  const totals: RootRecoveryDiffs = {
    applied: 0,
    skipped: unrouted.length,
    total: unrouted.length,
    skippedDiffs: unrouted
      .slice(0, MAX_SKIPPED_DIFFS)
      .map(file => ({ file: file.path, reason: 'outside_workspace' as const })),
  };
  const failures: unknown[] = [];
  for (const { root, recovery } of perRoot) {
    let diffs: RootRecoveryDiffs;
    try {
      diffs = await input.restore(root.directory, recovery, input.env, input.rootSignal());
    } catch (error) {
      failures.push(error);
      continue;
    }
    totals.applied += diffs.applied;
    totals.skipped += diffs.skipped;
    totals.total += diffs.total;
    const prefix = rootPathPrefix(input.cwd, root.directory);
    for (const skip of diffs.skippedDiffs) {
      if (totals.skippedDiffs.length >= MAX_SKIPPED_DIFFS) break;
      totals.skippedDiffs.push({
        ...skip,
        file: pathBelowCwd(prefix, skip.file),
      });
    }
    input.onRoot(root.directory, diffs.applied > 0 || diffs.total === 0);
  }
  if (failures.length > 0) throw failures[0];
  return totals;
}
