// Pure selectors for the PR overview's sidebar metadata — the timeline line,
// label chip colors, and the reviewer-state label lookup. No React, no
// react-query, no expo modules, so the tests load in plain Node (the same
// split `merge-blocked-reasons.ts` uses).

import { type PrOverviewDto } from '@/lib/pr-review/merge/merge-blocked-reasons';

export type PrReviewerState = PrOverviewDto['reviewers'][number]['state'];

// Literal keys, never a template: the catalog check scans the source for the
// keys a lookup passes on, and a computed key is invisible to it.
const REVIEWER_STATE_LABEL_KEYS = {
  APPROVED: 'prReview.overview.reviewApproved',
  CHANGES_REQUESTED: 'prReview.overview.reviewChangesRequested',
  COMMENTED: 'prReview.overview.reviewCommented',
  DISMISSED: 'prReview.overview.reviewDismissed',
  PENDING: 'prReview.overview.reviewPending',
} satisfies Record<PrReviewerState, string>;

export type ReviewerTone = 'good' | 'destructive' | 'muted';

const REVIEWER_STATE_TONES = {
  APPROVED: 'good',
  CHANGES_REQUESTED: 'destructive',
  COMMENTED: 'muted',
  DISMISSED: 'muted',
  PENDING: 'muted',
} satisfies Record<PrReviewerState, ReviewerTone>;

export function reviewerStateLabelKey(state: PrReviewerState): string {
  return REVIEWER_STATE_LABEL_KEYS[state];
}

export function reviewerStateTone(state: PrReviewerState): ReviewerTone {
  return REVIEWER_STATE_TONES[state];
}

export type PrTimelineEntry = {
  /** Stable list key, and the reason this entry exists. */
  id: 'opened' | 'merged' | 'closed' | 'updated';
  labelKey: string;
  /** ISO timestamp the caller renders through `timeAgo`. */
  iso: string;
  /** Present only on a merge whose actor GitHub reported. */
  login?: string;
};

type PrTimelineInput = Pick<
  PrOverviewDto,
  'state' | 'createdAt' | 'updatedAt' | 'closedAt' | 'mergedAt' | 'mergedBy'
>;

/**
 * The two-part timeline line: when the PR opened, then the one event that
 * describes where it stands now. An open PR reports its last update; a merged
 * or closed PR reports that instead, because "updated" after a merge is noise.
 *
 * A merged PR whose `mergedAt` GitHub omitted falls back to the closed or
 * updated entry rather than rendering a blank time.
 */
export function buildPrTimeline(pr: PrTimelineInput): PrTimelineEntry[] {
  const entries: PrTimelineEntry[] = [
    { id: 'opened', labelKey: 'prReview.overview.openedAgo', iso: pr.createdAt },
  ];

  if (pr.state === 'merged' && pr.mergedAt) {
    entries.push(
      pr.mergedBy
        ? {
            id: 'merged',
            labelKey: 'prReview.overview.mergedByAgo',
            iso: pr.mergedAt,
            login: pr.mergedBy.login,
          }
        : { id: 'merged', labelKey: 'prReview.overview.mergedAgo', iso: pr.mergedAt }
    );
    return entries;
  }
  if (pr.state !== 'open' && pr.closedAt) {
    entries.push({ id: 'closed', labelKey: 'prReview.overview.closedAgo', iso: pr.closedAt });
    return entries;
  }
  entries.push({ id: 'updated', labelKey: 'prReview.overview.updatedAgo', iso: pr.updatedAt });
  return entries;
}

/**
 * Readable text color for a GitHub label swatch. GitHub stores the chip
 * background as a bare 6-digit hex and leaves the foreground to the client;
 * perceived luminance picks near-black on a light chip and white on a dark one.
 *
 * Returns null for anything that is not a 6-digit hex, so the caller can fall
 * back to the theme's neutral chip instead of drawing an unreadable one.
 */
export function labelChipColors(color: string): { background: string; text: string } | null {
  if (!/^[0-9a-fA-F]{6}$/.test(color)) {
    return null;
  }
  const red = Number.parseInt(color.slice(0, 2), 16);
  const green = Number.parseInt(color.slice(2, 4), 16);
  const blue = Number.parseInt(color.slice(4, 6), 16);
  // ITU-R BT.601 luma, the same weighting GitHub's own label contrast uses.
  const luma = (0.299 * red + 0.587 * green + 0.114 * blue) / 255;
  return { background: `#${color}`, text: luma > 0.6 ? '#1f2328' : '#ffffff' };
}
