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
    });
  });

  it('drops the secondary line when the title is empty (no duplicate)', () => {
    expect(selectRecentPrRowState(makeRecent({ title: '' }))).toEqual({
      primary: 'octocat/hello-world#42',
      secondary: null,
      failed: false,
    });
  });

  it('marks a failed entry', () => {
    expect(selectRecentPrRowState(makeRecent({ lastResult: 'failed' }))).toEqual({
      primary: 'Hello PR',
      secondary: 'octocat/hello-world#42',
      failed: true,
    });
  });

  it('treats a missing lastResult as ok', () => {
    expect(selectRecentPrRowState(makeRecent()).failed).toBe(false);
  });
});
