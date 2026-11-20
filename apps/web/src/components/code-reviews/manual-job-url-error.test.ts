import { getManualJobUrlError } from './manual-job-url-error';

const GITHUB_ERROR = 'Enter a GitHub pull request URL like https://github.com/owner/repo/pull/123.';
const GITLAB_ERROR =
  'Enter a GitLab merge request URL like https://gitlab.com/group/project/-/merge_requests/123.';

describe('getManualJobUrlError', () => {
  describe('github', () => {
    it('accepts a canonical pull request URL', () => {
      expect(
        getManualJobUrlError('https://github.com/owner/repo/pull/123', 'github', false)
      ).toBeNull();
    });

    it('accepts a link copied from a pull request sub-page', () => {
      expect(
        getManualJobUrlError('https://github.com/owner/repo/pull/123/files', 'github', false)
      ).toBeNull();
    });

    it('rejects a review segment that only appears in a query string', () => {
      expect(
        getManualJobUrlError('https://github.com/owner/repo/issues?q=/pull/123', 'github', false)
      ).toBe(GITHUB_ERROR);
    });

    it('rejects a pull request URL on another host', () => {
      expect(getManualJobUrlError('https://example.com/owner/repo/pull/123', 'github', false)).toBe(
        GITHUB_ERROR
      );
    });
  });

  describe('gitlab', () => {
    it('accepts a canonical merge request URL', () => {
      expect(
        getManualJobUrlError(
          'https://gitlab.com/group/project/-/merge_requests/123',
          'gitlab',
          true
        )
      ).toBeNull();
    });

    it('accepts a link copied from a merge request sub-page', () => {
      expect(
        getManualJobUrlError(
          'https://gitlab.com/group/project/-/merge_requests/123/diffs',
          'gitlab',
          true
        )
      ).toBeNull();
    });

    it('rejects a review segment that only appears in a query string', () => {
      expect(
        getManualJobUrlError(
          'https://gitlab.com/group/project/issues?q=/-/merge_requests/123',
          'gitlab',
          true
        )
      ).toBe(GITLAB_ERROR);
    });

    it('accepts another host when local development is disabled', () => {
      expect(
        getManualJobUrlError(
          'https://gitlab.example.com/group/project/-/merge_requests/123',
          'gitlab',
          false
        )
      ).toBeNull();
    });

    it('names the local-development requirement for another host when it is enabled', () => {
      expect(
        getManualJobUrlError(
          'https://gitlab.example.com/group/project/-/merge_requests/123',
          'gitlab',
          true
        )
      ).toBe('Local GitLab jobs require a public gitlab.com merge request URL.');
    });
  });

  it.each([
    ['github', '', 'Enter a GitHub pull request URL.'],
    ['gitlab', '   ', 'Enter a GitLab merge request URL.'],
    ['github', 'not a url', 'Enter a valid URL.'],
    ['gitlab', 'not a url', 'Enter a valid URL.'],
    ['github', 'ftp://github.com/owner/repo/pull/123', 'URL must use http or https.'],
    [
      'gitlab',
      'ftp://gitlab.com/group/project/-/merge_requests/123',
      'URL must use http or https.',
    ],
  ] as const)('answers %s for %j', (platform, value, message) => {
    expect(getManualJobUrlError(value, platform, false)).toBe(message);
  });
});
