import { describe, expect, it } from 'vitest';
import { displayRepoName, relativeTime } from './agents-format';

describe('displayRepoName()', () => {
  it('strips the github host from a bare cloud-session gitUrl', () => {
    expect(displayRepoName('github.com/org/repo')).toBe('org/repo');
  });

  it('strips scheme and .git from an https remote', () => {
    expect(displayRepoName('https://github.com/org/repo.git')).toBe('org/repo');
  });

  it('handles a scp-style ssh remote from the CLI heartbeat', () => {
    expect(displayRepoName('git@github.com:org/repo.git')).toBe('org/repo');
  });

  it('handles an ssh:// remote with a user', () => {
    expect(displayRepoName('ssh://git@github.com/org/repo.git')).toBe('org/repo');
  });

  it('drops an explicit ssh port along with the host', () => {
    expect(displayRepoName('ssh://git@gitlab.example.com:2222/org/repo.git')).toBe('org/repo');
  });

  it('keeps nested groups on a non-github host', () => {
    expect(displayRepoName('https://gitlab.com/group/sub/repo.git')).toBe('group/sub/repo');
  });

  it('passes through a value that is already owner/repo', () => {
    expect(displayRepoName('org/repo')).toBe('org/repo');
  });

  it('returns an empty string unchanged', () => {
    expect(displayRepoName('')).toBe('');
  });
});

describe('relativeTime()', () => {
  it('reports sub-minute ages as Just now', () => {
    expect(relativeTime(new Date(Date.now() - 5000).toISOString())).toBe('Just now');
  });

  it('reports minutes, hours, days, and months', () => {
    expect(relativeTime(new Date(Date.now() - 5 * 60_000).toISOString())).toBe('5m ago');
    expect(relativeTime(new Date(Date.now() - 3 * 3_600_000).toISOString())).toBe('3h ago');
    expect(relativeTime(new Date(Date.now() - 2 * 86_400_000).toISOString())).toBe('2d ago');
    expect(relativeTime(new Date(Date.now() - 70 * 86_400_000).toISOString())).toBe('2mo ago');
  });
});
