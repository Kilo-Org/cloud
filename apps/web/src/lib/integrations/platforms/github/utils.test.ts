import { normalizeGitUrl, extractBranchNameFromRef } from './utils';

describe('extractBranchNameFromRef', () => {
  it('strips refs/heads/ prefix', () => {
    expect(extractBranchNameFromRef('refs/heads/main')).toBe('main');
  });

  it('leaves non-prefixed values untouched', () => {
    expect(extractBranchNameFromRef('feature/foo')).toBe('feature/foo');
  });
});

describe('normalizeGitUrl', () => {
  const canonical = 'https://github.com/acme/widgets';

  it('lowercases host and path', () => {
    expect(normalizeGitUrl('https://GitHub.com/Acme/Widgets')).toBe(canonical);
  });

  it('strips .git suffix', () => {
    expect(normalizeGitUrl('https://github.com/acme/widgets.git')).toBe(canonical);
  });

  it('strips .git suffix case-insensitively', () => {
    expect(normalizeGitUrl('https://github.com/acme/widgets.GIT')).toBe(canonical);
  });

  it('handles scp-style ssh urls', () => {
    expect(normalizeGitUrl('git@github.com:Acme/Widgets.git')).toBe(canonical);
  });

  it('handles ssh:// style urls', () => {
    expect(normalizeGitUrl('ssh://git@github.com/Acme/Widgets.git')).toBe(canonical);
  });

  it('handles git:// urls', () => {
    expect(normalizeGitUrl('git://github.com/acme/widgets.git')).toBe(canonical);
  });

  it('preserves additional path segments like enterprise subpaths', () => {
    expect(normalizeGitUrl('https://git.example.com/group/sub/project.git')).toBe(
      'https://git.example.com/group/sub/project'
    );
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeGitUrl('  https://github.com/acme/widgets.git  ')).toBe(canonical);
  });

  it('returns empty string for empty input', () => {
    expect(normalizeGitUrl('')).toBe('');
    expect(normalizeGitUrl('   ')).toBe('');
  });

  it('does not crash on unparseable input and returns a lowercased fallback', () => {
    expect(normalizeGitUrl('not-a-url')).toBe('not-a-url');
  });

  it('yields equal values for https and ssh forms of the same repo', () => {
    expect(normalizeGitUrl('https://github.com/acme/widgets.git')).toBe(
      normalizeGitUrl('git@github.com:acme/widgets.git')
    );
  });
});
