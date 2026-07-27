import { describe, expect, it } from 'vitest';

import { resolveCodeReviewerOpenPrDestination } from './code-reviewer-open-pr-destination';

describe('resolveCodeReviewerOpenPrDestination', () => {
  it('routes a valid github.com PR URL in-app when the flag is on', () => {
    expect(
      resolveCodeReviewerOpenPrDestination('https://github.com/octocat/hello-world/pull/42', true)
    ).toEqual({
      kind: 'in-app',
      owner: 'octocat',
      repo: 'hello-world',
      number: 42,
    });
  });

  it('opens the browser for a GitLab PR URL', () => {
    expect(
      resolveCodeReviewerOpenPrDestination('https://gitlab.com/octocat/hello-world/pull/42', true)
    ).toEqual({ kind: 'browser' });
  });

  it('opens the browser for a Bitbucket PR URL', () => {
    expect(
      resolveCodeReviewerOpenPrDestination(
        'https://bitbucket.org/octocat/hello-world/pull-requests/42',
        true
      )
    ).toEqual({ kind: 'browser' });
  });

  it('opens the browser for a GitHub Enterprise host', () => {
    expect(
      resolveCodeReviewerOpenPrDestination(
        'https://github.example.com/octocat/hello-world/pull/42',
        true
      )
    ).toEqual({ kind: 'browser' });
  });

  it('opens the browser for a malformed URL', () => {
    expect(resolveCodeReviewerOpenPrDestination('not a url at all', true)).toEqual({
      kind: 'browser',
    });
  });

  it('opens the browser when the flag is off even for a valid github.com PR URL', () => {
    expect(
      resolveCodeReviewerOpenPrDestination('https://github.com/octocat/hello-world/pull/42', false)
    ).toEqual({ kind: 'browser' });
  });
});
