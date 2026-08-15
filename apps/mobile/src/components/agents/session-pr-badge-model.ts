import { type AssociatedPrData } from '@kilocode/cloud-agent-sdk';

export type ReviewDecision = NonNullable<AssociatedPrData['reviewDecision']>;

export type PrBadgeState = 'open' | 'closed' | 'merged' | 'draft' | 'unknown';

export type PrBadgeIconKind = 'check' | 'x' | 'pull-request' | 'draft' | 'merge' | 'closed';

export type PrBadgeAccent = 'good' | 'warn' | 'muted' | 'destructive';

export type PrBadgeDescriptor = Readonly<{
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
  if (state === 'merged') return 'merged';
  if (state === 'draft') return 'draft';
  if (state === 'open') return 'open';
  if (state === 'closed') return 'closed';
  return 'unknown';
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

  let icon: PrBadgeIconKind;
  let accent: PrBadgeAccent;

  if (stateBucket === 'merged') {
    icon = 'merge';
    accent = 'muted';
  } else if (stateBucket === 'closed') {
    icon = 'closed';
    accent = 'destructive';
  } else if (stateBucket === 'draft') {
    icon = 'draft';
    accent = 'muted';
  } else if (updating) {
    icon = 'pull-request';
    accent = 'good';
  } else if (args.reviewDecision === 'approved') {
    icon = 'check';
    accent = 'good';
  } else if (args.reviewDecision === 'changes_requested') {
    icon = 'x';
    accent = 'warn';
  } else {
    // open with `review_required` or no decision
    icon = 'pull-request';
    accent = 'good';
  }

  const accessibilityLabel = updating
    ? `Updating, ${STATE_ARIA_LABELS[stateBucket]} #${args.number}`
    : `${STATE_ARIA_LABELS[stateBucket]} #${args.number}`;

  return { icon, accent, accessibilityLabel };
}
