// List builder for the PR diff FlashList. Split from
// `pr-diff-list-items.ts` so each file stays under the max-lines limit.

import { languageForPath } from '@/lib/pr-review/diff/highlight';
import { parsePatch } from '@/lib/pr-review/diff/parse-patch';
import { pushGapItems } from '@/lib/pr-review/diff/pr-diff-gap-builder';
import {
  buildGithubFileUrl,
  type BuildItemsArgs,
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

function pushSideBySideHunk(args: {
  items: ListItem[];
  file: BuildItemsArgs['files'][number];
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
  file: BuildItemsArgs['files'][number];
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

function pushPatchMissingItems(args: {
  items: ListItem[];
  file: BuildItemsArgs['files'][number];
  viewed: boolean;
  githubUrl: string;
}): void {
  args.items.push({
    kind: 'file-patch-missing',
    key: `file-pm:${args.file.path}`,
    file: args.file,
    viewed: args.viewed,
    githubUrl: args.githubUrl,
  });
}

function pushExpandedFileItems(
  items: ListItem[],
  file: BuildItemsArgs['files'][number],
  args: BuildItemsArgs
): void {
  const githubUrl = buildGithubFileUrl({
    owner: args.owner,
    repo: args.repo,
    number: args.number,
    path: file.path,
  });
  const parsed: ParsedFile = file.patch ? parsePatch(file.patch) : { isRename: false, hunks: [] };
  const hunks = parsed.hunks;

  if (file.patchMissing || hunks.length === 0) {
    pushPatchMissingItems({ items, file, viewed: args.viewed(file.path), githubUrl });
    return;
  }

  const language = languageForPath(file.path);
  const fileContext = args.expandedContext[file.path] ?? {};
  const viewMode: DiffViewMode = args.viewMode ?? 'unified';

  for (let hunkIndex = 0; hunkIndex < hunks.length; hunkIndex += 1) {
    const hunk = hunks[hunkIndex];
    if (!hunk) {
      break;
    }

    if (hunkIndex === 0 && hunk.newStart > 1) {
      pushGapItems({
        items,
        file,
        startLine: 1,
        endLine: hunk.newStart - 1,
        gapIndex: -1,
        hunkIndex: 0,
        fileContext,
        parsed,
        language,
        headSha: args.headSha,
        viewMode,
      });
    }

    if (hunkIndex > 0) {
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
            fileContext,
            parsed,
            language,
            headSha: args.headSha,
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
  if (lastHunk) {
    pushGapItems({
      items,
      file,
      startLine: lastHunk.newStart + lastHunk.newLines,
      endLine: Infinity,
      gapIndex: hunks.length,
      hunkIndex: hunks.length - 1,
      fileContext,
      parsed,
      language,
      headSha: args.headSha,
      viewMode,
    });
  }
}

function pushPaginationState(
  items: ListItem[],
  state: PaginationRowItem['state'],
  args: BuildItemsArgs
): void {
  items.push({
    kind: 'pagination-row',
    key: 'pagination-row',
    state,
    loadedFiles: args.isLoading ? 0 : args.fetchToCompletionLoaded,
    totalFiles: args.totalFiles,
  });
}

function pushPaginationItem(items: ListItem[], args: BuildItemsArgs): void {
  if (args.isLoading) {
    pushPaginationState(items, 'loading', args);
    return;
  }
  if (args.hasNextPage) {
    if (args.laterPageError && !args.isFetchingNextPage && !args.fetchToCompletionRunning) {
      pushPaginationState(items, 'error', args);
      return;
    }
    if (args.fetchToCompletionLoaded >= PR_REVIEW_MAX_LISTED_FILES) {
      pushPaginationState(items, 'all-loaded', args);
      return;
    }
    if (args.fetchToCompletionRunning) {
      pushPaginationState(items, 'fetch-to-completion', args);
      return;
    }
    if (args.isFetchingNextPage) {
      pushPaginationState(items, 'loading', args);
      return;
    }
    pushPaginationState(items, 'no-pages', args);
    return;
  }
  if (args.isFetchingNextPage) {
    pushPaginationState(items, 'loading', args);
    return;
  }
  pushPaginationState(items, 'all-loaded', args);
}

export function buildItems(args: BuildItemsArgs): ListItem[] {
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
      viewed: args.viewed(file.path),
    });
    if (isExpanded) {
      pushExpandedFileItems(items, file, args);
    }
  }

  pushPaginationItem(items, args);
  return items;
}
