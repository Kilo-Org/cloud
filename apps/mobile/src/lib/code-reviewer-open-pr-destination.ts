import { parseGitHubPrUrl } from '@/lib/github-pr-url';

type CodeReviewerOpenPrDestination =
  | { kind: 'in-app'; owner: string; repo: string; number: number }
  | { kind: 'browser' };

/**
 * Decide whether "Open pull request" should navigate in-app or open the browser.
 *
 * In-app only when the PR-review feature flag is on and `prUrl` is a parseable
 * github.com PR URL. Everything else (flag off, Enterprise/GitLab/Bitbucket,
 * malformed) keeps today's browser path.
 */
export function resolveCodeReviewerOpenPrDestination(
  prUrl: string,
  prReviewEnabled: boolean
): CodeReviewerOpenPrDestination {
  if (!prReviewEnabled) {
    return { kind: 'browser' };
  }
  const parsed = parseGitHubPrUrl(prUrl);
  if (!parsed) {
    return { kind: 'browser' };
  }
  return { kind: 'in-app', owner: parsed.owner, repo: parsed.repo, number: parsed.number };
}
