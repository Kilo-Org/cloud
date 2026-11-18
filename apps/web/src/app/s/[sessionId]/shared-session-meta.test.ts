import { formatRepoFromGitUrl, formatSessionDate } from './shared-session-meta';

describe('formatRepoFromGitUrl', () => {
  it('extracts owner/repo from HTTPS URLs', () => {
    expect(formatRepoFromGitUrl('https://github.com/owner/repo')).toBe('owner/repo');
    expect(formatRepoFromGitUrl('https://github.com/owner/repo.git')).toBe('owner/repo');
    expect(formatRepoFromGitUrl('https://github.com/owner/repo/tree/main')).toBe('owner/repo');
  });

  it('extracts owner/repo from SCP-style SSH URLs', () => {
    expect(formatRepoFromGitUrl('git@github.com:owner/repo.git')).toBe('owner/repo');
    expect(formatRepoFromGitUrl('git@gitlab.com:owner/repo')).toBe('owner/repo');
  });

  it('returns null for empty, unparseable, or repo-less values', () => {
    expect(formatRepoFromGitUrl(null)).toBeNull();
    expect(formatRepoFromGitUrl('')).toBeNull();
    expect(formatRepoFromGitUrl('not a url')).toBeNull();
    expect(formatRepoFromGitUrl('https://github.com/owner')).toBeNull();
  });
});

describe('formatSessionDate', () => {
  function localMediumDate(iso: string): string {
    return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' }).format(new Date(iso));
  }

  it('formats an ISO timestamp as a medium date in the runtime timezone', () => {
    expect(formatSessionDate('2026-08-19T12:00:00.000Z')).toBe(
      localMediumDate('2026-08-19T12:00:00.000Z')
    );
  });

  it('formats Postgres-style timestamps with a space separator', () => {
    expect(formatSessionDate('2026-08-19 19:28:42.33099+00')).toBe(
      localMediumDate('2026-08-19T19:28:42.33099Z')
    );
  });

  it('returns null for missing or invalid dates', () => {
    expect(formatSessionDate(null)).toBeNull();
    expect(formatSessionDate('not-a-date')).toBeNull();
  });
});
