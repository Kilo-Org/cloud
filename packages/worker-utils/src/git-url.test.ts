import { describe, it, expect } from 'vitest';
import { isValidGitUrl, sanitizeGitUrl, parseGitUrl, repoFullNameFromGitUrl } from './git-url.js';

describe('isValidGitUrl', () => {
  it('accepts HTTPS URLs', () => {
    expect(isValidGitUrl('https://github.com/org/repo')).toBe(true);
  });

  it('accepts HTTP URLs', () => {
    expect(isValidGitUrl('http://github.com/org/repo')).toBe(true);
  });

  it('accepts SSH URLs', () => {
    expect(isValidGitUrl('git@github.com:org/repo.git')).toBe(true);
  });

  it('rejects malformed strings', () => {
    expect(isValidGitUrl('not-a-valid-url')).toBe(false);
  });

  it('rejects non-http protocols', () => {
    expect(isValidGitUrl('ftp://github.com/repo')).toBe(false);
  });
});

describe('sanitizeGitUrl', () => {
  it('strips credentials from HTTPS URLs', () => {
    expect(sanitizeGitUrl('https://user:pass@github.com/org/repo')).toBe(
      'https://github.com/org/repo'
    );
  });

  it('strips query params and fragments from HTTPS URLs', () => {
    expect(sanitizeGitUrl('https://github.com/org/repo?token=abc#readme')).toBe(
      'https://github.com/org/repo'
    );
  });

  it('strips credentials, query, and fragments together', () => {
    expect(sanitizeGitUrl('https://user:pass@github.com/org/repo.git?ref=main#L10')).toBe(
      'https://github.com/org/repo.git'
    );
  });

  it('preserves SSH URLs without query params', () => {
    expect(sanitizeGitUrl('git@github.com:org/repo.git')).toBe('git@github.com:org/repo.git');
  });

  it('strips query params from SSH URLs', () => {
    expect(sanitizeGitUrl('git@github.com:org/repo.git?ref=main')).toBe(
      'git@github.com:org/repo.git'
    );
  });

  it('handles GitLab subgroups in SSH URLs', () => {
    expect(sanitizeGitUrl('git@gitlab.com:group/subgroup/repo.git')).toBe(
      'git@gitlab.com:group/subgroup/repo.git'
    );
  });

  it('returns input unchanged for unparseable URLs', () => {
    expect(sanitizeGitUrl('some-random-string')).toBe('some-random-string');
  });

  it('preserves HTTP URLs', () => {
    expect(sanitizeGitUrl('http://github.com/org/repo')).toBe('http://github.com/org/repo');
  });
});

describe('parseGitUrl', () => {
  it('parses GitHub HTTPS URLs', () => {
    expect(parseGitUrl('https://github.com/org/repo.git')).toEqual({
      platform: 'github',
      owner: 'org',
      repo: 'repo',
    });
  });

  it('parses GitHub HTTPS URLs without .git suffix', () => {
    expect(parseGitUrl('https://github.com/org/repo')).toEqual({
      platform: 'github',
      owner: 'org',
      repo: 'repo',
    });
  });

  it('parses GitHub SSH URLs', () => {
    expect(parseGitUrl('git@github.com:org/repo.git')).toEqual({
      platform: 'github',
      owner: 'org',
      repo: 'repo',
    });
  });

  it('parses gitlab.com HTTPS URLs', () => {
    expect(parseGitUrl('https://gitlab.com/group/project.git')).toEqual({
      platform: 'gitlab',
      owner: 'group',
      repo: 'project',
    });
  });

  it('parses self-hosted GitLab HTTPS URLs when instance URL is provided', () => {
    expect(
      parseGitUrl('https://gitlab.example.com/team/repo.git', 'https://gitlab.example.com')
    ).toEqual({
      platform: 'gitlab',
      owner: 'team',
      repo: 'repo',
    });
  });

  it('parses gitlab.com SSH URLs', () => {
    expect(parseGitUrl('git@gitlab.com:team/repo.git')).toEqual({
      platform: 'gitlab',
      owner: 'team',
      repo: 'repo',
    });
  });

  it('parses self-hosted GitLab SSH URLs when instance URL is provided', () => {
    expect(
      parseGitUrl('git@gitlab.example.com:team/repo.git', 'https://gitlab.example.com')
    ).toEqual({
      platform: 'gitlab',
      owner: 'team',
      repo: 'repo',
    });
  });

  it('returns null for SSH URLs from unknown non-GitHub hosts', () => {
    expect(parseGitUrl('git@bitbucket.org:team/repo.git')).toBeNull();
  });

  it('returns null for unrecognizable HTTPS URLs without instance URL', () => {
    expect(parseGitUrl('https://example.com/team/repo.git')).toBeNull();
  });

  it('handles GitLab subgroups in HTTPS URLs', () => {
    expect(parseGitUrl('https://gitlab.com/group/subgroup/project.git')).toEqual({
      platform: 'gitlab',
      owner: 'group/subgroup',
      repo: 'project',
    });
  });

  it('handles deep GitLab subgroups in SSH URLs', () => {
    expect(parseGitUrl('git@gitlab.com:group/subgroup/deep/project.git')).toEqual({
      platform: 'gitlab',
      owner: 'group/subgroup/deep',
      repo: 'project',
    });
  });

  it('strips embedded credentials from GitHub HTTPS URLs', () => {
    expect(parseGitUrl('https://x-access-token:ghp_abc123@github.com/org/repo.git')).toEqual({
      platform: 'github',
      owner: 'org',
      repo: 'repo',
    });
  });

  it('strips embedded credentials from GitLab HTTPS URLs', () => {
    expect(parseGitUrl('https://oauth2:token@gitlab.com/group/project.git')).toEqual({
      platform: 'gitlab',
      owner: 'group',
      repo: 'project',
    });
  });

  it('does not false-positive on substring hostname match', () => {
    expect(
      parseGitUrl('https://example.com/team/repo.git', 'https://gitlab.example.com')
    ).toBeNull();
  });

  it('handles trailing .git in all formats', () => {
    expect(parseGitUrl('https://github.com/a/b.git')?.repo).toBe('b');
    expect(parseGitUrl('https://github.com/a/b')?.repo).toBe('b');
    expect(parseGitUrl('git@github.com:a/b.git')?.repo).toBe('b');
  });
});

describe('repoFullNameFromGitUrl', () => {
  it('returns owner/repo for GitHub', () => {
    expect(repoFullNameFromGitUrl('https://github.com/org/repo.git')).toBe('org/repo');
  });

  it('returns full subgroup path for GitLab', () => {
    expect(repoFullNameFromGitUrl('https://gitlab.com/group/subgroup/project.git')).toBe(
      'group/subgroup/project'
    );
  });

  it('returns undefined for unrecognized URLs', () => {
    expect(repoFullNameFromGitUrl('https://example.com/team/repo.git')).toBeUndefined();
  });
});
