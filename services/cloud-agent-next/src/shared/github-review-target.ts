/**
 * Shared contract for the trusted GitHub code-review publication target.
 *
 * The worker persists the target on the session and exports it into the sandbox
 * environment as JSON. The wrapper reads it to decide whether to install the
 * publication tool, and the MCP server reads it to know the repo, PR, app type,
 * and trusted bot user id. It never carries a credential: the token travels
 * separately as `GH_TOKEN`.
 */
export const GITHUB_REVIEW_TARGET_ENV = 'KILO_GITHUB_REVIEW_TARGET';
/** Trusted-only API base for the local publication harness. Never a profile value. */
export const GITHUB_REVIEW_API_BASE_ENV = 'KILO_GITHUB_REVIEW_API_BASE';
export const GITHUB_REVIEW_MCP_SERVER_NAME = 'code_review';
export const GITHUB_REVIEW_MCP_BINARY = 'github-review-publish-mcp';
/**
 * Per-call MCP timeout written into the local server config. The pinned CLI
 * defaults an MCP tool to 60s and the child aborts at 75s, so 80s keeps the
 * child alive to its own bound while staying inside the 90s wrapper recovery
 * deadline.
 */
export const GITHUB_REVIEW_MCP_TIMEOUT_MS = 80_000;
export const GITHUB_REVIEW_TOOL_NAME = 'publish_review_summary';
export const GITHUB_REVIEW_TOOL_PERMISSION_KEY = 'code_review_publish_review_summary';
export const GITHUB_REVIEW_SUMMARY_MARKER = '<!-- kilo-review -->';
export const GITHUB_REVIEW_PUBLICATION_FAILURE_MARKER = '<!-- kilo-review-publication-failure -->';

export type GitHubReviewAppType = 'standard' | 'lite';

export type GitHubReviewTarget = {
  /** Repository in `owner/repo` form. */
  repo: string;
  pullRequestNumber: number;
  appType: GitHubReviewAppType;
  /** Numeric GitHub App bot user id trusted to own the summary comment. */
  botUserId: string;
};

export function serializeGitHubReviewTarget(target: GitHubReviewTarget): string {
  return JSON.stringify(target);
}

export function parseGitHubReviewTarget(raw: string | undefined | null): GitHubReviewTarget | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const repo = record.repo;
  const pullRequestNumber = record.pullRequestNumber;
  const appType = record.appType;
  const botUserId = record.botUserId;
  if (typeof repo !== 'string' || repo.split('/').length !== 2 || repo.startsWith('/')) return null;
  if (
    typeof pullRequestNumber !== 'number' ||
    !Number.isInteger(pullRequestNumber) ||
    pullRequestNumber <= 0
  ) {
    return null;
  }
  if (appType !== 'standard' && appType !== 'lite') return null;
  if (typeof botUserId !== 'string' || botUserId.length === 0) return null;
  return { repo, pullRequestNumber, appType, botUserId };
}
