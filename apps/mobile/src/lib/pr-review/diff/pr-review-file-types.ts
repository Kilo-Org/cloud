// Pure file-level types and constants for the PR review diff viewer. Lives
// in a module with no React / react-query imports so it can be tested in
// plain Node.

export type PrReviewFile = {
  path: string;
  previousPath: string | null;
  status: string;
  additions: number;
  deletions: number;
  patch: string | null;
  patchMissing: boolean;
};

export const PR_REVIEW_MAX_LISTED_FILES = 3000;

// Server caps cursor at 60 (per the S2 read DTO contract). Pages after
// 60 are silently dropped; this is the same boundary the server uses
// for "no more pages" detection, so the client never asks for page 61.
export const PR_REVIEW_MAX_PAGES = 60;
