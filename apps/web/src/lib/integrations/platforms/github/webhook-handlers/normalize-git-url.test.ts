import { normalizeGitUrl } from './normalize-git-url';

describe('normalizeGitUrl', () => {
  it('trims trailing .git from https URLs', () => {
    expect(normalizeGitUrl('https://github.com/acme/widgets.git')).toBe(
      'https://github.com/acme/widgets'
    );
  });

  it('returns the canonical https form when already canonical', () => {
    expect(normalizeGitUrl('https://github.com/acme/widgets')).toBe(
      'https://github.com/acme/widgets'
    );
  });

  it('converts git@github.com: ssh form into https', () => {
    expect(normalizeGitUrl('git@github.com:acme/widgets.git')).toBe(
      'https://github.com/acme/widgets'
    );
  });

  it('converts ssh form without .git suffix', () => {
    expect(normalizeGitUrl('git@github.com:acme/widgets')).toBe('https://github.com/acme/widgets');
  });

  it('lower-cases host and owner/repo path', () => {
    expect(normalizeGitUrl('https://GitHub.com/ACME/Widgets.git')).toBe(
      'https://github.com/acme/widgets'
    );
  });

  it('treats https and ssh variants of the same repo as equal', () => {
    const a = normalizeGitUrl('https://github.com/acme/widgets.git');
    const b = normalizeGitUrl('git@github.com:acme/widgets.git');
    const c = normalizeGitUrl('https://github.com/acme/widgets');
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it('strips a trailing slash', () => {
    expect(normalizeGitUrl('https://github.com/acme/widgets/')).toBe(
      'https://github.com/acme/widgets'
    );
  });

  it('returns empty string for empty input', () => {
    expect(normalizeGitUrl('')).toBe('');
    expect(normalizeGitUrl('   ')).toBe('');
  });
});
