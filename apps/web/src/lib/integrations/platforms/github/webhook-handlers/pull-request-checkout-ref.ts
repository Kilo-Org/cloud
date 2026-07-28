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

export function getGitHubPullRequestCheckoutRef(prNumber: number): string {
  return `refs/pull/${prNumber}/head`;
}

/**
 * Resolve which git ref should be checked out for a PR review.
 *
 * GitHub keeps refs/pull/<number>/head available even when the source
 * branch is deleted after merge/close, so use it for both same-repo and fork PRs.
 */
export function resolvePullRequestCheckoutRef(
  payload: PullRequestCheckoutRefInput
): PullRequestCheckoutRef {
  const headRepoFullName = payload.pull_request.head.repo?.full_name ?? null;
  // A same-repo PR always carries `head.repo` (it is the base repo itself), so a missing/null
  // `head.repo` can only be a fork PR whose fork repo was deleted after the PR was opened (GitHub
  // allows this and nulls `head.repo`). Treat null as a fork: this is both accurate and fail-closed
  // for the security-sensitive `fork-pr` council exclusion that consumes this flag. Only an
  // explicit head repo equal to the base repo is treated as non-fork.
  const isForkPr = headRepoFullName !== payload.repository.full_name;
  const checkoutRef = getGitHubPullRequestCheckoutRef(payload.pull_request.number);

  return {
    checkoutRef,
    isForkPr,
    headRepoFullName,
  };
}
