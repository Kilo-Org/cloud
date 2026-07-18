// Pure selector: derives the merge-state decision tree that drives the
// S8 merge section (and its unit tests). No React, no react-query, no
// expo modules, and NO icon library — the section/sheet components
// translate the `iconKind` strings into Lucide icons. Keeping the icon
// mapping out of this module lets the tests load in plain Node without
// pulling in lucide-react-native (whose ESM build uses `import.meta` in
// ways the repo's vitest setup doesn't transform).

export type PrMergeMethod = 'merge' | 'squash' | 'rebase';
export type PrReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;

export type PrOverviewRepoSettings = {
  allowMergeCommit: boolean;
  allowSquashMerge: boolean;
  allowRebaseMerge: boolean;
  allowAutoMerge: boolean;
  deleteBranchOnMerge: boolean;
  allowUpdateBranch: boolean;
  viewerCanPush: boolean;
  viewerCanAdmin: boolean;
};

export type PrOverviewDto = {
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  baseRef: string;
  headRef: string;
  isCrossRepo: boolean;
  headSha: string;
  prNodeId: string;
  title: string;
  bodyMarkdown: string | null;
  number: number;
  mergeable: boolean | null;
  mergeableState: string | null;
  autoMerge: { method: string } | null;
  reviewDecision: PrReviewDecision;
  repo: PrOverviewRepoSettings;
};

type MergeabilityStatus = 'unknown' | 'blocked' | 'mergeable' | 'terminal';

export type MergeBlockedReasonId =
  | 'conflicts'
  | 'required-reviews'
  | 'failing-checks'
  | 'behind'
  | 'unstable-checks'
  | 'draft'
  | 'unknown-state';

export type MergeBlockedReasonSeverity = 'info' | 'warn' | 'destructive';

export type MergeBlockedReason = {
  id: MergeBlockedReasonId;
  /** Stable identifier the section uses to look up an icon (see pr-merge-icons.ts). */
  iconKind: MergeBlockedReasonId;
  severity: MergeBlockedReasonSeverity;
  title: string;
  detail: string;
};

export type MergeBlockedReasonsArgs = {
  state: PrOverviewDto['state'];
  draft: PrOverviewDto['draft'];
  mergeable: PrOverviewDto['mergeable'];
  mergeableState: PrOverviewDto['mergeableState'];
  reviewDecision: PrReviewDecision;
  allowUpdateBranch: boolean;
};

/**
 * High-level mergeability status the section uses to pick which UI to
 * render. `unknown` covers the brief window after GitHub queues a
 * mergeability re-check; the section polls the overview in that case.
 * `terminal` means the PR is closed/merged and no further action exists.
 */
export function getMergeabilityStatus(args: {
  state: PrOverviewDto['state'];
  mergeable: PrOverviewDto['mergeable'];
  mergeableState: PrOverviewDto['mergeableState'];
}): MergeabilityStatus {
  if (args.state !== 'open') {
    return 'terminal';
  }
  if (
    args.mergeable === null ||
    args.mergeableState === null ||
    args.mergeableState === 'unknown'
  ) {
    return 'unknown';
  }
  if (args.mergeable && args.mergeableState === 'clean') {
    return 'mergeable';
  }
  return 'blocked';
}

const UNKNOWN_REASON: MergeBlockedReason = {
  id: 'unknown-state',
  iconKind: 'unknown-state',
  severity: 'warn',
  title: "GitHub hasn't reported a mergeable state",
  detail: 'Try refreshing the overview in a moment.',
};

const CONFLICTS_REASON: MergeBlockedReason = {
  id: 'conflicts',
  iconKind: 'conflicts',
  severity: 'destructive',
  title: 'Merge conflicts',
  detail: 'Resolve the merge conflicts on this branch before merging.',
};

const REQUIRED_REVIEWS_REASON: MergeBlockedReason = {
  id: 'required-reviews',
  iconKind: 'required-reviews',
  severity: 'warn',
  title: 'Required reviews missing',
  detail: 'Approvals from the required reviewers are missing or pending.',
};

const FAILING_CHECKS_REASON: MergeBlockedReason = {
  id: 'failing-checks',
  iconKind: 'failing-checks',
  severity: 'destructive',
  title: 'Failing required checks',
  detail: 'Required status checks are failing.',
};

const UNSTABLE_REASON: MergeBlockedReason = {
  id: 'unstable-checks',
  iconKind: 'unstable-checks',
  severity: 'info',
  title: 'Some checks are failing',
  detail: 'Non-required checks are failing. They will not block the merge.',
};

const DRAFT_REASON: MergeBlockedReason = {
  id: 'draft',
  iconKind: 'draft',
  severity: 'info',
  title: 'Draft pull request',
  detail: 'Mark the pull request as ready for review before merging.',
};

function behindReason(allowUpdateBranch: boolean): MergeBlockedReason {
  return {
    id: 'behind',
    iconKind: 'behind',
    severity: 'warn',
    title: 'Branch is out of date',
    detail: allowUpdateBranch
      ? 'Update the branch from the base, or rebase, before merging.'
      : 'The head branch is behind the base. Rebase or update the branch before merging.',
  };
}

/**
 * Ordered, deduplicated list of why-this-PR-can't-be-merged-yet reasons.
 * Empty when the PR is mergeable. Order: most specific / most actionable
 * first — GitHub's `mergeable_state` wins as the top reason when it
 * fires, then reviews, then draft.
 */
export function getMergeBlockedReasons(args: MergeBlockedReasonsArgs): MergeBlockedReason[] {
  if (args.state !== 'open') {
    return [];
  }
  const reasons: MergeBlockedReason[] = [];
  const seen = new Set<MergeBlockedReasonId>();

  const push = (reason: MergeBlockedReason) => {
    if (seen.has(reason.id)) {
      return;
    }
    seen.add(reason.id);
    reasons.push(reason);
  };

  switch (args.mergeableState) {
    case 'dirty': {
      push(CONFLICTS_REASON);
      break;
    }
    case 'blocked': {
      push(REQUIRED_REVIEWS_REASON);
      push(FAILING_CHECKS_REASON);
      break;
    }
    case 'behind': {
      push(behindReason(args.allowUpdateBranch));
      break;
    }
    case 'unstable': {
      push(UNSTABLE_REASON);
      break;
    }
    case 'draft': {
      push(DRAFT_REASON);
      break;
    }
    case 'clean': {
      if (args.mergeable === false) {
        push(UNKNOWN_REASON);
      }
      break;
    }
    case 'unknown':
    case null: {
      push(UNKNOWN_REASON);
      break;
    }
    default: {
      // GitHub may add new mergeable_state values over time — surface the
      // raw value as a generic blocked reason rather than silently
      // showing nothing.
      push({
        id: 'unknown-state',
        iconKind: 'unknown-state',
        severity: 'warn',
        title: 'This pull request is not mergeable yet',
        detail: `GitHub reported a "${args.mergeableState}" mergeable state.`,
      });
    }
  }

  if (args.reviewDecision === 'REVIEW_REQUIRED' && args.mergeableState !== 'blocked') {
    push(REQUIRED_REVIEWS_REASON);
  }

  if (args.draft && args.mergeableState !== 'draft') {
    push(DRAFT_REASON);
  }

  return reasons;
}

export type AllowedMergeMethod = PrMergeMethod;

/**
 * Repo-allowed merge methods, in the order the picker should show them.
 * Squashes and merges are the two defaults; rebase is rare but still
 * honored when enabled.
 */
export function getAllowedMergeMethods(repo: PrOverviewRepoSettings): AllowedMergeMethod[] {
  const methods: AllowedMergeMethod[] = [];
  if (repo.allowMergeCommit) {
    methods.push('merge');
  }
  if (repo.allowSquashMerge) {
    methods.push('squash');
  }
  if (repo.allowRebaseMerge) {
    methods.push('rebase');
  }
  return methods;
}

export const PR_MERGE_LABELS: Record<AllowedMergeMethod, string> = {
  merge: 'Create a merge commit',
  squash: 'Squash and merge',
  rebase: 'Rebase and merge',
};

export const PR_MERGE_DESCRIPTIONS: Record<AllowedMergeMethod, string> = {
  merge: 'Combine all commits from this branch into the base branch with a merge commit.',
  squash: 'Combine all commits from this branch into a single commit on the base branch.',
  rebase: 'Replay all commits from this branch onto the base branch without a merge commit.',
};

/** The default method the picker selects on first open. */
export function defaultMergeMethodFor(repo: PrOverviewRepoSettings): AllowedMergeMethod {
  const allowed = getAllowedMergeMethods(repo);
  // The server should never return a PR with no allowed methods, but if
  // it does we still need a stable default for the form state.
  if (allowed.length === 0) {
    return 'merge';
  }
  const first = allowed[0];
  return first ?? 'merge';
}
