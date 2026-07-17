import type { CodeReviewPlatform } from './enums';

// Ported verbatim from apps/web/src/lib/code-reviews/code-review-links.ts.
const REVIEW_URL_SUFFIXES: Record<CodeReviewPlatform, RegExp> = {
  github: /\/pull\/\d+\/?(?:[?#].*)?$/,
  gitlab: /\/-\/merge_requests\/\d+\/?(?:[?#].*)?$/,
  bitbucket: /\/pull-requests\/\d+\/?(?:[?#].*)?$/,
};

export function getCodeReviewRepositoryUrl(
  platform: CodeReviewPlatform,
  reviewUrl: string
): string {
  return reviewUrl.replace(REVIEW_URL_SUFFIXES[platform], '');
}

// Exposes the suffix check underlying getCodeReviewRepositoryUrl as a
// standalone predicate — used by mobile's manual-review-screen.tsx as the
// PR/MR-shape half of its URL validation (combined there with a host/protocol
// anchor mobile keeps local; see that file for why the anchor isn't dropped).
export function matchesCodeReviewUrlSuffix(platform: CodeReviewPlatform, url: string): boolean {
  return REVIEW_URL_SUFFIXES[platform].test(url);
}

export function getCodeReviewJobsHref(
  platform: CodeReviewPlatform,
  organizationId?: string | null
): string {
  // Avoid URLSearchParams here — this module also runs on React Native,
  // where it isn't guaranteed to be globally available. Behavior-identical
  // to the ported URLSearchParams version for our fixed platform literals
  // (all plain ASCII, nothing that needs percent-encoding).
  const query = organizationId ? `platform=${platform}&view=jobs` : `platform=${platform}`;

  const basePath = organizationId
    ? `/organizations/${organizationId}/code-reviews`
    : '/code-reviews';
  return `${basePath}?${query}`;
}
