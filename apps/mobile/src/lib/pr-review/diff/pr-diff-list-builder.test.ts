import { describe, expect, it } from 'vitest';

import { buildItems } from '@/lib/pr-review/diff/pr-diff-list-builder';
import { type BuildItemsArgs, type ListItem } from '@/lib/pr-review/diff/pr-diff-list-items';
import { type PrReviewFile } from '@/lib/pr-review/diff/pr-review-file-types';

type FilePatchMissingItem = Extract<ListItem, { kind: 'file-patch-missing' }>;

type SeparatorItem = Extract<ListItem, { kind: 'expand-separator' }>;
type DiffLineListItem = Extract<ListItem, { kind: 'diff-line' }>;
type PaginationItem = Extract<ListItem, { kind: 'pagination-row' }>;

function patchMissingItems(items: ListItem[]): FilePatchMissingItem[] {
  return items.filter((i): i is FilePatchMissingItem => i.kind === 'file-patch-missing');
}

function separators(items: ListItem[]): SeparatorItem[] {
  return items.filter((i): i is SeparatorItem => i.kind === 'expand-separator');
}
function diffLines(items: ListItem[]): DiffLineListItem[] {
  return items.filter((i): i is DiffLineListItem => i.kind === 'diff-line');
}
function paginationRow(items: ListItem[]): PaginationItem | undefined {
  return items.find((i): i is PaginationItem => i.kind === 'pagination-row');
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

const twoHunkPatch = [
  'diff --git a/a.ts b/a.ts',
  '@@ -5,3 +5,3 @@',
  ' context line 5',
  '-old line 6',
  '+new line 6',
  ' context line 7',
  '@@ -15,3 +15,3 @@',
  ' context line 15',
  '-old line 16',
  '+new line 16',
  ' context line 17',
].join('\n');

const largeGapPatch = [
  'diff --git a/a.ts b/a.ts',
  '@@ -5,3 +5,3 @@',
  ' context line 5',
  '-old line 6',
  '+new line 6',
  ' context line 7',
  '@@ -45,3 +45,3 @@',
  ' context line 45',
  '-old line 46',
  '+new line 46',
  ' context line 47',
].join('\n');

describe('buildItems later-page error', () => {
  it('emits an error pagination row when laterPageError + hasNextPage', () => {
    const items = buildItems(baseArgs({ hasNextPage: true, laterPageError: true }));
    expect(paginationRow(items)).toMatchObject({ kind: 'pagination-row', state: 'error' });
  });

  it('does not emit an error pagination row when laterPageError is false', () => {
    const items = buildItems(baseArgs({ hasNextPage: true, laterPageError: false }));
    expect(paginationRow(items)?.state).not.toBe('error');
  });

  it('does not emit an error pagination row when there is no next page', () => {
    const items = buildItems(baseArgs({ hasNextPage: false, laterPageError: true }));
    expect(paginationRow(items)?.state).not.toBe('error');
  });
});

function gapLinesFor(items: ListItem[], path: string, gapIndex: number): DiffLineListItem[] {
  const prefix = `gap-line:${path}:${gapIndex}:`;
  return diffLines(items).filter(l => l.lineKey.startsWith(prefix));
}

function separatorFor(items: ListItem[], gapIndex: number): SeparatorItem | undefined {
  return separators(items).find(s => s.context.gapIndex === gapIndex);
}

describe('buildItems gap separators', () => {
  it('renders a leading separator when the first hunk starts after line 1', () => {
    const items = buildItems(
      baseArgs({ files: [makeFile(singleHunkPatch)], expanded: { 'a.ts': true } })
    );
    expect(separatorFor(items, -1)).toMatchObject({
      context: { gapIndex: -1, startLine: 1, endLine: 4 },
    });
  });

  it('renders a trailing separator after the last hunk', () => {
    const items = buildItems(
      baseArgs({ files: [makeFile(singleHunkPatch)], expanded: { 'a.ts': true } })
    );
    const trailing = separatorFor(items, 1);
    expect(trailing).toMatchObject({ context: { gapIndex: 1, startLine: 8 }, state: 'idle' });
    expect(Number.isFinite(trailing?.context.endLine ?? 0)).toBe(false);
  });

  it('renders between-hunk separators for gaps larger than 3 lines', () => {
    const items = buildItems(
      baseArgs({ files: [makeFile(twoHunkPatch)], expanded: { 'a.ts': true } })
    );
    expect(separatorFor(items, 0)).toMatchObject({
      context: { gapIndex: 0, startLine: 8, endLine: 14 },
    });
  });
});

describe('buildItems progressive context windowing', () => {
  it('first tap loads window 1 and keeps a partial separator for the remainder', () => {
    const items = buildItems(
      baseArgs({
        files: [makeFile(largeGapPatch)],
        expanded: { 'a.ts': true },
        expandedContext: {
          'a.ts': {
            0: { status: 'partial', lines: Array.from({ length: 20 }, (_, i) => `gap-line-${i}`) },
          },
        },
      })
    );
    const gapLines = gapLinesFor(items, 'a.ts', 0);
    expect(gapLines).toHaveLength(20);
    expect(gapLines[0]?.line.newLine).toBe(8);
    expect(gapLines[19]?.line.newLine).toBe(27);
    expect(separatorFor(items, 0)).toMatchObject({
      state: 'partial',
      context: { gapIndex: 0, startLine: 28, endLine: 44 },
    });
  });

  it('second tap advances to window 2 without duplicating earlier lines', () => {
    const lines = Array.from({ length: 37 }, (_, i) => `gap-line-${i}`);
    const items = buildItems(
      baseArgs({
        files: [makeFile(largeGapPatch)],
        expanded: { 'a.ts': true },
        expandedContext: { 'a.ts': { 0: { status: 'partial', lines } } },
      })
    );
    const gapLines = gapLinesFor(items, 'a.ts', 0);
    expect(gapLines).toHaveLength(37);
    expect(gapLines.map(l => l.line.text)).toEqual(lines);
    expect(gapLines[0]?.line.newLine).toBe(8);
    expect(gapLines[36]?.line.newLine).toBe(44);
    expect(separatorFor(items, 0)).toBeUndefined();
  });

  it('expand all for a small gap removes the separator', () => {
    const items = buildItems(
      baseArgs({
        files: [makeFile(twoHunkPatch)],
        expanded: { 'a.ts': true },
        expandedContext: {
          'a.ts': {
            0: { status: 'partial', lines: Array.from({ length: 7 }, (_, i) => `gap-line-${i}`) },
          },
        },
      })
    );
    expect(gapLinesFor(items, 'a.ts', 0)).toHaveLength(7);
    expect(separatorFor(items, 0)).toBeUndefined();
  });

  it('a failed later window keeps earlier lines and surfaces an error separator', () => {
    const items = buildItems(
      baseArgs({
        files: [makeFile(largeGapPatch)],
        expanded: { 'a.ts': true },
        expandedContext: {
          'a.ts': {
            0: { status: 'error', lines: Array.from({ length: 20 }, (_, i) => `gap-line-${i}`) },
          },
        },
      })
    );
    expect(gapLinesFor(items, 'a.ts', 0)).toHaveLength(20);
    expect(separatorFor(items, 0)).toMatchObject({
      state: 'error',
      context: { startLine: 28, endLine: 44 },
    });
  });

  it('marks expanded gap lines as non-selectable', () => {
    const items = buildItems(
      baseArgs({
        files: [makeFile(largeGapPatch)],
        expanded: { 'a.ts': true },
        expandedContext: {
          'a.ts': {
            0: { status: 'partial', lines: Array.from({ length: 20 }, (_, i) => `gap-line-${i}`) },
          },
        },
      })
    );
    const gapLines = gapLinesFor(items, 'a.ts', 0);
    expect(gapLines.length).toBeGreaterThan(0);
    for (const gapLine of gapLines) {
      expect(gapLine.selectable).toBe(false);
    }
  });

  it('leaves real parsed-hunk lines selectable by default', () => {
    const items = buildItems(
      baseArgs({ files: [makeFile(singleHunkPatch)], expanded: { 'a.ts': true } })
    );
    const lines = diffLines(items).filter(l => l.lineKey.startsWith('line:'));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.selectable).not.toBe(false);
    }
  });
});

describe('buildItems malformed patch', () => {
  it('routes a non-empty patch that parses to zero hunks through the patch-missing fallback', () => {
    const items = buildItems(
      baseArgs({
        files: [makeFile('this is not a valid patch', 'bad.ts')],
        expanded: { 'bad.ts': true },
      })
    );
    const missing = patchMissingItems(items);
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({
      kind: 'file-patch-missing',
      file: { path: 'bad.ts' },
    });
  });
});

describe('buildItems trailing gap totalLines', () => {
  it('uses totalLines to bound the trailing gap once known', () => {
    const items = buildItems(
      baseArgs({
        files: [makeFile(singleHunkPatch)],
        expanded: { 'a.ts': true },
        expandedContext: {
          'a.ts': { 1: { status: 'partial', lines: ['trailing-1'], totalLines: 9 } },
        },
      })
    );
    expect(gapLinesFor(items, 'a.ts', 1)).toHaveLength(1);
    expect(separatorFor(items, 1)).toMatchObject({
      state: 'partial',
      context: { startLine: 9, endLine: 9 },
    });
  });
});
