// Pure selectors for the Files tab. Kept here so the file-list
// component and the E2E verifier can share the same logic without
// importing the React component tree.
//
// These are intentionally simple — a 3,000-file PR is the boundary
// at which GitHub truncates its listFiles response, and we mirror
// that exactly so the user never sees a "Showing 2,500 of 3,000"
// banner when GitHub would have returned 2,500 anyway.

export const PR_REVIEW_TRUNCATION_BANNER_THRESHOLD = 3000;

export function shouldShowTruncationBanner(changedFiles: number): boolean {
  return changedFiles > PR_REVIEW_TRUNCATION_BANNER_THRESHOLD;
}

export function truncationBannerCopy(changedFiles: number): string {
  return `Showing the first ${PR_REVIEW_TRUNCATION_BANNER_THRESHOLD.toLocaleString()} of ${changedFiles.toLocaleString()} changed files — GitHub API limit`;
}
