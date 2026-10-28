// List builder for the PR diff FlashList. Split from
// `pr-diff-list-items.ts` so each file stays under the max-lines limit.

import { languageForPath } from '@/lib/pr-review/diff/highlight';
import { parsePatch } from '@/lib/pr-review/diff/parse-patch';
import { pushGapItems } from '@/lib/pr-review/diff/pr-diff-gap-builder';
import {
  buildGithubFileUrl,
  type BuildItemsArgs,
  type DiffFileItemsArgs,
  type DiffFileSource,
  type DiffViewMode,
  type ListItem,
  type PaginationRowItem,
  PR_REVIEW_MAX_LISTED_FILES,
  shouldShowTruncationBanner,
  truncationBannerCopy,
} from '@/lib/pr-review/diff/pr-diff-list-items';
import { buildSideBySideRows } from '@/lib/pr-review/diff/side-by-side';

type ParsedFile = ReturnType<typeof parsePatch>;
type ParsedHunk = ParsedFile['hunks'][number];

// Parsed patches keyed by file-object identity. `buildFileItems` re-runs on
// every `viewed` / `expanded` change, and the file DTOs come straight from the
// query pages and are immutable for their lifetime, so a WeakMap cannot go
// stale and is released with the pages when a refetch replaces them. Returning
// the same `ParsedFile` object across rebuilds also keeps `item.parsed` /
// `item.line` reference-stable so `DiffLine`'s memo comparator can hit.
const parsedPatchCache = new WeakMap<object, ParsedFile>();

function parsedPatchFor(file: DiffFileItemsArgs['files'][number]): ParsedFile {
  const cached = parsedPatchCache.get(file);
  if (cached) {
    return cached;
  }
  const parsed: ParsedFile = file.patch ? parsePatch(file.patch) : { isRename: false, hunks: [] };
  parsedPatchCache.set(file, parsed);
  return parsed;
}

function pushSideBySideHunk(args: {
  items: ListItem[];
  file: DiffFileItemsArgs['files'][number];
  hunk: ParsedHunk;
  hunkIndex: number;
  language: string | null;
}): void {
  const { items, file, hunk, hunkIndex, language } = args;
  items.push({
    kind: 'hunk-side-by-side',
    key: `hunk-sbs:${file.path}:${hunkIndex}`,
    hunk,
    hunkIndex,
    language,
  });
  const rows = buildSideBySideRows(hunk);
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (!row) {
      break;
    }
    const rowKeyId = `sbs:${file.path}:${hunkIndex}:${rowIndex}`;
    items.push({
      kind: 'side-by-side-row',
      key: rowKeyId,
      rowKey: rowKeyId,
      filePath: file.path,
      hunkIndex,
      rowIndex,
      row,
      language,
      rowKeyId,
    });
  }
}

function pushUnifiedHunk(args: {
  items: ListItem[];
  file: DiffFileItemsArgs['files'][number];
  hunk: ParsedHunk;
  hunkIndex: number;
  parsed: ParsedFile;
  language: string | null;
}): void {
  const { items, file, hunk, hunkIndex, parsed, language } = args;
  items.push({
    kind: 'hunk-header',
    key: `hunk:${file.path}:${hunkIndex}`,
    header: hunk.header,
  });
  for (let lineIndex = 0; lineIndex < hunk.lines.length; lineIndex += 1) {
    const line = hunk.lines[lineIndex];
    if (!line) {
      break;
    }
    items.push({
      kind: 'diff-line',
      key: `line:${file.path}:${hunkIndex}:${lineIndex}`,
      lineKey: `line:${file.path}:${hunkIndex}:${lineIndex}`,
      filePath: file.path,
      hunkIndex,
      lineIndex,
      parsed,
      line,
      language,
      lineKeyId: `line:${file.path}:${hunkIndex}:${lineIndex}`,
    });
  }
}

function pushPatchMissingItems(
  items: ListItem[],
  file: DiffFileItemsArgs['files'][number],
  source: DiffFileSource
): void {
  const pr = source.kind === 'pr' ? source : null;
  items.push({
    kind: 'file-patch-missing',
    key: `file-pm:${file.path}`,
    file,
    viewed: pr ? pr.viewed(file.path) : null,
    githubUrl: pr
      ? buildGithubFileUrl({ owner: pr.owner, repo: pr.repo, number: pr.number, path: file.path })
      : null,
  });
}

function pushExpandedFileItems(
  items: ListItem[],
  file: DiffFileItemsArgs['files'][number],
  args: DiffFileItemsArgs
): void {
  const parsed: ParsedFile = parsedPatchFor(file);
  const hunks = parsed.hunks;

  if (file.patchMissing || hunks.length === 0) {
    pushPatchMissingItems(items, file, args.source);
    return;
  }

  const language = languageForPath(file.path);
  const viewMode: DiffViewMode = args.viewMode ?? 'unified';
  // Gap expansion reads file contents at the PR head; a session snapshot has
  // no ref to read, so its hunks render without expand separators.
  const gaps =
    args.source.kind === 'pr'
      ? {
          headSha: args.source.headSha,
          fileContext: args.source.expandedContext[file.path] ?? {},
        }
      : null;

  for (let hunkIndex = 0; hunkIndex < hunks.length; hunkIndex += 1) {
    const hunk = hunks[hunkIndex];
    if (!hunk) {
      break;
    }

    if (gaps && hunkIndex === 0 && hunk.newStart > 1) {
      pushGapItems({
        items,
        file,
        startLine: 1,
        endLine: hunk.newStart - 1,
        gapIndex: -1,
        hunkIndex: 0,
        fileContext: gaps.fileContext,
        parsed,
        language,
        headSha: gaps.headSha,
        viewMode,
      });
    }

    if (gaps && hunkIndex > 0) {
      const prevHunk = hunks[hunkIndex - 1];
      if (prevHunk) {
        const prevNewEnd = prevHunk.newStart + prevHunk.newLines - 1;
        const gap = hunk.newStart - prevNewEnd - 1;
        if (gap > 3) {
          pushGapItems({
            items,
            file,
            startLine: prevNewEnd + 1,
            endLine: hunk.newStart - 1,
            gapIndex: hunkIndex - 1,
            hunkIndex,
            fileContext: gaps.fileContext,
            parsed,
            language,
            headSha: gaps.headSha,
            viewMode,
          });
        }
      }
    }

    if (viewMode === 'side-by-side') {
      pushSideBySideHunk({ items, file, hunk, hunkIndex, language });
    } else {
      pushUnifiedHunk({ items, file, hunk, hunkIndex, parsed, language });
    }
  }

  const lastHunk = hunks.at(-1);
  if (gaps && lastHunk) {
    pushGapItems({
      items,
      file,
      startLine: lastHunk.newStart + lastHunk.newLines,
      endLine: Infinity,
      gapIndex: hunks.length,
      hunkIndex: hunks.length - 1,
      fileContext: gaps.fileContext,
      parsed,
      language,
      headSha: gaps.headSha,
      viewMode,
    });
  }
}

function buildPaginationStateItem(
  state: PaginationRowItem['state'],
  args: BuildItemsArgs
): PaginationRowItem {
  return {
    kind: 'pagination-row',
    key: 'pagination-row',
    state,
    loadedFiles: args.isLoading ? 0 : args.fetchToCompletionLoaded,
    totalFiles: args.totalFiles,
  };
}

function buildPaginationItem(args: BuildItemsArgs): PaginationRowItem {
  if (args.isLoading) {
    return buildPaginationStateItem('loading', args);
  }
  if (args.hasNextPage) {
    if (args.laterPageError && !args.isFetchingNextPage && !args.fetchToCompletionRunning) {
      return buildPaginationStateItem('error', args);
    }
    if (args.fetchToCompletionLoaded >= PR_REVIEW_MAX_LISTED_FILES) {
      return buildPaginationStateItem('all-loaded', args);
    }
    if (args.fetchToCompletionRunning) {
      return buildPaginationStateItem('fetch-to-completion', args);
    }
    if (args.isFetchingNextPage) {
      return buildPaginationStateItem('loading', args);
    }
    return buildPaginationStateItem('no-pages', args);
  }
  if (args.isFetchingNextPage) {
    return buildPaginationStateItem('loading', args);
  }
  return buildPaginationStateItem('all-loaded', args);
}

export function buildFileItems(args: DiffFileItemsArgs): ListItem[] {
  const items: ListItem[] = [];

  if (shouldShowTruncationBanner(args.changedFiles)) {
    items.push({
      kind: 'truncation-banner',
      key: 'truncation-banner',
      text: truncationBannerCopy(args.changedFiles),
    });
  }

  for (const file of args.files) {
    const isExpanded = args.expanded[file.path] ?? false;
    items.push({
      kind: 'file-header',
      key: `file-header:${file.path}`,
      file,
      expanded: isExpanded,
      hasDiff: !file.patchMissing,
      viewed: args.source.kind === 'pr' ? args.source.viewed(file.path) : null,
    });
    if (isExpanded) {
      pushExpandedFileItems(items, file, args);
    }
  }

  return items;
}

export { buildPaginationItem };

/** The file-row args of a PR review list. */
function prFileItemsArgs(args: BuildItemsArgs): DiffFileItemsArgs {
  return {
    files: args.files,
    expanded: args.expanded,
    changedFiles: args.changedFiles,
    viewMode: args.viewMode,
    source: {
      kind: 'pr',
      owner: args.owner,
      repo: args.repo,
      number: args.number,
      headSha: args.headSha,
      expandedContext: args.expandedContext,
      viewed: args.viewed,
    },
  };
}

export function buildItems(args: BuildItemsArgs): ListItem[] {
  const items = buildFileItems(prFileItemsArgs(args));
  items.push(buildPaginationItem(args));
  return items;
}
