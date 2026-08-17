import { type AssociatedPrData } from '@kilocode/cloud-agent-sdk';

type ReviewDecision = NonNullable<AssociatedPrData['reviewDecision']>;

type PrBadgeState = 'open' | 'closed' | 'merged' | 'draft' | 'unknown';

export type PrBadgeIconKind = 'check' | 'x' | 'pull-request' | 'draft' | 'merge' | 'closed';

export type PrBadgeAccent = 'good' | 'warn' | 'muted' | 'destructive';

type PrBadgeDescriptor = Readonly<{
  icon: PrBadgeIconKind;
  accent: PrBadgeAccent;
  accessibilityLabel: string;
}>;

const STATE_ARIA_LABELS: Readonly<Record<PrBadgeState, string>> = {
  open: 'open pull request',
  closed: 'closed pull request',
  merged: 'merged pull request',
  draft: 'draft pull request',
  // Mobile keeps `unknown` on the open presentation (never mapped to closed),
  // so it speaks as an open PR.
  unknown: 'open pull request',
};

/**
 * Bucket a raw PR state string into a badge state. Unlike the web helper,
 * unrecognized states map to `unknown` (not `closed`) so the badge keeps the
 * neutral open presentation while the server resolves the real state.
 */
export function normalizePrBadgeState(state: string): PrBadgeState {
  if (state === 'merged') {
    return 'merged';
  }
  if (state === 'draft') {
    return 'draft';
  }
  if (state === 'open') {
    return 'open';
  }
  if (state === 'closed') {
    return 'closed';
  }
  return 'unknown';
}

/**
 * Resolve the badge icon and accent for a bucketed PR state. Extracted from
 * `describePrBadge` so `icon`/`accent` are assigned on declaration, satisfying
 * the `init-declarations` lint rule.
 */
function prBadgeVisual(
  stateBucket: PrBadgeState,
  reviewDecision: ReviewDecision | null,
  updating: boolean
): Pick<PrBadgeDescriptor, 'icon' | 'accent'> {
  if (stateBucket === 'merged') {
    return { icon: 'merge', accent: 'muted' };
  }
  if (stateBucket === 'closed') {
    return { icon: 'closed', accent: 'destructive' };
  }
  if (stateBucket === 'draft') {
    return { icon: 'draft', accent: 'muted' };
  }
  if (updating) {
    return { icon: 'pull-request', accent: 'good' };
  }
  if (reviewDecision === 'approved') {
    return { icon: 'check', accent: 'good' };
  }
  if (reviewDecision === 'changes_requested') {
    return { icon: 'x', accent: 'warn' };
  }
  // open with `review_required` or no decision
  return { icon: 'pull-request', accent: 'good' };
}

/**
 * Resolve the badge icon, accent and accessibility label for a PR.
 *
 * Visual mapping (mirrors the web badge, with mobile's open/unknown rule):
 *   - `open` + approved          → good + check
 *   - `open` + changes_requested → warn + x
 *   - `open` + no decision       → good + git-pull-request
 *   - `draft`                    → muted + draft
 *   - `merged`                   → muted + merge
 *   - `closed`                   → destructive + closed
 *   - `unknown` or pending       → good + git-pull-request, "Updating" in the
 *                                  label only (visible text stays `#N`)
 */
export function describePrBadge(
  args: Readonly<{
    state: string;
    number: number;
    reviewDecision: ReviewDecision | null;
    reviewDecisionPending: boolean;
  }>
): PrBadgeDescriptor {
  const stateBucket = normalizePrBadgeState(args.state);
  const updating = stateBucket === 'unknown' || args.reviewDecisionPending;

  const { icon, accent } = prBadgeVisual(stateBucket, args.reviewDecision, updating);

  const accessibilityLabel = updating
    ? `Updating, ${STATE_ARIA_LABELS[stateBucket]} #${args.number}`
    : `${STATE_ARIA_LABELS[stateBucket]} #${args.number}`;

  return { icon, accent, accessibilityLabel };
}
