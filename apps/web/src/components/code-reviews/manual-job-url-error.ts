import { matchesCodeReviewUrlSuffix } from '@kilocode/app-shared/code-review';
import type { CodeReviewUiPlatform } from '@/lib/code-reviews/code-review-links';

type Platform = CodeReviewUiPlatform;

/**
 * The message a manual Code Reviewer job form shows for a URL it cannot start
 * from, or `null` when the URL names a review on the selected platform. A link
 * copied from a review sub-tab (`/pull/123/files`) is accepted: the server
 * re-reads the review from the provider regardless of the trailing segment.
 */
export function getManualJobUrlError(
  value: string,
  platform: Platform,
  localCodeReviewDevelopmentEnabled: boolean
): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return platform === 'gitlab'
      ? 'Enter a GitLab merge request URL.'
      : 'Enter a GitHub pull request URL.';
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(trimmed);
  } catch {
    return 'Enter a valid URL.';
  }

  if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
    return 'URL must use http or https.';
  }

  if (platform === 'github') {
    const isGitHubPullRequest =
      parsedUrl.hostname === 'github.com' && matchesCodeReviewUrlSuffix('github', trimmed);
    return isGitHubPullRequest
      ? null
      : 'Enter a GitHub pull request URL like https://github.com/owner/repo/pull/123.';
  }

  const isGitLabMergeRequest = matchesCodeReviewUrlSuffix(platform, trimmed);
  if (!isGitLabMergeRequest) {
    return 'Enter a GitLab merge request URL like https://gitlab.com/group/project/-/merge_requests/123.';
  }

  if (localCodeReviewDevelopmentEnabled && parsedUrl.hostname !== 'gitlab.com') {
    return 'Local GitLab jobs require a public gitlab.com merge request URL.';
  }

  return null;
}
