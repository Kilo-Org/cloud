import { describe, expect, it, vi } from 'vitest';

import { selectRowPlatformPresentation, sessionPlatformIconKind } from './session-platform-icon';

// The module under test is a .tsx that imports Lucide / brand icons (RN).
// Stub those so the pure mapper can be unit-tested in the node environment.
// (`vi.mock` calls are hoisted above the import by vitest.)
vi.mock('lucide-react-native', () => ({
  Cloud: () => null,
  Code: () => null,
  Terminal: () => null,
}));
vi.mock('@/components/icons/github-icon', () => ({
  GitHubIcon: () => null,
}));
vi.mock('@/components/icons/slack-icon', () => ({
  SlackIcon: () => null,
}));

describe('sessionPlatformIconKind', () => {
  it('maps cloud-agent and cloud-agent-web to cloud', () => {
    expect(sessionPlatformIconKind('cloud-agent')).toBe('cloud');
    expect(sessionPlatformIconKind('cloud-agent-web')).toBe('cloud');
  });

  it('maps cli to terminal', () => {
    expect(sessionPlatformIconKind('cli')).toBe('terminal');
  });

  it('maps vscode and agent-manager to code', () => {
    expect(sessionPlatformIconKind('vscode')).toBe('code');
    expect(sessionPlatformIconKind('agent-manager')).toBe('code');
  });

  it('maps slack to slack', () => {
    expect(sessionPlatformIconKind('slack')).toBe('slack');
  });

  it('maps github to github', () => {
    expect(sessionPlatformIconKind('github')).toBe('github');
  });

  it('returns null for unmapped and absent platforms', () => {
    expect(sessionPlatformIconKind('unknown')).toBeNull();
    expect(sessionPlatformIconKind('other')).toBeNull();
    expect(sessionPlatformIconKind('gastown')).toBeNull();
    expect(sessionPlatformIconKind('linear')).toBeNull();
    expect(sessionPlatformIconKind('app-builder')).toBeNull();
    expect(sessionPlatformIconKind('agent-builder')).toBeNull();
    expect(sessionPlatformIconKind(null)).toBeNull();
    expect(sessionPlatformIconKind(undefined)).toBeNull();
    expect(sessionPlatformIconKind('')).toBeNull();
  });
});

describe('selectRowPlatformPresentation', () => {
  const repoGitUrl = 'git@github.com:org/my-repo.git';

  it('resolves icon kind for variant=list with a mapped platform', () => {
    expect(
      selectRowPlatformPresentation({
        platform: 'cli',
        variant: 'list',
        needsInput: false,
        gitUrl: repoGitUrl,
      })
    ).toEqual({ iconKind: 'terminal', spokenPlatform: 'cli' });
  });

  it('returns null iconKind for variant=card', () => {
    expect(
      selectRowPlatformPresentation({
        platform: 'cli',
        variant: 'card',
        needsInput: false,
        gitUrl: repoGitUrl,
      })
    ).toEqual({ iconKind: null, spokenPlatform: undefined });
  });

  it('leaves spokenPlatform undefined when needsInput', () => {
    expect(
      selectRowPlatformPresentation({
        platform: 'cli',
        variant: 'list',
        needsInput: true,
        gitUrl: repoGitUrl,
      })
    ).toEqual({ iconKind: 'terminal', spokenPlatform: undefined });
  });

  it('leaves spokenPlatform undefined when the git URL yields no repo name', () => {
    expect(
      selectRowPlatformPresentation({
        platform: 'cli',
        variant: 'list',
        needsInput: false,
        gitUrl: null,
      })
    ).toEqual({ iconKind: 'terminal', spokenPlatform: undefined });

    expect(
      selectRowPlatformPresentation({
        platform: 'cli',
        variant: 'list',
        needsInput: false,
        gitUrl: undefined,
      })
    ).toEqual({ iconKind: 'terminal', spokenPlatform: undefined });

    expect(
      selectRowPlatformPresentation({
        platform: 'cli',
        variant: 'list',
        needsInput: false,
        gitUrl: '',
      })
    ).toEqual({ iconKind: 'terminal', spokenPlatform: undefined });
  });

  it('sets spokenPlatform when an icon shows with a repo-name eyebrow (stored git_url shape)', () => {
    // Stored rows pass session.git_url into the same gitUrl param.
    expect(
      selectRowPlatformPresentation({
        platform: 'cloud-agent',
        variant: 'list',
        needsInput: false,
        gitUrl: 'https://github.com/org/stored-repo.git',
      })
    ).toEqual({ iconKind: 'cloud', spokenPlatform: 'cloud-agent' });
  });

  it('sets spokenPlatform when an icon shows with a repo-name eyebrow (live gitUrl shape)', () => {
    // Live rows pass session.gitUrl (camelCase ActiveSession field).
    expect(
      selectRowPlatformPresentation({
        platform: 'cli',
        variant: 'list',
        needsInput: false,
        gitUrl: 'git@github.com:org/live-repo.git',
      })
    ).toEqual({ iconKind: 'terminal', spokenPlatform: 'cli' });
  });

  it('returns null iconKind and no spoken platform for unmapped platforms', () => {
    expect(
      selectRowPlatformPresentation({
        platform: 'linear',
        variant: 'list',
        needsInput: false,
        gitUrl: repoGitUrl,
      })
    ).toEqual({ iconKind: null, spokenPlatform: undefined });
  });
});
