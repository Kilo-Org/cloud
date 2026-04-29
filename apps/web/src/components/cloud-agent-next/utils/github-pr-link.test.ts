import { describe, test, expect } from '@jest/globals';
import {
  normalizePrBadgeState,
  resolveGithubLink,
  truncatePrTitle,
  type AssociatedPr,
} from './github-pr-link';

const openPr: AssociatedPr = {
  url: 'https://github.com/owner/repo/pull/42',
  number: 42,
  state: 'open',
  title: 'Add feature',
  headSha: 'abc123',
  lastSyncedAt: '2025-01-01T00:00:00.000Z',
};

const mergedPr: AssociatedPr = { ...openPr, state: 'merged', number: 7 };
const closedPr: AssociatedPr = { ...openPr, state: 'closed', number: 9 };

describe('normalizePrBadgeState', () => {
  test('merged stays merged', () => {
    expect(normalizePrBadgeState('merged')).toBe('merged');
  });
  test('open stays open', () => {
    expect(normalizePrBadgeState('open')).toBe('open');
  });
  test('closed stays closed', () => {
    expect(normalizePrBadgeState('closed')).toBe('closed');
  });
  test('unknown state collapses to closed', () => {
    expect(normalizePrBadgeState('weird-state')).toBe('closed');
  });
});

describe('resolveGithubLink', () => {
  test('PR-open: links to the PR URL with state "open"', () => {
    const result = resolveGithubLink({
      gitUrl: 'https://github.com/owner/repo.git',
      branch: 'feature/x',
      associatedPr: openPr,
    });
    expect(result).toEqual({
      kind: 'pr',
      label: 'Open PR #42',
      href: 'https://github.com/owner/repo/pull/42',
      prState: 'open',
      prNumber: 42,
    });
  });

  test('PR-merged: state is "merged"', () => {
    const result = resolveGithubLink({
      gitUrl: 'https://github.com/owner/repo.git',
      branch: 'feature/x',
      associatedPr: mergedPr,
    });
    expect(result.kind).toBe('pr');
    if (result.kind === 'pr') {
      expect(result.prState).toBe('merged');
      expect(result.label).toBe('Open PR #7');
    }
  });

  test('PR-closed: state is "closed"', () => {
    const result = resolveGithubLink({
      gitUrl: 'https://github.com/owner/repo.git',
      branch: 'feature/x',
      associatedPr: closedPr,
    });
    expect(result.kind).toBe('pr');
    if (result.kind === 'pr') expect(result.prState).toBe('closed');
  });

  test('PR-null + GitHub URL + branch: compare link', () => {
    const result = resolveGithubLink({
      gitUrl: 'https://github.com/owner/repo.git',
      branch: 'feature/x',
      associatedPr: null,
    });
    expect(result).toEqual({
      kind: 'compare',
      label: 'Open compare on GitHub',
      href: 'https://github.com/owner/repo/compare/feature/x?expand=1',
    });
  });

  test('PR-null + non-GitHub URL: falls back to plain repo browse URL', () => {
    const result = resolveGithubLink({
      gitUrl: 'https://gitlab.com/group/project.git',
      branch: 'feature/x',
      associatedPr: null,
    });
    expect(result).toEqual({
      kind: 'browse',
      label: 'Open repository',
      href: 'https://gitlab.com/group/project',
    });
  });

  test('PR-null + no branch: repo browse URL even on GitHub', () => {
    const result = resolveGithubLink({
      gitUrl: 'https://github.com/owner/repo.git',
      branch: null,
      associatedPr: null,
    });
    expect(result).toEqual({
      kind: 'browse',
      label: 'Open repository',
      href: 'https://github.com/owner/repo',
    });
  });

  test('no git URL, no PR: nothing to show', () => {
    const result = resolveGithubLink({
      gitUrl: null,
      branch: 'feature/x',
      associatedPr: null,
    });
    expect(result).toEqual({ kind: 'none' });
  });

  test('PR wins even when gitUrl is non-GitHub', () => {
    const result = resolveGithubLink({
      gitUrl: 'https://gitlab.com/group/project.git',
      branch: 'feature/x',
      associatedPr: openPr,
    });
    expect(result.kind).toBe('pr');
    if (result.kind === 'pr') expect(result.href).toBe(openPr.url);
  });
});

describe('truncatePrTitle', () => {
  test('returns empty for null', () => {
    expect(truncatePrTitle(null)).toBe('');
  });

  test('returns untruncated when within limit', () => {
    expect(truncatePrTitle('short title')).toBe('short title');
  });

  test('truncates with ellipsis when too long', () => {
    const long = 'a'.repeat(100);
    const out = truncatePrTitle(long, 20);
    expect(out.length).toBe(20);
    expect(out.endsWith('…')).toBe(true);
  });
});
