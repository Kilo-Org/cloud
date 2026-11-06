import { describe, expect, it } from 'bun:test';

import {
  buildCommandGuardBashPermissions,
  getCommandGuardPolicy,
  resolveCommandGuardBashPermission,
} from '../../src/session/command-guard.js';
import {
  buildGitHubReviewBashDenies,
  buildGitHubReviewPublishConfigContent,
} from './github-review-publish-config.js';

/** Production order: the worker guard map, then the review denies appended. */
function reviewBashPermissions(): Record<string, string> {
  const policy = getCommandGuardPolicy('code-review', 'github');
  if (!policy) throw new Error('Missing code-review command guard policy');
  return { ...buildCommandGuardBashPermissions(policy), ...buildGitHubReviewBashDenies() };
}

const COMMENT_WRITE_COMMANDS = [
  'gh issue comment',
  'gh issue comment 42',
  'gh issue comment 42 --body reviewed',
  'gh issue comment --body reviewed --edit-last',
  'gh pr comment',
  'gh pr comment 42',
  'gh pr comment 42 --body reviewed',
  'gh api repos/acme/widgets/issues/42/comments -f body=reviewed',
  'gh api repos/acme/widgets/issues/comments/9 -X PATCH -f body=reviewed',
  'gh api -X POST repos/acme/widgets/issues/42/comments -f body=reviewed',
  'gh api repos/acme/widgets/issues/42/comments --input -',
  "gh api graphql -f query='mutation { addComment(input: {}) { comment { id } } }'",
  "gh api graphql --input - -f query='mutation { addComment(input: {}) { comment { id } } }'",
  'gh api graphql --input request.json',
  'gh api --input request.json graphql',
  'gh api graphql -F query=@summary.graphql',
  "gh api -f query='mutation { addComment(input: {}) { comment { id } } }' graphql",
];

const ALLOWED_COMMANDS = [
  "gh api repos/acme/widgets/issues/42/comments --paginate --jq '.[] | {id,created_at,body}'",
  "gh api repos/acme/widgets/pulls/42/comments --paginate --jq '.[] | {id,path,line}'",
  "gh api repos/acme/widgets/pulls/42/reviews --paginate --jq '.[] | {id,state,body}'",
  'gh api repos/acme/widgets/pulls/42/reviews --input -',
  'gh pr view 42 --repo acme/widgets --json headRefOid,headRefName',
  'gh pr diff 42 --repo acme/widgets --name-only',
  'echo review-ready',
];

const INLINE_GRAPHQL_READ =
  'gh api graphql -f query=\'query { repository(owner: "acme", name: "widgets") { id } }\'';

describe('github review bash denies', () => {
  it.each(COMMENT_WRITE_COMMANDS)('denies the conversation comment write %s', command => {
    expect(resolveCommandGuardBashPermission(buildGitHubReviewBashDenies(), command)).toBe('deny');
  });

  it('leaves an inline read-only graphql query outside the deny map', () => {
    expect(
      resolveCommandGuardBashPermission(buildGitHubReviewBashDenies(), INLINE_GRAPHQL_READ)
    ).toBeUndefined();
  });

  it.each(COMMENT_WRITE_COMMANDS)(
    'denies the write %s in the production permission map',
    command => {
      expect(resolveCommandGuardBashPermission(reviewBashPermissions(), command)).toBe('deny');
    }
  );

  it.each(ALLOWED_COMMANDS)('keeps the read or inline review write %s allowed', command => {
    expect(resolveCommandGuardBashPermission(reviewBashPermissions(), command)).toBe('allow');
  });

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
    for (const command of COMMENT_WRITE_COMMANDS) {
      expect(resolveCommandGuardBashPermission(rendered, command)).toBe('deny');
    }
    for (const command of ALLOWED_COMMANDS) {
      expect(resolveCommandGuardBashPermission(rendered, command)).toBe('allow');
    }
    expect(config.permission.code_review_publish_review_summary).toBe('allow');
    expect(config.mcp.code_review.command).toEqual(['/tmp/github-review-publish-mcp']);
  });
});
