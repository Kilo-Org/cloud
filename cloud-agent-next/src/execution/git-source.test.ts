import { describe, it, expect } from 'vitest';
import { getGitCloneUrl, toGitSource } from './git-source.js';
import type { GitSource } from './types.js';

describe('getGitCloneUrl', () => {
  it('builds authenticated GitHub clone URL', () => {
    const source: GitSource = { platform: 'github', githubRepo: 'owner/repo', token: 'ghp_abc123' };
    expect(getGitCloneUrl(source)).toBe(
      'https://x-access-token:ghp_abc123@github.com/owner/repo.git'
    );
  });

  it('builds unauthenticated GitHub clone URL', () => {
    const source: GitSource = { platform: 'github', githubRepo: 'owner/repo' };
    expect(getGitCloneUrl(source)).toBe('https://github.com/owner/repo.git');
  });

  it('builds authenticated GitLab clone URL with oauth2 username', () => {
    const source: GitSource = {
      platform: 'gitlab',
      url: 'https://gitlab.com/acme/repo.git',
      token: 'glpat_xyz',
    };
    expect(getGitCloneUrl(source)).toBe('https://oauth2:glpat_xyz@gitlab.com/acme/repo.git');
  });

  it('builds unauthenticated GitLab clone URL', () => {
    const source: GitSource = { platform: 'gitlab', url: 'https://gitlab.com/acme/repo.git' };
    expect(getGitCloneUrl(source)).toBe('https://gitlab.com/acme/repo.git');
  });

  it('handles GitLab URL with existing credentials (replaces them)', () => {
    const source: GitSource = {
      platform: 'gitlab',
      url: 'https://old:cred@gitlab.com/acme/repo.git',
      token: 'new_token',
    };
    expect(getGitCloneUrl(source)).toBe('https://oauth2:new_token@gitlab.com/acme/repo.git');
  });
});

describe('toGitSource', () => {
  it('returns github variant when githubRepo is provided', () => {
    const result = toGitSource({ githubRepo: 'owner/repo', githubToken: 'token123' });
    expect(result).toEqual({ platform: 'github', githubRepo: 'owner/repo', token: 'token123' });
  });

  it('returns github variant without token', () => {
    const result = toGitSource({ githubRepo: 'owner/repo' });
    expect(result).toEqual({ platform: 'github', githubRepo: 'owner/repo', token: undefined });
  });

  it('returns gitlab variant when gitUrl is provided with gitlab platform', () => {
    const result = toGitSource({
      gitUrl: 'https://gitlab.com/acme/repo.git',
      gitToken: 'token',
      platform: 'gitlab',
    });
    expect(result).toEqual({
      platform: 'gitlab',
      url: 'https://gitlab.com/acme/repo.git',
      token: 'token',
    });
  });

  it('returns gitlab variant for gitUrl even without explicit platform', () => {
    const result = toGitSource({ gitUrl: 'https://gitlab.com/acme/repo.git', gitToken: 'token' });
    expect(result).toEqual({
      platform: 'gitlab',
      url: 'https://gitlab.com/acme/repo.git',
      token: 'token',
    });
  });

  it('prefers githubRepo over gitUrl when both are provided', () => {
    const result = toGitSource({
      githubRepo: 'owner/repo',
      githubToken: 'gh_tok',
      gitUrl: 'https://gitlab.com/x.git',
      gitToken: 'gl_tok',
    });
    expect(result).toEqual({ platform: 'github', githubRepo: 'owner/repo', token: 'gh_tok' });
  });

  it('returns undefined when neither githubRepo nor gitUrl is provided', () => {
    const result = toGitSource({});
    expect(result).toBeUndefined();
  });
});
