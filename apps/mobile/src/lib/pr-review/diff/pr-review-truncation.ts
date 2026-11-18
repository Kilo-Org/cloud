// Pure selectors for the Files tab. Kept here so the file-list
// component and the E2E verifier can share the same logic without
// importing the React component tree.
//
// These are intentionally simple — a 3,000-file PR is the boundary
// at which GitHub truncates its listFiles response, and we mirror
// that exactly so the user never sees a "Showing 2,500 of 3,000"
// banner when GitHub would have returned 2,500 anyway.

import { i18n } from '@/i18n';
import { formatNumber } from '@/lib/format';

export const PR_REVIEW_TRUNCATION_BANNER_THRESHOLD = 3000;

export function shouldShowTruncationBanner(changedFiles: number): boolean {
  return changedFiles > PR_REVIEW_TRUNCATION_BANNER_THRESHOLD;
}

export function truncationBannerCopy(changedFiles: number): string {
  // i18n-dup-ok: 'prReview.diff.truncationBanner_other' is this counted message's plural other category — the bare key carries that copy by i18next convention, and every catalog inflects the family by its own count rules.
  return i18n.t('prReview.diff.truncationBanner', {
    count: changedFiles,
    limit: formatNumber(PR_REVIEW_TRUNCATION_BANNER_THRESHOLD, i18n.language),
    total: formatNumber(changedFiles, i18n.language),
  });
}
