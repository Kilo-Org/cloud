import { describe, expect, it } from 'vitest';

import { resolveSessionPrTapTarget } from './session-pr-navigation';

describe('resolveSessionPrTapTarget', () => {
  it('routes a GitHub PR in-app', () => {
    expect(
      resolveSessionPrTapTarget({
        url: 'https://github.com/octocat/hello-world/pull/42',
        number: 42,
      })
    ).toEqual({ kind: 'in-app', href: '/(app)/pr-review/octocat/hello-world/42' });
  });

  it('routes a parseable github.com URL in-app', () => {
    expect(
      resolveSessionPrTapTarget({
        url: 'https://github.com/octocat/hello-world/pull/7',
        number: 7,
      })
    ).toEqual({ kind: 'in-app', href: '/(app)/pr-review/octocat/hello-world/7' });
  });

  it('opens the browser for a GitLab PR URL', () => {
    expect(
      resolveSessionPrTapTarget({
        url: 'https://gitlab.com/octocat/hello-world/-/merge_requests/42',
        number: 42,
      })
    ).toEqual({
      kind: 'browser',
      url: 'https://gitlab.com/octocat/hello-world/-/merge_requests/42',
    });
  });

  it('opens the browser for a Bitbucket PR URL', () => {
    expect(
      resolveSessionPrTapTarget({
        url: 'https://bitbucket.org/octocat/hello-world/pull-requests/42',
        number: 42,
      })
    ).toEqual({
      kind: 'browser',
      url: 'https://bitbucket.org/octocat/hello-world/pull-requests/42',
    });
  });

  it('opens the browser for a GitHub Enterprise host', () => {
    expect(
      resolveSessionPrTapTarget({
        url: 'https://github.example.com/octocat/hello-world/pull/42',
        number: 42,
      })
    ).toEqual({ kind: 'browser', url: 'https://github.example.com/octocat/hello-world/pull/42' });
  });

  it('opens the browser when the URL is malformed', () => {
    expect(
      resolveSessionPrTapTarget({
        url: 'not a url at all',
        number: 42,
      })
    ).toEqual({ kind: 'browser', url: 'not a url at all' });
  });

  it('opens the browser with an empty URL when the URL is absent', () => {
    expect(
      resolveSessionPrTapTarget({
        url: null,
        number: 42,
      })
    ).toEqual({ kind: 'browser', url: '' });
  });
});
