import { describe, expect, it } from '@jest/globals';

import { resolvePrReviewTarget } from './resolve-pr-review-target';

function resolve(path: readonly unknown[], instance: string | null = null) {
  return resolvePrReviewTarget({ path, instance });
}

describe('resolvePrReviewTarget', () => {
  describe('GitHub', () => {
    it('maps a review path to the pull request', () => {
      expect(resolve(['octocat', 'hello-world', '42'])).toEqual({
        kind: 'redirect',
        url: 'https://github.com/octocat/hello-world/pull/42',
      });
    });

    it('maps a child route the app embeds back to the pull request', () => {
      expect(resolve(['octocat', 'hello-world', '42', 'file-navigator'])).toEqual({
        kind: 'redirect',
        url: 'https://github.com/octocat/hello-world/pull/42',
      });
    });

    it('keeps a dotted repository name intact', () => {
      expect(resolve(['octocat', 'hello.world', '7'])).toEqual({
        kind: 'redirect',
        url: 'https://github.com/octocat/hello.world/pull/7',
      });
    });

    it("maps GitHub's `.github` repository, which starts with a dot", () => {
      expect(resolve(['octocat', '.github', '7'])).toEqual({
        kind: 'redirect',
        url: 'https://github.com/octocat/.github/pull/7',
      });
    });
  });

  describe('GitLab', () => {
    it('defaults to gitlab.com without an instance', () => {
      expect(resolve(['gitlab', 'group', 'sub', 'repo', '9'])).toEqual({
        kind: 'redirect',
        url: 'https://gitlab.com/group/sub/repo/-/merge_requests/9',
      });
    });

    it('treats an explicit gitlab.com instance as the cloud instance', () => {
      expect(resolve(['gitlab', 'group', 'repo', '9'], 'https://gitlab.com')).toEqual({
        kind: 'redirect',
        url: 'https://gitlab.com/group/repo/-/merge_requests/9',
      });
    });

    it('accepts a project segment that starts with an underscore', () => {
      expect(resolve(['gitlab', 'group', '_hidden', '9'])).toEqual({
        kind: 'redirect',
        url: 'https://gitlab.com/group/_hidden/-/merge_requests/9',
      });
    });

    it('asks before following a self-managed host', () => {
      expect(resolve(['gitlab', 'group', 'repo', '9'], 'https://gitlab.example.com')).toEqual({
        kind: 'confirm',
        url: 'https://gitlab.example.com/group/repo/-/merge_requests/9',
        host: 'gitlab.example.com',
      });
    });

    it('keeps a port in the self-managed origin', () => {
      expect(
        resolve(['gitlab', 'group', 'repo', '9'], 'http://gitlab.internal.example:8080')
      ).toEqual({
        kind: 'confirm',
        url: 'http://gitlab.internal.example:8080/group/repo/-/merge_requests/9',
        host: 'gitlab.internal.example:8080',
      });
    });

    it('rejects an instance with a path, query or credentials', () => {
      expect(resolve(['gitlab', 'g', 'r', '9'], 'https://evil.com/phish')).toBeNull();
      expect(resolve(['gitlab', 'g', 'r', '9'], 'https://evil.com/?x=1')).toBeNull();
      const userinfoInstance = ['https://user', 'pass@evil.com'].join(':');
      expect(resolve(['gitlab', 'g', 'r', '9'], userinfoInstance)).toBeNull();
      expect(resolve(['gitlab', 'g', 'r', '9'], 'javascript:alert(1)')).toBeNull();
      expect(resolve(['gitlab', 'g', 'r', '9'], '//evil.com')).toBeNull();
    });

    it('rejects a project path GitLab could not name', () => {
      expect(resolve(['gitlab', 'group', '9'])).toBeNull();
      expect(resolve(['gitlab', 'group', '..', '9'])).toBeNull();
      expect(resolve(['gitlab', 'group', '-', '9'])).toBeNull();
    });
  });

  describe('Bitbucket', () => {
    it('accepts a repository slug that starts with an underscore', () => {
      expect(resolve(['bitbucket', 'acme', '_api', '42'])).toEqual({
        kind: 'redirect',
        url: 'https://bitbucket.org/acme/_api/pull-requests/42',
      });
    });

    it('maps a pull request id', () => {
      expect(resolve(['bitbucket', 'acme', 'api', '42'])).toEqual({
        kind: 'redirect',
        url: 'https://bitbucket.org/acme/api/pull-requests/42',
      });
    });

    it('ignores an instance hint', () => {
      expect(resolve(['bitbucket', 'acme', 'api', '42'], 'https://evil.example.com')).toEqual({
        kind: 'redirect',
        url: 'https://bitbucket.org/acme/api/pull-requests/42',
      });
    });
  });

  describe('malformed paths', () => {
    it.each([
      ['', []],
      ['a lone owner', ['octocat']],
      ['a missing number', ['octocat', 'hello-world']],
      ['a zero number', ['octocat', 'hello-world', '0']],
      ['a padded number', ['octocat', 'hello-world', '007']],
      ['a non-numeric number', ['octocat', 'hello-world', '12abc']],
      ['a fractional number', ['octocat', 'hello-world', '1.5']],
      ['a number past the safe range', ['octocat', 'hello-world', '1000000000']],
      [
        'a sub-path after a child route',
        ['octocat', 'hello-world', '42', 'file-navigator', 'extra'],
      ],
      ['a host in place of the platform', ['github.com', 'octocat', 'hello-world', '42']],
      ['a Bitbucket path with no repository', ['bitbucket', 'acme', '42']],
      ['a GitLab platform with no identity', ['gitlab']],
    ])('returns null for %s', (_label, path) => {
      expect(resolve(path)).toBeNull();
    });

    it('rejects a bare dash segment', () => {
      expect(resolve(['octocat', '-', '42'])).toBeNull();
      expect(resolve(['gitlab', 'group', '-', '9'])).toBeNull();
    });

    it('rejects an empty segment', () => {
      expect(resolve(['octocat', '', '42'])).toBeNull();
    });

    it('rejects a non-string segment', () => {
      expect(resolve([42, 'hello-world', '7'])).toBeNull();
    });
  });

  describe('open-redirect attempts', () => {
    it('rejects an encoded host in place of a segment', () => {
      expect(resolve(['//evil.com', 'repo', '1'])).toBeNull();
      expect(resolve(['@evil.com', 'repo', '1'])).toBeNull();
      expect(resolve(['evil.com', 'repo', '1'])).toBeNull();
    });

    it('rejects a segment that decodes to a path separator', () => {
      expect(resolve(['evil.com/x', 'repo', '1'])).toBeNull();
      expect(resolve(['octocat', 're\\po', '1'])).toBeNull();
    });

    it('rejects traversal segments', () => {
      expect(resolve(['..', 'repo', '1'])).toBeNull();
      expect(resolve(['.', 'repo', '1'])).toBeNull();
      expect(resolve(['octocat', '..', '1'])).toBeNull();
    });

    it('rejects a value that puts a second scheme in the path', () => {
      expect(resolve(['https://evil.com', 'repo', '1'])).toBeNull();
    });

    it('never changes the GitHub host for an all-numeric-looking owner', () => {
      expect(resolve(['evil', 'com', '1'])).toEqual({
        kind: 'redirect',
        url: 'https://github.com/evil/com/pull/1',
      });
    });
  });
});
