import {
  GITHUB_REVIEW_MCP_SERVER_NAME,
  GITHUB_REVIEW_MCP_TIMEOUT_MS,
  GITHUB_REVIEW_TOOL_PERMISSION_KEY,
} from '../../src/shared/github-review-target.js';

const SUMMARY_COMMENT_ENDPOINTS = ['repos/*/issues/*/comments', 'repos/*/issues/comments/*'];

const SUMMARY_WRITE_FLAGS = ['--method', '-X', '--input', '-f', '-F', '--field', '--raw-field'];

const GRAPHQL_ENDPOINT = 'graphql';

const COMMENT_SUBCOMMANDS = ['gh issue comment', 'gh pr comment'];

// The atomic inline review write routes through the review endpoint, never
// through the conversation-comments endpoints.
// Anchored to the exact form the review skill publishes, so it cannot absorb a
// later command in the same text.
const INLINE_REVIEW_ALLOWS = ['gh api repos/*/pulls/*/reviews --input -'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Comment writes on the reviewed pull request belong to the trusted publisher.
 * The map denies every `gh` form that creates or edits a conversation comment,
 * in any flag order and regardless of a command prefix. The CLI matcher
 * anchors whole-command globs and lets the last matching pattern win, so a rule
 * appended here overrides an earlier allow, and a later rule overrides an
 * earlier deny. Paginated reads and inline review writes on pull review
 * endpoints stay allowed.
 */
export function buildGitHubReviewBashRules(): Record<string, string> {
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
  // Appended last: the session matcher resolves whole-command globs in key
  // order and the last matching rule engages, so the inline review write stays
  // allowed even when the repository path itself contains the graphql phrase.
  for (const allow of INLINE_REVIEW_ALLOWS) {
    denies[allow] = 'allow';
  }
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
  const bash: Record<string, unknown> = isRecord(existingBash)
    ? { ...existingBash }
    : { '*': typeof existingBash === 'string' ? existingBash : 'allow' };
  // The CLI matcher lets the last matching key engage, and a key repeated by
  // the rules keeps its first insertion position under a plain merge. Delete
  // the rule keys first so every appended rule lands after the guard map.
  const rules = buildGitHubReviewBashRules();
  for (const key of Object.keys(rules)) delete bash[key];
  Object.assign(bash, rules);
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
