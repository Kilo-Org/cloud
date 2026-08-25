/**
 * Pure copy selectors for the review-submit sheet's stale-head path. Kept
 * out of the component so the submit CTA label and the partial-result
 * message are unit-testable without mounting the sheet.
 */

import { i18n } from '@/i18n';
import { formatNumber } from '@/lib/format';

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
