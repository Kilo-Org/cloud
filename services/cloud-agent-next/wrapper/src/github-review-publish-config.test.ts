import { describe, expect, it } from 'bun:test';

import {
  buildCommandGuardBashPermissions,
  getCommandGuardPolicy,
  resolveCommandGuardBashPermission,
} from '../../src/session/command-guard.js';
import {
  buildGitHubReviewBashRules,
  buildGitHubReviewPublishConfigContent,
} from './github-review-publish-config.js';

/** Production order: the worker guard map, then the appended review rules. */
function reviewBashPermissions(): Record<string, string> {
  const policy = getCommandGuardPolicy('code-review', 'github');
  if (!policy) throw new Error('Missing code-review command guard policy');
  const composed = buildCommandGuardBashPermissions(policy);
  const rules = buildGitHubReviewBashRules();
  for (const key of Object.keys(rules)) delete composed[key];
  return Object.assign(composed, rules);
}

const COMMENT_WRITE_COMMANDS: { label: string; command: string }[] = [
  { label: 'issue comment subcommand', command: 'gh issue comment' },
  { label: 'issue comment with arguments', command: 'gh issue comment 42 --body reviewed' },
  {
    label: 'issue comment edit-last form',
    command: 'gh issue comment --body reviewed --edit-last',
  },
  { label: 'pull request comment subcommand', command: 'gh pr comment' },
  { label: 'pull request comment with arguments', command: 'gh pr comment 42 --body reviewed' },
  {
    label: 'comment create with a field flag',
    command: 'gh api repos/acme/widgets/issues/42/comments -f body=reviewed',
  },
  {
    label: 'comment update with the patch method',
    command: 'gh api repos/acme/widgets/issues/comments/9 -X PATCH -f body=reviewed',
  },
  {
    label: 'comment create with the method before the endpoint',
    command: 'gh api -X POST repos/acme/widgets/issues/42/comments -f body=reviewed',
  },
  {
    label: 'comment create from stdin',
    command: 'gh api repos/acme/widgets/issues/42/comments --input -',
  },
  {
    label: 'comment create with a wrapper prefix',
    command: 'env REVIEW_MODE=1 gh api repos/acme/widgets/issues/42/comments -f body=reviewed',
  },
  {
    label: 'graphql request carrying a mutation',
    command: "gh api graphql -f query='mutation { addComment(input: {}) { comment { id } } }'",
  },
  {
    label: 'graphql request with the query first',
    command:
      "gh api -f query='mutation { addComment(input: {}) { comment { id } } }' graphql --input -",
  },
  { label: 'graphql request from stdin', command: 'gh api graphql --input -' },
  { label: 'graphql request from a file', command: 'gh api graphql -F query=@summary.graphql' },
  {
    label: 'graphql request built by substitution',
    command: `gh api graphql -f query="$(cat /tmp/review.graphql)"`,
  },
  {
    label: 'graphql request built from a short read',
    command: `gh api graphql -f query="$(< /tmp/review.graphql)"`,
  },
  {
    label: 'two commands writing a request file and posting it',
    command: `echo 'mutation { addComment(input: {}) { comment { id } } }' > /tmp/q.graphql && gh api graphql -f query="$(cat /tmp/q.graphql)"`,
  },
  {
    label: 'graphql request with a wrapper prefix',
    command:
      "env REVIEW_MODE=1 gh api graphql -f query='mutation { addComment(input: {}) { comment { id } } }'",
  },
  {
    label: 'comment write after an inline review write',
    command:
      'gh api repos/acme/widgets/pulls/42/reviews --input - && gh pr comment 42 --body reviewed',
  },
];

const ALLOWED_COMMANDS: { label: string; command: string }[] = [
  {
    label: 'inline review write on a repository whose path contains the graphql phrase',
    command: 'gh api repos/apollographql/apollo-server/pulls/42/reviews --input -',
  },
  {
    label: 'paginated conversation read',
    command:
      "gh api repos/acme/widgets/issues/42/comments --paginate --jq '.[] | {id,created_at,body}'",
  },
  {
    label: 'paginated inline comment read',
    command: "gh api repos/acme/widgets/pulls/42/comments --paginate --jq '.[] | {id,path,line}'",
  },
  {
    label: 'paginated review read',
    command: "gh api repos/acme/widgets/pulls/42/reviews --paginate --jq '.[] | {id,state,body}'",
  },
  {
    label: 'atomic inline review write',
    command: 'gh api repos/acme/widgets/pulls/42/reviews --input -',
  },
  {
    label: 'pull request view',
    command: 'gh pr view 42 --repo acme/widgets --json headRefOid,headRefName',
  },
  { label: 'pull request file list', command: 'gh pr diff 42 --repo acme/widgets --name-only' },
  { label: 'plain command', command: 'echo review-ready' },
];

describe('github review bash rules', () => {
  it.each(COMMENT_WRITE_COMMANDS)('denies the comment write form: $label', ({ command }) => {
    expect(resolveCommandGuardBashPermission(buildGitHubReviewBashRules(), command)).toBe('deny');
  });

  it.each(COMMENT_WRITE_COMMANDS)(
    'denies the write in the production map: $label',
    ({ command }) => {
      expect(resolveCommandGuardBashPermission(reviewBashPermissions(), command)).toBe('deny');
    }
  );

  it.each(ALLOWED_COMMANDS)(
    'keeps the read or inline review write allowed: $label',
    ({ command }) => {
      expect(resolveCommandGuardBashPermission(reviewBashPermissions(), command)).toBe('allow');
    }
  );

  it('renders the denies into the review session config content', () => {
    const content = buildGitHubReviewPublishConfigContent({
      configContentJson: JSON.stringify({
        permission: { bash: reviewBashPermissions() },
        mcp: { code_review: { type: 'local', command: ['fake-publisher'] } },
      }),
      binaryPath: '/tmp/github-review-publish-mcp',
    });
    if (content === null) throw new Error('Expected review config content');
    const config = JSON.parse(content);
    const rendered = config.permission.bash;
    for (const { command } of COMMENT_WRITE_COMMANDS) {
      expect(resolveCommandGuardBashPermission(rendered, command)).toBe('deny');
    }
    for (const { command } of ALLOWED_COMMANDS) {
      expect(resolveCommandGuardBashPermission(rendered, command)).toBe('allow');
    }
    expect(config.permission.code_review_publish_review_summary).toBe('allow');
    expect(config.mcp.code_review.command).toEqual(['/tmp/github-review-publish-mcp']);
  });
});
