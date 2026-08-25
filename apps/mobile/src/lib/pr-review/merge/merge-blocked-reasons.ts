// Pure selector: derives the merge-state decision tree that drives the
// S8 merge section (and its unit tests). No React, no react-query, no
// expo modules, and NO icon library — the section/sheet components
// translate the `iconKind` strings into Lucide icons. Keeping the icon
// mapping out of this module lets the tests load in plain Node without
// pulling in lucide-react-native (whose ESM build uses `import.meta` in
// ways the repo's vitest setup doesn't transform).

import { i18n } from '@/i18n';

export type PrMergeMethod = 'merge' | 'squash' | 'rebase';
type PrReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;

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

type MergeBlockedReasonSeverity = 'info' | 'warn' | 'destructive';

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

function unknownReason(): MergeBlockedReason {
  return {
    id: 'unknown-state',
    iconKind: 'unknown-state',
    severity: 'warn',
    title: i18n.t('prReview.merge.blocked.unknownStateTitle'),
    detail: i18n.t('prReview.merge.blocked.unknownStateDetail'),
  };
}

function conflictsReason(): MergeBlockedReason {
  return {
    id: 'conflicts',
    iconKind: 'conflicts',
    severity: 'destructive',
    title: i18n.t('prReview.merge.blocked.conflictsTitle'),
    detail: i18n.t('prReview.merge.blocked.conflictsDetail'),
  };
}

function requiredReviewsReason(): MergeBlockedReason {
  return {
    id: 'required-reviews',
    iconKind: 'required-reviews',
    severity: 'warn',
    title: i18n.t('prReview.merge.blocked.requiredReviewsTitle'),
    detail: i18n.t('prReview.merge.blocked.requiredReviewsDetail'),
  };
}

function failingChecksReason(): MergeBlockedReason {
  return {
    id: 'failing-checks',
    iconKind: 'failing-checks',
    severity: 'destructive',
    title: i18n.t('prReview.merge.blocked.failingChecksTitle'),
    detail: i18n.t('prReview.merge.blocked.failingChecksDetail'),
  };
}

function unstableReason(): MergeBlockedReason {
  return {
    id: 'unstable-checks',
    iconKind: 'unstable-checks',
    severity: 'info',
    title: i18n.t('prReview.merge.blocked.unstableTitle'),
    detail: i18n.t('prReview.merge.blocked.unstableDetail'),
  };
}

function draftReason(): MergeBlockedReason {
  return {
    id: 'draft',
    iconKind: 'draft',
    severity: 'info',
    title: i18n.t('prReview.merge.blocked.draftTitle'),
    detail: i18n.t('prReview.merge.blocked.draftDetail'),
  };
}

function behindReason(allowUpdateBranch: boolean): MergeBlockedReason {
  return {
    id: 'behind',
    iconKind: 'behind',
    severity: 'warn',
    title: i18n.t('prReview.merge.blocked.behindTitle'),
    detail: allowUpdateBranch
      ? i18n.t('prReview.merge.blocked.behindDetailUpdatable')
      : i18n.t('prReview.merge.blocked.behindDetail'),
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
      push(conflictsReason());
      break;
    }
    case 'blocked': {
      push(requiredReviewsReason());
      push(failingChecksReason());
      break;
    }
    case 'behind': {
      push(behindReason(args.allowUpdateBranch));
      break;
    }
    case 'unstable': {
      push(unstableReason());
      break;
    }
    case 'draft': {
      push(draftReason());
      break;
    }
    case 'clean': {
      if (args.mergeable === false) {
        push(unknownReason());
      }
      break;
    }
    case 'unknown':
    case null: {
      push(unknownReason());
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
        title: i18n.t('prReview.merge.blocked.notMergeableTitle'),
        detail: i18n.t('prReview.merge.blocked.notMergeableDetail', {
          state: args.mergeableState,
        }),
      });
    }
  }

  if (args.reviewDecision === 'REVIEW_REQUIRED' && args.mergeableState !== 'blocked') {
    push(requiredReviewsReason());
  }

  if (args.draft && args.mergeableState !== 'draft') {
    push(draftReason());
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

// Literal keys, never a template: the catalog check scans the source for the
// keys a lookup passes on, and a computed key is invisible to it.
const PR_MERGE_LABEL_KEYS = {
  merge: 'prReview.merge.methodLabels.merge',
  squash: 'prReview.merge.methodLabels.squash',
  rebase: 'prReview.merge.methodLabels.rebase',
} satisfies Record<AllowedMergeMethod, string>;

const PR_MERGE_DESCRIPTION_KEYS = {
  merge: 'prReview.merge.methodDescriptions.merge',
  squash: 'prReview.merge.methodDescriptions.squash',
  rebase: 'prReview.merge.methodDescriptions.rebase',
} satisfies Record<AllowedMergeMethod, string>;

export function prMergeLabel(method: AllowedMergeMethod): string {
  return i18n.t(PR_MERGE_LABEL_KEYS[method]);
}

export function prMergeDescription(method: AllowedMergeMethod): string {
  return i18n.t(PR_MERGE_DESCRIPTION_KEYS[method]);
}

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
