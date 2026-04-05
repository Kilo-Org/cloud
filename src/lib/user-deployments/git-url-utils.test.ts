import { isHTTPsUrl, extractRepoNameFromUrl, extractDisplayNameFromUrl } from './git-url-utils';

describe('isHTTPsUrl', () => {
  it('returns true for valid HTTPS URLs', () => {
    expect(isHTTPsUrl('https://github.com/owner/repo')).toBe(true);
    expect(isHTTPsUrl('https://gitlab.com/owner/repo.git')).toBe(true);
    expect(isHTTPsUrl('https://bitbucket.org/owner/repo')).toBe(true);
  });

  it('returns false for HTTP URLs', () => {
    expect(isHTTPsUrl('http://github.com/owner/repo')).toBe(false);
    expect(isHTTPsUrl('http://gitlab.com/owner/repo.git')).toBe(false);
  });

  it('returns false for SSH URLs', () => {
    expect(isHTTPsUrl('git@github.com:owner/repo.git')).toBe(false);
    expect(isHTTPsUrl('ssh://git@github.com/owner/repo.git')).toBe(false);
  });

  it('returns false for invalid URLs', () => {
    expect(isHTTPsUrl('')).toBe(false);
    expect(isHTTPsUrl('not-a-url')).toBe(false);
    expect(isHTTPsUrl('ftp://example.com/file')).toBe(false);
  });
});

describe('extractRepoNameFromUrl', () => {
  it('extracts owner and repo name from GitHub URLs', () => {
    expect(extractRepoNameFromUrl('https://github.com/owner/repo')).toBe('owner-repo');
    expect(extractRepoNameFromUrl('https://github.com/owner/repo.git')).toBe('owner-repo');
  });

  it('extracts owner and repo name from GitLab URLs', () => {
    expect(extractRepoNameFromUrl('https://gitlab.com/owner/repo')).toBe('owner-repo');
    expect(extractRepoNameFromUrl('https://gitlab.com/owner/repo.git')).toBe('owner-repo');
  });

  it('handles nested paths (GitLab subgroups)', () => {
    expect(extractRepoNameFromUrl('https://gitlab.com/group/subgroup/repo')).toBe('subgroup-repo');
    expect(extractRepoNameFromUrl('https://gitlab.com/org/team/project/repo.git')).toBe(
      'project-repo'
    );
  });

  it('handles URLs with trailing slashes', () => {
    expect(extractRepoNameFromUrl('https://github.com/owner/repo/')).toBe('owner-repo');
  });

  it('returns fallback for invalid URLs', () => {
    const result = extractRepoNameFromUrl('not-a-valid-url');
    expect(result).toMatch(/^repo-[a-z0-9]{6}$/);
  });
});

describe('extractDisplayNameFromUrl', () => {
  it('returns the URL unchanged when no credentials are present', () => {
    expect(extractDisplayNameFromUrl('https://github.com/owner/repo')).toBe(
      'https://github.com/owner/repo'
    );
    expect(extractDisplayNameFromUrl('https://gitlab.com/owner/repo.git')).toBe(
      'https://gitlab.com/owner/repo.git'
    );
  });

  it('strips username credentials from URLs', () => {
    expect(extractDisplayNameFromUrl('https://user@github.com/owner/repo')).toBe(
      'https://github.com/owner/repo'
    );
    expect(extractDisplayNameFromUrl('https://x-access-token@github.com/owner/repo')).toBe(
      'https://github.com/owner/repo'
    );
  });

  it('strips username and password credentials from URLs', () => {
    expect(extractDisplayNameFromUrl('https://user:token@github.com/owner/repo')).toBe(
      'https://github.com/owner/repo'
    );
    expect(extractDisplayNameFromUrl('https://x-access-token:ghp_xxx@github.com/owner/repo')).toBe(
      'https://github.com/owner/repo'
    );
  });

  it('returns "repository" for invalid URLs', () => {
    expect(extractDisplayNameFromUrl('')).toBe('repository');
    expect(extractDisplayNameFromUrl('not-a-url')).toBe('repository');
  });
});
