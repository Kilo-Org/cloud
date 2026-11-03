// Pure selector: derives the merge-state decision tree that drives the
// S8 merge section (and its unit tests). No React, no react-query, no
// expo modules, and NO icon library — the section/sheet components
// translate the `iconKind` strings into Lucide icons. Keeping the icon
// mapping out of this module lets the tests load in plain Node without
// pulling in lucide-react-native (whose ESM build uses `import.meta` in
// ways the repo's vitest setup doesn't transform).

import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { i18n } from '@/i18n';

export type PrMergeMethod = 'merge' | 'squash' | 'rebase';

type RouterOutputs = inferRouterOutputs<MobileRouter>;
export type PrOverviewDto = RouterOutputs['githubPrReview']['getPullRequest'];
// The repo settings the merge surfaces consume. Derived from the overview DTO;
// `viewerLogin` is carried on the wire but never read by mobile, so it is
// dropped here (keeping the existing test/mock object literals valid).
export type PrOverviewRepoSettings = Omit<PrOverviewDto['repo'], 'viewerLogin'>;

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
  /** Stable identifier the section uses to look up an icon (see pr-merge-icons.tsx). */
  iconKind: MergeBlockedReasonId;
  severity: MergeBlockedReasonSeverity;
  title: string;
  /**
   * What the title cannot say on its own: the action to take, or a nuance such
   * as a non-required check not blocking the merge. A reason whose title is
   * already the whole story leaves this out, so the row does not print the same
   * sentence twice.
   */
  detail?: string;
};

export type MergeBlockedReasonsArgs = {
  state: PrOverviewDto['state'];
  draft: PrOverviewDto['draft'];
  mergeable: PrOverviewDto['mergeable'];
  mergeableState: PrOverviewDto['mergeableState'];
  reviewDecision: PrOverviewDto['reviewDecision'];
  /**
   * How many check runs the Checks card counts as failed — the `failure`
   * rollup of the same `listChecks` read that card renders, or `null` when
   * that read has no answer (failed). A blocked PR names failing checks only
   * when that number is non-zero, so the panel and the card above it cannot
   * contradict each other.
   */
  failedCheckCount: number | null;
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
  };
}

function failingChecksReason(): MergeBlockedReason {
  return {
    id: 'failing-checks',
    iconKind: 'failing-checks',
    severity: 'destructive',
    title: i18n.t('prReview.merge.blocked.failingChecksTitle'),
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
 * The row for a block whose cause the overview cannot name itself: GitHub says
 * the PR cannot merge, yet neither the review decision nor the Checks card
 * shows the gate. Carries the raw state so the row still says where it came
 * from instead of hiding the block.
 */
function genericBlockedReason(mergeableState: string): MergeBlockedReason {
  return {
    id: 'unknown-state',
    iconKind: 'unknown-state',
    severity: 'warn',
    title: i18n.t('prReview.merge.blocked.notMergeableTitle'),
    detail: i18n.t('prReview.merge.blocked.notMergeableDetail', {
      state: mergeableState,
    }),
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
      // `blocked` names a branch-protection gate, not which one. Each row
      // below is read off its own data: the review decision for reviews, and
      // the Checks card's own failed-run count for checks, so a PR whose only
      // check passed never claims a failing check, and one whose read failed
      // falls back to the reported state instead of guessing.
      if (
        args.reviewDecision === 'REVIEW_REQUIRED' ||
        args.reviewDecision === 'CHANGES_REQUESTED'
      ) {
        push(requiredReviewsReason());
      }
      if (args.failedCheckCount !== null && args.failedCheckCount > 0) {
        push(failingChecksReason());
      }
      if (reasons.length === 0) {
        push(genericBlockedReason(args.mergeableState));
      }
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
      push(genericBlockedReason(args.mergeableState));
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

// The chip's own copy: the method name alone, which is what fits a pill. The
// long `methodLabels` sentence is the spoken label above.
const PR_MERGE_SHORT_LABEL_KEYS = {
  merge: 'prReview.merge.methods.merge',
  squash: 'prReview.merge.methods.squash',
  rebase: 'prReview.merge.methods.rebase',
} satisfies Record<AllowedMergeMethod, string>;

const PR_MERGE_DESCRIPTION_KEYS = {
  merge: 'prReview.merge.methodDescriptions.merge',
  squash: 'prReview.merge.methodDescriptions.squash',
  rebase: 'prReview.merge.methodDescriptions.rebase',
} satisfies Record<AllowedMergeMethod, string>;

export function prMergeLabel(method: AllowedMergeMethod): string {
  return i18n.t(PR_MERGE_LABEL_KEYS[method]);
}

export function prMergeShortLabel(method: AllowedMergeMethod): string {
  return i18n.t(PR_MERGE_SHORT_LABEL_KEYS[method]);
}

export function prMergeDescription(method: AllowedMergeMethod): string {
  return i18n.t(PR_MERGE_DESCRIPTION_KEYS[method]);
}

function isAllowedMergeMethod(value: string): value is AllowedMergeMethod {
  return value === 'merge' || value === 'squash' || value === 'rebase';
}

/**
 * The method name for a value that arrives on the wire (`lowercase` GitHub codes,
 * and whatever a provider sends). Prose that names the method interpolates this,
 * never the code itself; a value this build does not know is passed on exactly as
 * received.
 */
export function prMergeMethodName(method: string): string {
  const code = method.toLowerCase();
  return isAllowedMergeMethod(code) ? prMergeShortLabel(code) : method;
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
