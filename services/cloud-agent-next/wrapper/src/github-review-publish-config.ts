import {
  GITHUB_REVIEW_MCP_SERVER_NAME,
  GITHUB_REVIEW_MCP_TIMEOUT_MS,
  GITHUB_REVIEW_TOOL_PERMISSION_KEY,
} from '../../src/shared/github-review-target.js';
import { buildGitHubReviewBashRules } from '../../src/shared/github-review-bash-rules.js';

export { buildGitHubReviewBashRules } from '../../src/shared/github-review-bash-rules.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
