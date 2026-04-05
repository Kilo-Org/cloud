export type PullRequestCheckoutRef = {
  checkoutRef: string;
  isForkPr: boolean;
  headRepoFullName: string | null;
};

export type PullRequestCheckoutRefInput = {
  pull_request: {
    number: number;
    head: {
      ref: string;
      repo?: {
        full_name: string;
      } | null;
    };
  };
  repository: {
    full_name: string;
  };
};

/**
 * Resolve which git ref should be checked out for a PR review.
 *
 * - Same-repo PRs: use head.ref (e.g. "feature/my-change")
 * - Fork PRs: use GitHub's synthetic pull ref (e.g. "refs/pull/123/head")
 */
export function resolvePullRequestCheckoutRef(
  payload: PullRequestCheckoutRefInput
): PullRequestCheckoutRef {
  const headRepoFullName = payload.pull_request.head.repo?.full_name ?? null;
  const isForkPr = headRepoFullName !== null && headRepoFullName !== payload.repository.full_name;
  const checkoutRef = isForkPr
    ? `refs/pull/${payload.pull_request.number}/head`
    : payload.pull_request.head.ref;

  return {
    checkoutRef,
    isForkPr,
    headRepoFullName,
  };
}
