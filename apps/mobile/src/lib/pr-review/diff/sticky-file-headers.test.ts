import { describe, expect, it } from 'vitest';

import { buildItems } from '@/lib/pr-review/diff/pr-diff-list-builder';
import { type BuildItemsArgs } from '@/lib/pr-review/diff/pr-diff-list-items';
import { type PrReviewFile } from '@/lib/pr-review/diff/pr-review-file-types';
import { stickyFileHeaderIndices } from '@/lib/pr-review/diff/sticky-file-headers';

function makeFile(path: string, patch: string | null): PrReviewFile {
  return {
    path,
    previousPath: null,
    status: 'modified',
    additions: patch ? 1 : 0,
    deletions: patch ? 1 : 0,
    patch,
    patchMissing: patch === null,
  };
}

function baseArgs(overrides: Partial<BuildItemsArgs> = {}): BuildItemsArgs {
  return {
    files: [],
    expanded: {},
    expandedContext: {},
    viewed: () => false,
    headSha: 'abc',
    owner: 'owner',
    repo: 'repo',
    number: 1,
    changedFiles: 0,
    isLoading: false,
    isFetchingNextPage: false,
    hasNextPage: false,
    laterPageError: false,
    fetchToCompletionRunning: false,
    fetchToCompletionLoaded: 0,
    totalFiles: null,
    ...overrides,
  };
}

const smallPatch = [
  'diff --git a/a.ts b/a.ts',
  '@@ -1,2 +1,2 @@',
  ' line one',
  '-old',
  '+new',
].join('\n');

describe('stickyFileHeaderIndices', () => {
  it('returns empty for empty input', () => {
    expect(stickyFileHeaderIndices([])).toEqual([]);
  });

  it('returns indices of expanded and collapsed file headers', () => {
    const files = [
      makeFile('expanded.ts', smallPatch),
      makeFile('collapsed-a.ts', smallPatch),
      makeFile('collapsed-b.ts', null),
    ];
    const items = buildItems(
      baseArgs({
        files,
        expanded: { 'expanded.ts': true },
        changedFiles: files.length,
        totalFiles: files.length,
      })
    );
    const headerIndices = items
      .map((item, index) => (item.kind === 'file-header' ? index : -1))
      .filter(index => index >= 0);

    expect(stickyFileHeaderIndices(items)).toEqual(headerIndices);
    expect(headerIndices.length).toBe(3);
    // Expanded file contributes more than its header alone.
    expect(items.some(item => item.kind === 'diff-line' || item.kind === 'hunk-header')).toBe(true);
  });

  it('shifts indices when a truncation banner leads the list', () => {
    // Banner when changedFiles exceeds GitHub's 3000-file list cap.
    const files = [makeFile('a.ts', null), makeFile('b.ts', null)];
    const items = buildItems(
      baseArgs({
        files,
        changedFiles: 3001,
        totalFiles: 3001,
      })
    );

    expect(items[0]?.kind).toBe('truncation-banner');
    const indices = stickyFileHeaderIndices(items);
    expect(indices[0]).toBe(1);
    expect(indices).toEqual(
      items
        .map((item, index) => (item.kind === 'file-header' ? index : -1))
        .filter(index => index >= 0)
    );
  });
});
