import { type BuildItemsArgs, type ListItem } from '@/lib/pr-review/diff/pr-diff-list-items';
import { type PrReviewFile } from '@/lib/pr-review/diff/pr-review-file-types';

/**
 * Shared fixtures for the pr-diff list-builder suites. Lives next to the
 * modules under test so every suite builds the same patch, file, and args
 * shapes the builder consumes.
 */

type FilePatchMissingItem = Extract<ListItem, { kind: 'file-patch-missing' }>;

export type SeparatorItem = Extract<ListItem, { kind: 'expand-separator' }>;
export type DiffLineListItem = Extract<ListItem, { kind: 'diff-line' }>;
type PaginationItem = Extract<ListItem, { kind: 'pagination-row' }>;

export function patchMissingItems(items: ListItem[]): FilePatchMissingItem[] {
  return items.filter((i): i is FilePatchMissingItem => i.kind === 'file-patch-missing');
}

function separators(items: ListItem[]): SeparatorItem[] {
  return items.filter((i): i is SeparatorItem => i.kind === 'expand-separator');
}

export function diffLines(items: ListItem[]): DiffLineListItem[] {
  return items.filter((i): i is DiffLineListItem => i.kind === 'diff-line');
}

export function paginationRow(items: ListItem[]): PaginationItem | undefined {
  return items.find((i): i is PaginationItem => i.kind === 'pagination-row');
}

export function makeFile(patch: string, path = 'a.ts'): PrReviewFile {
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

export function baseArgs(overrides: Partial<BuildItemsArgs> = {}): BuildItemsArgs {
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

export const singleHunkPatch = [
  'diff --git a/a.ts b/a.ts',
  '@@ -5,3 +5,3 @@',
  ' context line 5',
  '-old line 6',
  '+new line 6',
  ' context line 7',
].join('\n');

export const twoHunkPatch = [
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

export const largeGapPatch = [
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

export function gapLinesFor(items: ListItem[], path: string, gapIndex: number): DiffLineListItem[] {
  const prefix = `gap-line:${path}:${gapIndex}:`;
  return diffLines(items).filter(l => l.lineKey.startsWith(prefix));
}

export function separatorFor(items: ListItem[], gapIndex: number): SeparatorItem | undefined {
  return separators(items).find(s => s.context.gapIndex === gapIndex);
}
