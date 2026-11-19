import type { CodeReviewPlatform } from './enums';

// A review URL names the repository path, the platform's review segment, and
// optionally a sub-page of that review: GitHub `/pull/<n>/files`, GitLab
// `/-/merge_requests/<n>/diffs`, Bitbucket `/pull-requests/<n>/diff`. Only the
// URL path may hold the review segment; the same text inside a query string or
// fragment is page state, not the review. Any single trailing path segment is
// accepted rather than an allow-list, because providers keep adding sub-tabs
// and the server re-reads the review from the provider, so a wrong segment
// costs a lookup, not a wrong review.
const REVIEW_PATH_PATTERNS: Record<CodeReviewPlatform, RegExp> = {
  github: /^(\/[^/]+\/[^/]+)\/pull\/\d+(?:\/[^/]+)*\/?$/,
  gitlab: /^(\/[^/]+(?:\/[^/]+)*?)\/-\/merge_requests\/\d+(?:\/[^/]+)*\/?$/,
  bitbucket: /^(\/[^/]+\/[^/]+)\/pull-requests\/\d+(?:\/[^/]+)*\/?$/,
};

type CodeReviewUrlParts = {
  /** `scheme://authority`, empty for a bare path. */
  head: string;
  /** The path, without any query string or fragment. */
  path: string;
};

// Split without the WHATWG URL constructor: this module also runs on React
// Native, where the URL globals are not guaranteed. A bare path keeps its
// whole string as the path, so a caller can still check path shapes alone.
function splitCodeReviewUrl(url: string): CodeReviewUrlParts {
  const pathEnd = url.search(/[?#]/);
  const beforeQuery = pathEnd === -1 ? url : url.slice(0, pathEnd);
  const authority = /^[a-z][a-z\d+.-]*:\/\/[^/?#]*/i.exec(beforeQuery);
  const head = authority ? authority[0] : '';
  return { head, path: beforeQuery.slice(head.length) };
}

export function getCodeReviewRepositoryUrl(
  platform: CodeReviewPlatform,
  reviewUrl: string
): string {
  const { head, path } = splitCodeReviewUrl(reviewUrl);
  const match = REVIEW_PATH_PATTERNS[platform].exec(path);
  const repositoryPath = match?.[1];
  if (repositoryPath === undefined) {
    return reviewUrl;
  }
  // The query and fragment address the review view — a sub-tab, a comment
  // anchor — not the repository, so the derived link stops at the repository
  // path.
  return `${head}${repositoryPath}`;
}

// Exposes the path-shape check underlying getCodeReviewRepositoryUrl as a
// standalone predicate — used by mobile's manual-review-screen.tsx as the
// PR/MR-shape half of its URL validation (combined there with a host/protocol
// anchor mobile keeps local; see that file for why the anchor isn't dropped).
export function matchesCodeReviewUrlSuffix(platform: CodeReviewPlatform, url: string): boolean {
  return REVIEW_PATH_PATTERNS[platform].test(splitCodeReviewUrl(url).path);
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

// Detail (single-job) link. Keep the org prefix so the left-nav workspace,
// which is derived purely from the URL path (see useUrlOrganizationId), stays
// on the owning organization instead of silently falling back to Personal.
export function getCodeReviewDetailHref(reviewId: string, organizationId?: string | null): string {
  return organizationId
    ? `/organizations/${organizationId}/code-reviews/${reviewId}`
    : `/code-reviews/${reviewId}`;
}
