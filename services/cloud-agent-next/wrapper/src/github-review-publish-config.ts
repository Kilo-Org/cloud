import {
  GITHUB_REVIEW_MCP_SERVER_NAME,
  GITHUB_REVIEW_MCP_TIMEOUT_MS,
  GITHUB_REVIEW_TOOL_PERMISSION_KEY,
} from '../../src/shared/github-review-target.js';

const SUMMARY_COMMENT_ENDPOINTS = ['repos/*/issues/*/comments', 'repos/*/issues/comments/*'];

const SUMMARY_WRITE_FLAGS = ['--method', '-X', '--input', '-f', '-F', '--field', '--raw-field'];

const GRAPHQL_ENDPOINT = 'graphql';

const COMMENT_SUBCOMMANDS = ['gh issue comment', 'gh pr comment'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Comment writes on the reviewed pull request belong to the trusted publisher.
 * The map denies every `gh` form that creates or edits a conversation comment,
 * in any flag order and regardless of a command prefix. The CLI matcher
 * anchors whole-command globs and lets the last matching pattern win, so a rule
 * appended here overrides an earlier allow. Paginated reads and inline review
 * writes on pull review endpoints stay allowed.
 */
export function buildGitHubReviewBashDenies(): Record<string, string> {
  const denies: Record<string, string> = {};
  for (const endpoint of SUMMARY_COMMENT_ENDPOINTS) {
    for (const flag of SUMMARY_WRITE_FLAGS) {
      denies[`gh api ${flag}*${endpoint}*`] = 'deny';
      denies[`gh api * ${flag}*${endpoint}*`] = 'deny';
      denies[`gh api ${endpoint}* ${flag}*`] = 'deny';
      // Matched anywhere in the command text (a leading wildcard allows a
      // wrapper prefix or a surrounding command), so a write form cannot move
      // out of reach.
      denies[`*gh api *${flag}*${endpoint}*`] = 'deny';
      denies[`*gh api *${endpoint}*${flag}*`] = 'deny';
    }
  }
  // A pull request is an issue, so both comment subcommands reach the same
  // conversation comment.
  for (const subcommand of COMMENT_SUBCOMMANDS) {
    denies[subcommand] = 'deny';
    denies[`${subcommand} *`] = 'deny';
    denies[`*${subcommand}*`] = 'deny';
  }
  // A graphql request carries its operation in the command text or in a
  // provided body, and every `gh api` call that reaches graphql is denied.
  denies[`gh api ${GRAPHQL_ENDPOINT}`] = 'deny';
  denies[`gh api ${GRAPHQL_ENDPOINT} *`] = 'deny';
  denies[`*gh api *${GRAPHQL_ENDPOINT}*`] = 'deny';
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
