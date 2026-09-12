import { describe, expect, it } from 'vitest';

import { resolveSessionPrTapTarget } from './session-pr-navigation';

describe('resolveSessionPrTapTarget', () => {
  it('routes a GitHub PR in-app to the GitHub route', () => {
    expect(
      resolveSessionPrTapTarget({
        url: 'https://github.com/octocat/hello-world/pull/42',
      })
    ).toEqual({ kind: 'in-app', href: '/(app)/pr-review/octocat/hello-world/42' });
  });

  it('routes a gitlab.com merge request in-app to the provider route with its instance', () => {
    expect(
      resolveSessionPrTapTarget({
        url: 'https://gitlab.com/octocat/hello-world/-/merge_requests/42',
      })
    ).toEqual({
      kind: 'in-app',
      href: '/(app)/pr-review/gitlab/octocat/hello-world/42?instance=https%3A%2F%2Fgitlab.com',
    });
  });

  it('routes a self-managed GitLab merge request in-app, keeping the pasted origin', () => {
    expect(
      resolveSessionPrTapTarget({
        url: 'https://gitlab.example.com/team/repo/-/merge_requests/7',
      })
    ).toEqual({
      kind: 'in-app',
      href: '/(app)/pr-review/gitlab/team/repo/7?instance=https%3A%2F%2Fgitlab.example.com',
    });
  });

  it('routes a Bitbucket pull request in-app to the provider route', () => {
    expect(
      resolveSessionPrTapTarget({
        url: 'https://bitbucket.org/acme/api/pull-requests/42/overview',
      })
    ).toEqual({ kind: 'in-app', href: '/(app)/pr-review/bitbucket/acme/api/42' });
  });

  it('opens the browser for a GitHub Enterprise host — the GitHub App serves github.com only', () => {
    expect(
      resolveSessionPrTapTarget({
        url: 'https://github.example.com/octocat/hello-world/pull/42',
      })
    ).toEqual({ kind: 'browser', url: 'https://github.example.com/octocat/hello-world/pull/42' });
  });

  it('opens the browser when the URL is malformed', () => {
    expect(
      resolveSessionPrTapTarget({
        url: 'not a url at all',
      })
    ).toEqual({ kind: 'browser', url: 'not a url at all' });
  });

  it('opens the browser with an empty URL when the URL is absent', () => {
    expect(
      resolveSessionPrTapTarget({
        url: null,
      })
    ).toEqual({ kind: 'browser', url: '' });
  });
});
