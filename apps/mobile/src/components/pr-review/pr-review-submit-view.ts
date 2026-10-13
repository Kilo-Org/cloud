/**
 * Pure selectors for the review-submit sheet: the stale-head copy and the
 * review events GitHub accepts. Kept out of the component so they are
 * unit-testable without mounting the sheet.
 */

import { i18n } from '@/i18n';
import { formatNumber } from '@/lib/format';
import { type ProviderReviewEventOption } from '@/lib/pr-review/use-pr-review-mutations';

/**
 * The review events to offer on a GitHub pull request. GitHub rejects an
 * approval or a change request from the pull request author with 422 ("Can
 * not approve your own pull request"), so the author can only comment.
 * `undefined` keeps the fixed three-option chip row.
 */
export function selectGitHubReviewEvents(args: {
  authorLogin: string | undefined;
  viewerLogin: string | null;
}): readonly ProviderReviewEventOption[] | undefined {
  const { authorLogin, viewerLogin } = args;
  if (authorLogin === undefined || viewerLogin === null) {
    return undefined;
  }
  return authorLogin.toLowerCase() === viewerLogin.toLowerCase() ? ['comment'] : undefined;
}

export function selectSubmitCtaLabel(args: { freshCount: number; totalCount: number }): string {
  if (args.totalCount > args.freshCount) {
    return i18n.t('prReview.submit.submitCountOfTotal', {
      freshCount: args.freshCount,
      totalCount: args.totalCount,
      displayFreshCount: formatNumber(args.freshCount, i18n.language),
      displayTotalCount: formatNumber(args.totalCount, i18n.language),
    });
  }
  return i18n.t('prReview.submit.submitReview');
}

export function selectPartialSubmitMessage(args: {
  freshCount: number;
  staleCount: number;
}): string | null {
  if (args.staleCount === 0) {
    return null;
  }
  return i18n.t('prReview.submit.partialPostedMessage', {
    freshCount: args.freshCount,
    staleCount: args.staleCount,
    displayFreshCount: formatNumber(args.freshCount, i18n.language),
    displayStaleCount: formatNumber(args.staleCount, i18n.language),
  });
}
