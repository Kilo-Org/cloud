import { describe, expect, it } from 'vitest';

import { resolveCodeReviewerOpenPrDestination } from './code-reviewer-open-pr-destination';

describe('resolveCodeReviewerOpenPrDestination', () => {
  it('routes a valid github.com PR URL in-app when the flag is on', () => {
    expect(
      resolveCodeReviewerOpenPrDestination('https://github.com/octocat/hello-world/pull/42', true)
    ).toEqual({
      kind: 'in-app',
      href: '/(app)/pr-review/octocat/hello-world/42',
    });
  });

  it('routes a gitlab.com merge request in-app to the provider route with its instance', () => {
    expect(
      resolveCodeReviewerOpenPrDestination(
        'https://gitlab.com/group/sub/repo/-/merge_requests/7',
        true
      )
    ).toEqual({
      kind: 'in-app',
      href: '/(app)/pr-review/gitlab/group/sub/repo/7?instance=https%3A%2F%2Fgitlab.com',
    });
  });

  it('routes a self-managed GitLab merge request in-app', () => {
    expect(
      resolveCodeReviewerOpenPrDestination(
        'https://gitlab.example.com/team/repo/-/merge_requests/9',
        true
      )
    ).toEqual({
      kind: 'in-app',
      href: '/(app)/pr-review/gitlab/team/repo/9?instance=https%3A%2F%2Fgitlab.example.com',
    });
  });

  it('routes a Bitbucket pull request in-app', () => {
    expect(
      resolveCodeReviewerOpenPrDestination(
        'https://bitbucket.org/acme/api/pull-requests/42/overview',
        true
      )
    ).toEqual({
      kind: 'in-app',
      href: '/(app)/pr-review/bitbucket/acme/api/42',
    });
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
