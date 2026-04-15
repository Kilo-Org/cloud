export type MergeRequestCheckoutRef = {
  checkoutRef: string;
  isForkMr: boolean;
};

export type MergeRequestCheckoutRefInput = {
  object_attributes: {
    iid: number;
    source_branch: string;
    source_project_id: number;
    target_project_id: number;
  };
};

/**
 * Resolve which git ref should be checked out for a GitLab MR review.
 *
 * - Same-project MRs: use source_branch (e.g. "feature/my-change")
 * - Fork MRs: use GitLab's synthetic merge-request ref (e.g. "refs/merge-requests/123/head")
 */
export function resolveMergeRequestCheckoutRef(
  payload: MergeRequestCheckoutRefInput
): MergeRequestCheckoutRef {
  const mr = payload.object_attributes;
  const isForkMr = mr.source_project_id !== mr.target_project_id;
  const checkoutRef = isForkMr ? `refs/merge-requests/${mr.iid}/head` : mr.source_branch;

  return {
    checkoutRef,
    isForkMr,
  };
}
