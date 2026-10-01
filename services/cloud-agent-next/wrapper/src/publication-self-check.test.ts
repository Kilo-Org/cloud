import { describe, expect, it } from 'bun:test';
import { isSuccessfulGitHubSummaryWrite } from './publication-self-check';

const CREATE_SUMMARY = `gh api repos/acme/repo/issues/42/comments --input - << 'EOF'
{"body":"<!-- kilo-review -->"}
EOF`;
const UPDATE_SUMMARY = 'gh api repos/acme/repo/issues/comments/987 -X PATCH --input -';
const COMMENT_URL = '{"html_url":"https://github.com/acme/repo/pull/42#issuecomment-987"}';

function bash(command: string, state: Record<string, unknown> = {}) {
  return {
    type: 'tool',
    tool: 'bash',
    state: { status: 'completed', input: { command }, output: '', metadata: {}, ...state },
  };
}

describe('isSuccessfulGitHubSummaryWrite', () => {
  it('counts only summary writes that GitHub accepted', () => {
    expect(isSuccessfulGitHubSummaryWrite(bash(CREATE_SUMMARY, { metadata: { exit: 0 } }))).toBe(
      true
    );
    // Without an exit code, the created comment's URL is the evidence.
    expect(isSuccessfulGitHubSummaryWrite(bash(UPDATE_SUMMARY, { output: COMMENT_URL }))).toBe(
      true
    );
    expect(
      isSuccessfulGitHubSummaryWrite(
        bash(CREATE_SUMMARY, { metadata: { exit: 1 }, output: COMMENT_URL })
      )
    ).toBe(false);
    expect(isSuccessfulGitHubSummaryWrite(bash(CREATE_SUMMARY, { status: 'error' }))).toBe(false);
  });

  it('ignores reads and inline review writes', () => {
    for (const command of [
      "gh api repos/a/b/issues/7/comments --paginate --jq '.[] | {id,body}'",
      'gh api repos/a/b/pulls/7/reviews --input -',
    ]) {
      expect(isSuccessfulGitHubSummaryWrite(bash(command, { metadata: { exit: 0 } }))).toBe(false);
    }
  });
});
