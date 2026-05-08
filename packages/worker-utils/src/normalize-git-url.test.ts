import { describe, it, expect } from 'vitest';
import { normalizeGitUrl } from './normalize-git-url.js';

describe('normalizeGitUrl', () => {
  it('strips trailing .git', () => {
    expect(normalizeGitUrl('https://github.com/acme/widgets.git')).toBe(
      'https://github.com/acme/widgets'
    );
  });

  it('leaves already-canonical https URLs alone', () => {
    expect(normalizeGitUrl('https://github.com/acme/widgets')).toBe(
      'https://github.com/acme/widgets'
    );
  });

  it('lowercases host and path', () => {
    expect(normalizeGitUrl('https://GitHub.com/ACME/Widgets.git')).toBe(
      'https://github.com/acme/widgets'
    );
  });

  it('converts scp-style ssh URLs to https', () => {
    expect(normalizeGitUrl('git@github.com:acme/widgets.git')).toBe(
      'https://github.com/acme/widgets'
    );
  });

  it('converts ssh:// URLs to https', () => {
    expect(normalizeGitUrl('ssh://git@github.com/acme/widgets.git')).toBe(
      'https://github.com/acme/widgets'
    );
  });

  it('treats https, ssh, and scp forms of the same repo as equal', () => {
    const canonical = normalizeGitUrl('https://github.com/acme/widgets');
    expect(normalizeGitUrl('https://github.com/acme/widgets.git')).toBe(canonical);
    expect(normalizeGitUrl('git@github.com:acme/widgets.git')).toBe(canonical);
    expect(normalizeGitUrl('ssh://git@github.com/acme/widgets.git')).toBe(canonical);
    expect(normalizeGitUrl('https://GITHUB.com/ACME/WIDGETS')).toBe(canonical);
  });

  it('strips trailing slash', () => {
    expect(normalizeGitUrl('https://github.com/acme/widgets/')).toBe(
      'https://github.com/acme/widgets'
    );
  });

  it('returns input lowercased when it cannot be parsed as URL', () => {
    expect(normalizeGitUrl('Not-A-Url')).toBe('not-a-url');
  });

  it('handles empty string', () => {
    expect(normalizeGitUrl('')).toBe('');
  });
});
