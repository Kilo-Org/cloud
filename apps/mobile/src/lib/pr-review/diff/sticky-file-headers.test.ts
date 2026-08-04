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

  it('returns only expanded file-header indices, ignoring collapsed', () => {
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
    const allHeaderIndices = items
      .map((item, index) => (item.kind === 'file-header' ? index : -1))
      .filter(index => index >= 0);

    // Three file headers exist in the built list.
    expect(allHeaderIndices.length).toBe(3);

    const sticky = stickyFileHeaderIndices(items);
    // Only the expanded file sticks; collapsed files yield no sticky index.
    expect(sticky.length).toBe(1);
    const stickyIndex = sticky[0];
    if (stickyIndex === undefined) {
      throw new Error('Expected at least one sticky header index');
    }
    expect(items[stickyIndex]?.kind).toBe('file-header');
    const stickyItem = items[stickyIndex];
    if (stickyItem?.kind === 'file-header') {
      expect(stickyItem.expanded).toBe(true);
    }

    // Expanded file contributes more than its header alone.
    expect(items.some(item => item.kind === 'diff-line' || item.kind === 'hunk-header')).toBe(true);
  });

  it('returns empty when no file is expanded', () => {
    const files = [makeFile('a.ts', smallPatch), makeFile('b.ts', null)];
    const items = buildItems(
      baseArgs({
        files,
        expanded: {},
        changedFiles: files.length,
        totalFiles: files.length,
      })
    );
    // File headers exist but none is expanded.
    const headerCount = items.filter(item => item.kind === 'file-header').length;
    expect(headerCount).toBeGreaterThan(0);
    expect(stickyFileHeaderIndices(items)).toEqual([]);
  });

  it('shifts indices when a truncation banner leads the list', () => {
    // Banner when changedFiles exceeds GitHub's 3000-file list cap.
    // Make files with real patches so they can be expanded.
    const files = [makeFile('a.ts', smallPatch), makeFile('b.ts', smallPatch)];
    const items = buildItems(
      baseArgs({
        files,
        expanded: { 'a.ts': true, 'b.ts': true },
        changedFiles: 3001,
        totalFiles: 3001,
      })
    );

    expect(items[0]?.kind).toBe('truncation-banner');
    const indices = stickyFileHeaderIndices(items);
    // The truncation banner is at index 0, so expanded headers start at index 1.
    expect(indices[0]).toBe(1);
    expect(indices.length).toBe(2);
    expect(indices).toEqual(
      items
        .map((item, index) => {
          if (item.kind === 'file-header' && item.expanded) {
            return index;
          }
          return -1;
        })
        .filter(index => index >= 0)
    );
  });
});
