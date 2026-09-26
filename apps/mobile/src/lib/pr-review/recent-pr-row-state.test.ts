import '@/i18n';

import { describe, expect, it } from 'vitest';

import { selectRecentPrRowState } from './recent-pr-row-state';
import { type RecentPr } from '@/lib/pr-review/recent-prs';

function makeRecent(overrides: Partial<RecentPr> = {}): RecentPr {
  return {
    owner: 'octocat',
    repo: 'hello-world',
    number: 42,
    title: 'Hello PR',
    lastOpenedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('selectRecentPrRowState', () => {
  it('uses the title as primary and the identity as secondary', () => {
    expect(selectRecentPrRowState(makeRecent({ title: 'Hello PR' }))).toEqual({
      primary: 'Hello PR',
      secondary: 'octocat/hello-world#42',
      failed: false,
      provider: 'GitHub',
    });
  });

  it('drops the secondary line when the title is empty (no duplicate)', () => {
    expect(selectRecentPrRowState(makeRecent({ title: '' }))).toEqual({
      primary: 'octocat/hello-world#42',
      secondary: null,
      failed: false,
      provider: 'GitHub',
    });
  });

  it('marks a failed entry', () => {
    expect(selectRecentPrRowState(makeRecent({ lastResult: 'failed' }))).toEqual({
      primary: 'Hello PR',
      secondary: 'octocat/hello-world#42',
      failed: true,
      provider: 'GitHub',
    });
  });

  it('treats a missing lastResult as ok', () => {
    expect(selectRecentPrRowState(makeRecent()).failed).toBe(false);
  });

  it('labels a GitLab entry with the instance path and the ! separator', () => {
    expect(
      selectRecentPrRowState(
        makeRecent({ owner: 'group/sub', repo: 'api', number: 12, platform: 'gitlab' })
      )
    ).toEqual({
      primary: 'Hello PR',
      secondary: 'group/sub/api!12',
      failed: false,
      provider: 'GitLab',
    });
  });

  it('labels a Bitbucket entry with the workspace path', () => {
    expect(
      selectRecentPrRowState(
        makeRecent({ owner: 'acme', repo: 'api', number: 7, platform: 'bitbucket' })
      )
    ).toEqual({
      primary: 'Hello PR',
      secondary: 'acme/api#7',
      failed: false,
      provider: 'Bitbucket',
    });
  });

  it('renders same-named repos across providers as distinct labelled rows', () => {
    const rows = (
      [
        {},
        { platform: 'gitlab' as const },
        { platform: 'bitbucket' as const },
      ] satisfies Partial<RecentPr>[]
    ).map(overrides =>
      selectRecentPrRowState(makeRecent({ owner: 'acme', repo: 'api', number: 7, ...overrides }))
    );

    expect(rows.map(row => row.provider)).toEqual(['GitHub', 'GitLab', 'Bitbucket']);
    expect(rows.map(row => row.secondary)).toEqual(['acme/api#7', 'acme/api!7', 'acme/api#7']);
  });
});
