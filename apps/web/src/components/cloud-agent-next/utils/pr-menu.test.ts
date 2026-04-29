import { describe, test, expect } from '@jest/globals';
import { resolveGitHubMenuAction, prStateVisual } from './pr-menu';

const pr = {
  url: 'https://github.com/owner/repo/pull/42',
  number: 42,
  state: 'open',
  title: 'Fix the thing',
  headSha: 'abc123',
  lastSyncedAt: '2026-01-01T00:00:00.000Z',
};

describe('resolveGitHubMenuAction', () => {
  test('PR present -> links to PR', () => {
    expect(
      resolveGitHubMenuAction({
        gitUrl: 'https://github.com/owner/repo',
        branch: 'feature',
        associatedPr: pr,
      })
    ).toEqual({
      label: 'Open PR #42',
      href: 'https://github.com/owner/repo/pull/42',
      kind: 'pr',
    });
  });

  test('PR null + GitHub URL + branch -> compare', () => {
    expect(
      resolveGitHubMenuAction({
        gitUrl: 'https://github.com/owner/repo.git',
        branch: 'my-branch',
        associatedPr: null,
      })
    ).toEqual({
      label: 'Open compare on GitHub',
      href: 'https://github.com/owner/repo/compare/my-branch?expand=1',
      kind: 'compare',
    });
  });

  test('non-GitHub URL falls back to repo browse', () => {
    const action = resolveGitHubMenuAction({
      gitUrl: 'https://gitlab.com/owner/repo',
      branch: 'main',
      associatedPr: null,
    });
    expect(action).toEqual({
      label: 'Open repository',
      href: 'https://gitlab.com/owner/repo',
      kind: 'browse',
    });
  });

  test('GitHub URL but no branch -> repo browse', () => {
    const action = resolveGitHubMenuAction({
      gitUrl: 'https://github.com/owner/repo',
      branch: null,
      associatedPr: null,
    });
    expect(action).toEqual({
      label: 'Open repository',
      href: 'https://github.com/owner/repo',
      kind: 'browse',
    });
  });

  test('no git URL + no PR -> null', () => {
    expect(
      resolveGitHubMenuAction({ gitUrl: null, branch: 'x', associatedPr: null })
    ).toBeNull();
  });

  test('PR takes priority over non-GitHub URL', () => {
    const action = resolveGitHubMenuAction({
      gitUrl: 'https://gitlab.com/owner/repo',
      branch: 'main',
      associatedPr: pr,
    });
    expect(action?.kind).toBe('pr');
    expect(action?.href).toBe(pr.url);
  });
});

describe('prStateVisual', () => {
  test('open is green', () => {
    const v = prStateVisual('open');
    expect(v.label).toBe('open');
    expect(v.chipClassName).toContain('green');
    expect(v.dotClassName).toContain('green');
  });

  test('merged is purple', () => {
    const v = prStateVisual('merged');
    expect(v.label).toBe('merged');
    expect(v.chipClassName).toContain('purple');
    expect(v.dotClassName).toContain('purple');
  });

  test('closed is muted/gray', () => {
    const v = prStateVisual('closed');
    expect(v.label).toBe('closed');
    expect(v.chipClassName).toContain('muted');
  });

  test('unknown state falls back to gray with raw label', () => {
    const v = prStateVisual('draft');
    expect(v.label).toBe('draft');
    expect(v.dotClassName).toContain('gray');
  });

  test('case-insensitive', () => {
    expect(prStateVisual('OPEN').label).toBe('open');
    expect(prStateVisual('MERGED').chipClassName).toContain('purple');
  });
});
