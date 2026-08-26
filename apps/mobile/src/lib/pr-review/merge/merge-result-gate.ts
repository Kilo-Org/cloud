// Pure gate between the `mergePullRequest` server result and the
// sheet's success handling. The server returns a discriminated union
// of three shapes:
//
//   1. { merged: <boolean>; sha; branchDeleted: false }
//      — GitHub declined the merge (merged=false), or
//        the merge succeeded but the user did not ask for a branch
//        delete (cross-repo OR deleteBranch=false).
//   2. { merged: true; sha; branchDeleted: true }
//      — merged AND the best-effort branch delete succeeded.
//   3. { merged: true; sha; branchDeleted: false; branchDeleteError }
//      — merged but the best-effort branch delete failed.
//
// The sheet MUST celebrate (haptic + dismiss) only when the merge
// actually happened (`merged === true`). A `merged: false` response
// means GitHub did not perform the merge and the sheet must throw
// `MergeNotCompletedError` so React Query's `onError` and the
// sheet's classification effect can treat it as RETRYABLE (NOT
// terminal bad-request).
//
// A `branchDeleteError` on a merged result means the partial-success
// path: the user should see the success animation, the sheet should
// dismiss, and the PR review screen should surface a persistent
// "merged but branch delete failed" banner afterwards.
//
// NOTE: the type is intentionally permissive on the first variant
// (`merged: boolean`) to match the inferred tRPC return type — the
// server widens `merged = Boolean(response.data.merged)` and the
// subsequent branches only narrow the other fields.

import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';

import { MergeNotCompletedError } from './merge-result-error';

type RouterOutputs = inferRouterOutputs<MobileRouter>;

// The inferred `mergePullRequest` output simplifies to the two variants with
// `merged: boolean` / `merged: true` — the server's `branchDeleteError` variant
// is a structural subtype of the first, so declaration emit folds it away. The
// merge gate narrows on `'branchDeleteError' in result` to surface the
// merged-but-branch-delete-failed banner, so that variant is re-added
// explicitly; the base stays derived from the router so the two stable shapes
// cannot drift from the server contract.
export type MergePullRequestResult =
  | RouterOutputs['githubPrReview']['mergePullRequest']
  | { merged: true; sha: string; branchDeleted: false; branchDeleteError: string };

type MergeResultGate =
  | { kind: 'clean' }
  | { kind: 'partial'; reason: string }
  | { kind: 'incomplete' };

/**
 * Decide how the sheet should react to a `mergePullRequest` result.
 *
 * Returns `{ kind: 'clean' }` for an uneventful success,
 * `{ kind: 'partial', reason }` for a merged-but-branch-delete-failed
 * outcome, and `{ kind: 'incomplete' }` when GitHub did not perform
 * the merge.
 */
export function gateMergeResult(result: MergePullRequestResult): MergeResultGate {
  // `result.merged` is the union of `boolean | true` — a falsy value here
  // can only be `false` (GitHub declined the merge) since tRPC resolves
  // server-side booleans, so `!result.merged` is the right gate without
  // the eslint-flagged `!== true` literal compare.
  if (!result.merged) {
    return { kind: 'incomplete' };
  }
  // Same narrowing: `result.branchDeleted` is `true | false` after the
  // `merged` gate; truthy means the best-effort branch delete succeeded.
  if (result.branchDeleted) {
    return { kind: 'clean' };
  }
  // branchDeleted is false here. The server only sets `branchDeleteError`
  // when the user actually requested a delete AND it failed. The
  // cross-repo / not-requested paths leave it absent. The sheet
  // collapses both to "clean" (no banner) because the user did not
  // ask for a delete.
  if ('branchDeleteError' in result) {
    return { kind: 'partial', reason: result.branchDeleteError };
  }
  return { kind: 'clean' };
}

/**
 * Convenience wrapper: inspects `gateMergeResult` and either throws
 * `MergeNotCompletedError` (incomplete) or returns the gate decision.
 * The sheet uses this so the throw is co-located with the decision
 * logic that causes it.
 */
export function assertMergeResult(result: MergePullRequestResult): MergeResultGate {
  const gate = gateMergeResult(result);
  if (gate.kind === 'incomplete') {
    throw new MergeNotCompletedError({
      sha: result.sha,
    });
  }
  return gate;
}
