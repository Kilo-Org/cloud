import {
  GITHUB_REVIEW_MCP_SERVER_NAME,
  GITHUB_REVIEW_MCP_TIMEOUT_MS,
  GITHUB_REVIEW_TOOL_PERMISSION_KEY,
} from '../../src/shared/github-review-target.js';

const SUMMARY_COMMENT_ENDPOINTS = ['repos/*/issues/*/comments', 'repos/*/issues/comments/*'];

const SUMMARY_WRITE_FLAGS = ['--method', '-X', '--input', '-f', '-F', '--field', '--raw-field'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Denies summary-comment writes through `gh` in any flag order. The CLI matcher
 * anchors whole-command globs and lets the last matching pattern win, so each
 * write flag is denied with the endpoint both before and after it. Paginated
 * reads and inline review writes on pull review endpoints are untouched.
 */
export function buildGitHubReviewBashDenies(): Record<string, string> {
  const denies: Record<string, string> = {};
  for (const endpoint of SUMMARY_COMMENT_ENDPOINTS) {
    for (const flag of SUMMARY_WRITE_FLAGS) {
      denies[`gh api ${flag}*${endpoint}*`] = 'deny';
      denies[`gh api * ${flag}*${endpoint}*`] = 'deny';
      denies[`gh api ${endpoint}* ${flag}*`] = 'deny';
    }
  }
  denies['gh pr comment'] = 'deny';
  denies['gh pr comment *'] = 'deny';
  return denies;
}

export function buildGitHubReviewPublishConfigContent(input: {
  configContentJson: string | undefined;
  binaryPath: string;
}): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.configContentJson ?? '{}');
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const permission = isRecord(parsed.permission) ? { ...parsed.permission } : {};
  const existingBash = permission.bash;
  const bash = isRecord(existingBash)
    ? { ...existingBash }
    : { '*': typeof existingBash === 'string' ? existingBash : 'allow' };
  Object.assign(bash, buildGitHubReviewBashDenies());
  permission.bash = bash;
  permission[GITHUB_REVIEW_TOOL_PERMISSION_KEY] = 'allow';

  const mcp = isRecord(parsed.mcp) ? { ...parsed.mcp } : {};
  mcp[GITHUB_REVIEW_MCP_SERVER_NAME] = {
    type: 'local',
    command: [input.binaryPath],
    timeout: GITHUB_REVIEW_MCP_TIMEOUT_MS,
  };

  return JSON.stringify({ ...parsed, permission, mcp });
}
