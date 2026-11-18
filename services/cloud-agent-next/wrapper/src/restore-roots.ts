import path from 'node:path';

/**
 * Where each restored session diff is applied when a route has several git
 * roots (V2). A diff names a file by an absolute sandbox path, or by a path
 * relative to the Kilo cwd. It belongs to the root whose directory is a path
 * segment prefix of that file, so `/workspace/web` never owns
 * `/workspace/website/a.ts`. A route with no roots applies everything at its
 * workspace path, which is what a V1 route always did.
 */
export type RestoreRoots = {
  /** Git roots of the route. */
  directories: readonly string[];
  /** Roots whose files a newer saved worktree snapshot already restored. */
  recovered?: readonly string[];
};

export type RoutedDiff<Diff> = { diff: Diff; workspace: string };

export type RoutedDiffs<Diff> = {
  routed: RoutedDiff<Diff>[];
  /** Diffs whose file is in no root. */
  outside: Diff[];
  /** Diffs left alone because their root was recovered from a newer snapshot. */
  recoveredCount: number;
};

/** The longest root that contains `file`, matched by path segment. */
export function rootForPath(directories: readonly string[], file: string): string | undefined {
  let best: string | undefined;
  for (const directory of directories) {
    const root = path.resolve(directory);
    const contained = file === root || file.startsWith(root.endsWith('/') ? root : `${root}/`);
    if (contained && (best === undefined || root.length > best.length)) best = root;
  }
  return best;
}

export function routeRestoreDiffs<Diff extends { file: string }>(
  diffs: readonly Diff[],
  workspacePath: string,
  roots: RestoreRoots | undefined
): RoutedDiffs<Diff> {
  if (roots === undefined) {
    return {
      routed: diffs.map(diff => ({ diff, workspace: workspacePath })),
      outside: [],
      recoveredCount: 0,
    };
  }
  const recovered = new Set((roots.recovered ?? []).map(directory => path.resolve(directory)));
  const result: RoutedDiffs<Diff> = { routed: [], outside: [], recoveredCount: 0 };
  for (const diff of diffs) {
    // A relative file is relative to the Kilo cwd, not to the root it lands in.
    const file = path.resolve(workspacePath, diff.file);
    const root = rootForPath(roots.directories, file);
    if (root === undefined) result.outside.push(diff);
    else if (recovered.has(root)) result.recoveredCount++;
    else result.routed.push({ diff: { ...diff, file }, workspace: root });
  }
  return result;
}
