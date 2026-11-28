import type { ReviewFailureReason } from './api';
import type { GithubClient, Review, TreeEntry } from './github';
import { MIGRATION_CODE_OWNERS } from './owners';

/**
 * The owner-approval check (contract §5 step 5): every migration path that changed since the
 * review base must be the exact blob a pinned code owner, other than the PR's author, approved in
 * the PR that last changed it. GitHub keeps an approval after a later push; this closes that gap
 * for the migrations folder only.
 */

export const MIGRATIONS_DIR = 'packages/db/src/migrations';

/** One changed path and its blob at the run's commit; null when the change deleted it. */
export type ChangedPath = { path: string; blob: string | null };

export type PathPassed = { path: string; blob: string | null; pr: number; approver: string };
export type PathFailed = {
  path: string;
  blob: string | null;
  reason: ReviewFailureReason;
  pr: number | null;
};

/** Remembers paths that passed, by `(path, blob)`; a failed path is always checked again. */
export type VerdictCache = {
  passed(path: string, blob: string | null): { pr: number; approver: string } | null;
  savePassed(verdict: PathPassed): void;
};

/** A tree read that answers null for a tree that does not exist. */
export type TreeReader = (sha: string) => Promise<TreeEntry[] | null>;

/** The sha of the tree at `path` (slash-separated) below the root tree of `commit`, or null. */
export async function subtreeSha(
  read: TreeReader,
  commit: string,
  path: string
): Promise<string | null> {
  let current: string = commit;
  for (const name of path.split('/')) {
    const entries = await read(current);
    const next = entries?.find(entry => entry.name === name && entry.type === 'tree');
    if (next === undefined) return null;
    current = next.sha;
  }
  return current;
}

/**
 * Every blob path that differs between two trees, from `head`'s side: added and changed paths
 * with their blob at `head`, deleted ones with null. Subtrees with the same sha are skipped
 * without reading them, so an unchanged `meta/` costs nothing.
 */
export async function changedPaths(
  read: TreeReader,
  prefix: string,
  head: string | null,
  base: string | null
): Promise<ChangedPath[]> {
  if (head === base) return [];
  const [headEntries, baseEntries] = await Promise.all([
    head === null ? [] : read(head),
    base === null ? [] : read(base),
  ]);
  const byName = (entries: TreeEntry[] | null) =>
    new Map((entries ?? []).map(entry => [entry.name, entry]));
  const headMap = byName(headEntries);
  const baseMap = byName(baseEntries);
  const changes: ChangedPath[] = [];
  for (const name of [...new Set([...headMap.keys(), ...baseMap.keys()])].sort()) {
    const atHead = headMap.get(name);
    const atBase = baseMap.get(name);
    const path = `${prefix}/${name}`;
    if (atHead?.type === 'tree' || atBase?.type === 'tree') {
      changes.push(
        ...(await changedPaths(
          read,
          path,
          atHead?.type === 'tree' ? atHead.sha : null,
          atBase?.type === 'tree' ? atBase.sha : null
        ))
      );
    }
    const headBlob = atHead?.type === 'blob' ? atHead.sha : null;
    const baseBlob = atBase?.type === 'blob' ? atBase.sha : null;
    if (headBlob !== baseBlob) changes.push({ path, blob: headBlob });
  }
  return changes;
}

const REVOKING_STATES = new Set(['CHANGES_REQUESTED', 'DISMISSED']);

/** Approvals by pinned owners (by user id) that no later review by the same owner revoked. */
function standingOwnerApprovals(reviews: readonly Review[]): Review[] {
  return reviews.filter(
    (review, index) =>
      review.state === 'APPROVED' &&
      MIGRATION_CODE_OWNERS.some(owner => owner.id === review.userId) &&
      !reviews
        .slice(index + 1)
        .some(later => later.userId === review.userId && REVOKING_STATES.has(later.state))
  );
}

async function checkPath(
  github: GithubClient,
  sha: string,
  change: ChangedPath
): Promise<PathPassed | PathFailed> {
  const fail = (reason: ReviewFailureReason, pr: number | null): PathFailed => ({
    ...change,
    reason,
    pr,
  });
  const commit = await github.lastCommitTouching(sha, change.path);
  if (commit === null) return fail('no_pr', null);
  const merged = (await github.pullsOfCommit(commit)).filter(
    pull => pull.mergedAt !== null && pull.baseRef === 'main'
  );
  if (merged.length === 0) return fail('no_pr', null);
  if (merged.length > 1) return fail('ambiguous_pr', null);
  const pull = merged[0];
  const standing = standingOwnerApprovals(await github.reviews(pull.number));
  const byOthers = standing.filter(review => review.userId !== pull.authorId);
  for (const review of byOthers) {
    if (review.commitId === null) continue;
    if ((await github.blobAt(review.commitId, change.path)) === change.blob) {
      const approver = MIGRATION_CODE_OWNERS.find(owner => owner.id === review.userId)?.login ?? '';
      return { ...change, pr: pull.number, approver };
    }
  }
  if (byOthers.length > 0) return fail('approval_on_other_blob', pull.number);
  if (standing.length > 0) return fail('author_only', pull.number);
  return fail('no_owner_approval', pull.number);
}

/**
 * Checks every changed path, reusing remembered passes. GitHub being unavailable propagates, so
 * the caller retries later; the passes found so far stay remembered.
 */
export async function reviewChanges(
  github: GithubClient,
  verdicts: VerdictCache,
  sha: string,
  changes: readonly ChangedPath[]
): Promise<{ passed: PathPassed[]; failed: PathFailed[] }> {
  const passed: PathPassed[] = [];
  const failed: PathFailed[] = [];
  for (const change of changes) {
    const remembered = verdicts.passed(change.path, change.blob);
    if (remembered !== null) {
      passed.push({ ...change, ...remembered });
      continue;
    }
    const verdict = await checkPath(github, sha, change);
    if ('approver' in verdict) {
      verdicts.savePassed(verdict);
      passed.push(verdict);
    } else {
      failed.push(verdict);
    }
  }
  return { passed, failed };
}
