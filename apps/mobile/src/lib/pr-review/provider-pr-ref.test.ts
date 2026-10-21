import { describe, expect, it } from 'vitest';

import {
  githubPrRef,
  isProviderPrPlatform,
  parseProviderPrRoute,
  providerPrChildRoutePath,
  providerPrRefKey,
  providerPrRefLabel,
  providerPrRepoPath,
  providerPrRoutePath,
  providerPrRouteSegments,
  providerPrTermKey,
  providerPrTriple,
  providerPrWebUrl,
} from './provider-pr-ref';

/** A URL whose authority carries userinfo, assembled from parts. */
const CREDENTIAL_URL = ['https://user', ':secret@', 'gitlab.example.com'].join('');

describe('isProviderPrPlatform', () => {
  it('accepts the three supported platforms', () => {
    expect(['github', 'gitlab', 'bitbucket'].every(value => isProviderPrPlatform(value))).toBe(
      true
    );
  });

  it('rejects anything else', () => {
    expect(isProviderPrPlatform('gitea')).toBe(false);
    expect(isProviderPrPlatform('')).toBe(false);
    // `parseParam` already collapses a missing or repeated segment to null.
    expect(isProviderPrPlatform(null)).toBe(false);
  });
});

describe('parseProviderPrRoute', () => {
  it('parses a GitLab nested project path with the iid last', () => {
    expect(
      parseProviderPrRoute({ platform: 'gitlab', identity: ['group', 'sub', 'repo', '12'] })
    ).toEqual({
      platform: 'gitlab',
      projectPath: 'group/sub/repo',
      mrIid: 12,
      instanceHint: undefined,
    });
  });

  it('reduces the GitLab instance query param to its origin', () => {
    expect(
      parseProviderPrRoute({
        platform: 'gitlab',
        identity: ['group', 'repo', '3'],
        instance: 'https://gitlab.example.com',
      })
    ).toEqual({
      platform: 'gitlab',
      projectPath: 'group/repo',
      mrIid: 3,
      instanceHint: 'https://gitlab.example.com',
    });
    // Scheme and host are lowercased, the port is kept, and the path, query
    // and fragment are dropped: the hint is an origin.
    expect(
      parseProviderPrRoute({
        platform: 'gitlab',
        identity: ['group', 'repo', '3'],
        instance: 'HTTPS://GitLab.Example.COM:8443/group/repo/-/merge_requests/3?x=1#note_2',
      })
    ).toMatchObject({ instanceHint: 'https://gitlab.example.com:8443' });
  });

  it('drops a GitLab instance param that is not an http(s) URL with a host', () => {
    const identity = ['group', 'repo', '3'];
    for (const instance of [
      'gitlab.example.com',
      'ftp://gitlab.example.com',
      'https://',
      CREDENTIAL_URL,
      'gopher://gitlab.example.com/x',
      'not a url',
      '',
    ]) {
      expect(parseProviderPrRoute({ platform: 'gitlab', identity, instance })).toMatchObject({
        instanceHint: undefined,
      });
    }
  });

  it('parses a Bitbucket workspace/repo/id triple', () => {
    expect(
      parseProviderPrRoute({ platform: 'bitbucket', identity: ['acme', 'api', '42'] })
    ).toEqual({ platform: 'bitbucket', workspace: 'acme', repoSlug: 'api', prId: 42 });
  });

  it('rejects a Bitbucket path with extra nesting (its API has none)', () => {
    expect(
      parseProviderPrRoute({ platform: 'bitbucket', identity: ['acme', 'group', 'api', '42'] })
    ).toBeNull();
  });

  it('parses a GitHub owner/repo/number triple', () => {
    expect(
      parseProviderPrRoute({ platform: 'github', identity: ['octocat', 'hello', '7'] })
    ).toEqual(githubPrRef('octocat', 'hello', 7));
  });

  it('decodes percent-escaped segments', () => {
    expect(
      parseProviderPrRoute({ platform: 'gitlab', identity: ['group', 'my%2Drepo', '5'] })
    ).toMatchObject({ projectPath: 'group/my-repo', mrIid: 5 });
  });

  it('rejects a GitLab path segment the server never names a project with', () => {
    for (const segment of ['.', '..', '-', 'my%20repo', 'a%23b', 'a%3Fb']) {
      expect(
        parseProviderPrRoute({ platform: 'gitlab', identity: ['group', segment, '5'] })
      ).toBeNull();
    }
  });

  it('rejects an unknown platform', () => {
    expect(parseProviderPrRoute({ platform: 'gitea', identity: ['a', 'b', '1'] })).toBeNull();
  });

  it('rejects a non-numeric, zero, or partially numeric trailing segment', () => {
    expect(parseProviderPrRoute({ platform: 'gitlab', identity: ['a', 'b', '12abc'] })).toBeNull();
    expect(parseProviderPrRoute({ platform: 'gitlab', identity: ['a', 'b', '0'] })).toBeNull();
    expect(parseProviderPrRoute({ platform: 'gitlab', identity: ['a', 'b', 'x'] })).toBeNull();
  });

  it('rejects a project path shorter than two segments', () => {
    expect(parseProviderPrRoute({ platform: 'gitlab', identity: ['repo', '12'] })).toBeNull();
    expect(parseProviderPrRoute({ platform: 'gitlab', identity: ['12'] })).toBeNull();
    expect(parseProviderPrRoute({ platform: 'gitlab', identity: undefined })).toBeNull();
  });

  it('rejects an empty or malformed segment', () => {
    expect(parseProviderPrRoute({ platform: 'gitlab', identity: ['a', '', '1'] })).toBeNull();
    expect(
      parseProviderPrRoute({ platform: 'gitlab', identity: ['a', '%E0%A4%A', '1'] })
    ).toBeNull();
  });

  it('rejects a segment that decodes to a second path separator', () => {
    expect(
      parseProviderPrRoute({ platform: 'bitbucket', identity: ['acme', 'a%2Fb', '1'] })
    ).toBeNull();
  });
});

describe('providerPrRouteSegments / providerPrRoutePath', () => {
  it('round-trips a nested GitLab ref through the route', () => {
    const ref = { platform: 'gitlab', projectPath: 'group/sub/repo', mrIid: 12 } as const;
    const { platform, identity } = providerPrRouteSegments(ref);
    expect(identity).toEqual(['group', 'sub', 'repo', '12']);
    expect(parseProviderPrRoute({ platform, identity })).toMatchObject({
      platform: 'gitlab',
      projectPath: 'group/sub/repo',
      mrIid: 12,
    });
  });

  it('sends a GitHub ref to the existing three-segment route', () => {
    expect(providerPrRoutePath(githubPrRef('octocat', 'hello', 7))).toBe(
      '/(app)/pr-review/octocat/hello/7'
    );
  });

  it('sends a Bitbucket ref to the provider route', () => {
    expect(
      providerPrRoutePath({ platform: 'bitbucket', workspace: 'acme', repoSlug: 'api', prId: 42 })
    ).toBe('/(app)/pr-review/bitbucket/acme/api/42');
  });

  it('carries the GitLab instance hint as a query param', () => {
    expect(
      providerPrRoutePath({
        platform: 'gitlab',
        projectPath: 'group/repo',
        mrIid: 3,
        instanceHint: 'https://gitlab.example.com',
      })
    ).toBe('/(app)/pr-review/gitlab/group/repo/3?instance=https%3A%2F%2Fgitlab.example.com');
  });
});

describe('providerPrChildRoutePath', () => {
  it('keeps a GitHub ref on the existing file-navigator sibling', () => {
    expect(providerPrChildRoutePath(githubPrRef('octocat', 'hello', 7), 'file-navigator')).toBe(
      '/(app)/pr-review/octocat/hello/7/file-navigator'
    );
  });

  it('opens the sheet inside the provider layout for a nested GitLab MR', () => {
    expect(
      providerPrChildRoutePath(
        { platform: 'gitlab', projectPath: 'group/sub/repo', mrIid: 12 },
        'file-navigator'
      )
    ).toBe('/(app)/pr-review/gitlab/group/sub/repo/12/file-navigator');
  });

  it('keeps the GitLab instance hint on the child route', () => {
    expect(
      providerPrChildRoutePath(
        {
          platform: 'gitlab',
          projectPath: 'group/repo',
          mrIid: 3,
          instanceHint: 'https://gitlab.example.com',
        },
        'file-navigator'
      )
    ).toBe(
      '/(app)/pr-review/gitlab/group/repo/3/file-navigator?instance=https%3A%2F%2Fgitlab.example.com'
    );
  });

  it('opens the sheet inside the provider layout for a Bitbucket PR', () => {
    expect(
      providerPrChildRoutePath(
        { platform: 'bitbucket', workspace: 'acme', repoSlug: 'api', prId: 42 },
        'file-navigator'
      )
    ).toBe('/(app)/pr-review/bitbucket/acme/api/42/file-navigator');
  });

  it('routes the conversation-comment sheet through the provider layout', () => {
    // The Discussion tab CTA opens the same sheet the GitHub PR 6023 route
    // mounts; a GitLab MR must stay on its own route so the provider scope is
    // published and the post goes to the right provider. GitHub keeps the
    // legacy three-segment path.
    expect(
      providerPrChildRoutePath(githubPrRef('octocat', 'hello', 7), 'conversation-comment')
    ).toBe('/(app)/pr-review/octocat/hello/7/conversation-comment');
    expect(
      providerPrChildRoutePath(
        { platform: 'gitlab', projectPath: 'group/sub/repo', mrIid: 12 },
        'conversation-comment'
      )
    ).toBe('/(app)/pr-review/gitlab/group/sub/repo/12/conversation-comment');
    expect(
      providerPrChildRoutePath(
        { platform: 'bitbucket', workspace: 'acme', repoSlug: 'api', prId: 42 },
        'conversation-comment'
      )
    ).toBe('/(app)/pr-review/bitbucket/acme/api/42/conversation-comment');
  });
});

describe('labels and keys', () => {
  it('uses the provider separator in a row label', () => {
    expect(providerPrRefLabel({ platform: 'gitlab', projectPath: 'g/s/r', mrIid: 12 })).toBe(
      'g/s/r!12'
    );
    expect(providerPrRefLabel(githubPrRef('octocat', 'hello', 7))).toBe('octocat/hello#7');
  });

  it('names the provider term key', () => {
    expect(providerPrTermKey('gitlab')).toBe('prReview.terms.mergeRequest');
    expect(providerPrTermKey('github')).toBe('prReview.terms.pullRequest');
    expect(providerPrTermKey('bitbucket')).toBe('prReview.terms.pullRequest');
  });

  it('keeps two same-named repositories on different providers apart', () => {
    expect(providerPrRefKey(githubPrRef('group', 'repo', 5))).not.toBe(
      providerPrRefKey({ platform: 'gitlab', projectPath: 'group/repo', mrIid: 5 })
    );
  });

  it('builds the provider web URL for GitHub and Bitbucket', () => {
    expect(providerPrWebUrl({ ref: githubPrRef('octocat', 'hello', 7), serverWebUrl: null })).toBe(
      'https://github.com/octocat/hello/pull/7'
    );
    expect(
      providerPrWebUrl({
        ref: { platform: 'bitbucket', workspace: 'acme', repoSlug: 'api', prId: 42 },
        serverWebUrl: '',
      })
    ).toBe('https://bitbucket.org/acme/api/pull-requests/42');
  });

  it('builds a GitLab URL from the loaded merge request', () => {
    const ref = {
      platform: 'gitlab',
      projectPath: 'group/sub/repo',
      mrIid: 12,
      // The instance hint is part of the ref's identity; the URL below is
      // the one the read returned for the loaded merge request.
      instanceHint: 'https://gitlab.staging.example',
    } as const;
    expect(
      providerPrWebUrl({
        ref,
        serverWebUrl: 'https://gitlab.example.com/group/sub/repo/-/merge_requests/12',
      })
    ).toBe('https://gitlab.example.com/group/sub/repo/-/merge_requests/12');
    // A trailing slash, query and fragment are decoration, not part of the URL.
    expect(
      providerPrWebUrl({
        ref,
        serverWebUrl: 'https://gitlab.example.com/g/r/-/merge_requests/1/?x=1#note_9',
      })
    ).toBe('https://gitlab.example.com/g/r/-/merge_requests/1');
  });

  it('has no GitLab URL until a read provides one', () => {
    const ref = {
      platform: 'gitlab',
      projectPath: 'group/repo',
      mrIid: 1,
      instanceHint: 'https://gitlab.staging.example',
    } as const;
    const webUrl = (serverWebUrl: string | null) => providerPrWebUrl({ ref, serverWebUrl });
    expect(webUrl(null)).toBeNull();
    // Bitbucket reports an empty `webUrl`; a GitLab shape that is not an
    // absolute http(s) URL names no host either.
    expect(webUrl('')).toBeNull();
    expect(webUrl('gitlab.example.com/group/repo/-/merge_requests/1')).toBeNull();
    expect(webUrl('gopher://gitlab.example.com/x')).toBeNull();
    expect(webUrl(`${CREDENTIAL_URL}/x`)).toBeNull();
  });

  it('splits a nested project path so owner + repo rebuilds it', () => {
    const ref = { platform: 'gitlab', projectPath: 'group/sub/repo', mrIid: 12 } as const;
    const triple = providerPrTriple(ref);
    expect(triple).toEqual({ owner: 'group/sub', repo: 'repo', number: 12 });
    expect(`${triple.owner}/${triple.repo}`).toBe(providerPrRepoPath(ref));
  });
});
