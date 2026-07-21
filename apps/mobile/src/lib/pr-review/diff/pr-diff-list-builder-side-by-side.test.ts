import { describe, expect, it } from 'vitest';

import { buildItems } from '@/lib/pr-review/diff/pr-diff-list-builder';
import { type BuildItemsArgs, type ListItem } from '@/lib/pr-review/diff/pr-diff-list-items';
import { type PrReviewFile } from '@/lib/pr-review/diff/pr-review-file-types';

type DiffLineListItem = Extract<ListItem, { kind: 'diff-line' }>;
type SeparatorItem = Extract<ListItem, { kind: 'expand-separator' }>;
type SideBySideRowItem = Extract<ListItem, { kind: 'side-by-side-row' }>;

function diffLines(items: ListItem[]): DiffLineListItem[] {
  return items.filter((i): i is DiffLineListItem => i.kind === 'diff-line');
}
function separators(items: ListItem[]): SeparatorItem[] {
  return items.filter((i): i is SeparatorItem => i.kind === 'expand-separator');
}
function sideBySideRows(items: ListItem[]): SideBySideRowItem[] {
  return items.filter((i): i is SideBySideRowItem => i.kind === 'side-by-side-row');
}
function separatorFor(items: ListItem[], gapIndex: number): SeparatorItem | undefined {
  return separators(items).find(s => s.context.gapIndex === gapIndex);
}

function makeFile(patch: string, path = 'a.ts'): PrReviewFile {
  return {
    path,
    previousPath: null,
    status: 'modified',
    additions: 1,
    deletions: 1,
    patch,
    patchMissing: false,
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
    viewMode: 'side-by-side',
    ...overrides,
  };
}

const singleHunkPatch = [
  'diff --git a/a.ts b/a.ts',
  '@@ -5,3 +5,3 @@',
  ' context line 5',
  '-old line 6',
  '+new line 6',
  ' context line 7',
].join('\n');

describe('buildItems side-by-side gaps', () => {
  it('renders loaded leading-gap context as side-by-side rows, not unified diff lines', () => {
    const items = buildItems(
      baseArgs({
        files: [makeFile(singleHunkPatch)],
        expanded: { 'a.ts': true },
        expandedContext: {
          'a.ts': { [-1]: { status: 'partial', lines: ['leading 1', 'leading 2'], totalLines: 4 } },
        },
      })
    );

    const gapUnified = diffLines(items).filter(l => l.lineKey.startsWith('gap-line:'));
    expect(gapUnified).toHaveLength(0);

    const gapSbs = sideBySideRows(items).filter(r => r.rowKey.startsWith('gap-sbs:a.ts:-1:'));
    expect(gapSbs).toHaveLength(2);
    expect(gapSbs[0]?.row.left?.line.text).toBe('leading 1');
    expect(gapSbs[0]?.row.right?.line.text).toBe('leading 1');
    expect(gapSbs[0]?.row.left?.line.oldLine).toBe(1);
    expect(gapSbs[0]?.row.left?.line.newLine).toBe(1);
    expect(gapSbs[1]?.row.left?.line.text).toBe('leading 2');
    expect(gapSbs[1]?.row.left?.line.newLine).toBe(2);
  });

  it('keeps the leading gap expand-separator full-width in side-by-side mode', () => {
    const items = buildItems(
      baseArgs({
        files: [makeFile(singleHunkPatch)],
        expanded: { 'a.ts': true },
      })
    );
    expect(separatorFor(items, -1)).toMatchObject({ kind: 'expand-separator' });
  });
});
