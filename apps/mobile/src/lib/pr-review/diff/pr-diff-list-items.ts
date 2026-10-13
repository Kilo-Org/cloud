// Item types + small pure helpers for the PR diff FlashList.
// The list builder lives in `pr-diff-list-builder.ts` so each file
// stays under the max-lines limit.

import {
  PR_REVIEW_MAX_LISTED_FILES,
  type PrReviewFile,
} from '@/lib/pr-review/diff/pr-review-file-types';
import {
  shouldShowTruncationBanner,
  truncationBannerCopy,
} from '@/lib/pr-review/diff/pr-review-truncation';
import {
  type ParsedDiffLine,
  type ParsedHunk,
  type ParsedPatch,
} from '@/lib/pr-review/diff/parse-patch';
import { type SideBySideRow } from '@/lib/pr-review/diff/side-by-side';

type TruncationBannerItem = {
  kind: 'truncation-banner';
  key: string;
  text: string;
};

/**
 * `viewed` is `null` when the diff source does not track viewed files (a
 * session diff): the row then renders no mark-viewed toggle.
 */
type FileHeaderItem = {
  kind: 'file-header';
  key: string;
  file: PrReviewFile;
  expanded: boolean;
  hasDiff: boolean;
  viewed: boolean | null;
};

/**
 * `githubUrl` is `null` when the diff has no web page to fall back to (a
 * session diff): the row then says there is no preview instead of linking out.
 */
type FilePatchMissingItem = {
  kind: 'file-patch-missing';
  key: string;
  file: PrReviewFile;
  viewed: boolean | null;
  githubUrl: string | null;
};

type HunkHeaderItem = {
  kind: 'hunk-header';
  key: string;
  header: string;
};

type DiffLineItem = {
  kind: 'diff-line';
  key: string;
  lineKey: string;
  /** The owning file path — needed by the S7a tap producer to build a `DiffSelection`. */
  filePath: string;
  hunkIndex: number;
  lineIndex: number;
  parsed: ParsedPatch;
  line: ParsedDiffLine;
  language: string | null;
  lineKeyId: string;
  /**
   * Gap/expanded-context lines are read-only and must not participate in
   * diff-line selection. Real parsed-hunk lines are selectable by default.
   */
  selectable?: boolean;
};

type SideBySideRowItem = {
  kind: 'side-by-side-row';
  key: string;
  rowKey: string;
  filePath: string;
  hunkIndex: number;
  rowIndex: number;
  row: SideBySideRow;
  language: string | null;
  rowKeyId: string;
};

type HunkSideBySideHeaderItem = {
  kind: 'hunk-side-by-side';
  key: string;
  hunk: ParsedHunk;
  hunkIndex: number;
  language: string | null;
};

export type ExpandSeparatorItem = {
  kind: 'expand-separator';
  key: string;
  filePath: string;
  ref: { owner: string; repo: string; number: number; ref: string };
  context: {
    gapIndex: number;
    startLine: number;
    endLine: number;
  };
  state: 'idle' | 'loading' | 'error' | 'unavailable' | 'partial';
};

export type PaginationRowItem = {
  kind: 'pagination-row';
  key: string;
  state: 'loading' | 'error' | 'fetch-to-completion' | 'all-loaded' | 'no-pages';
  loadedFiles: number;
  totalFiles: number | null;
};

export type ListItem =
  | TruncationBannerItem
  | FileHeaderItem
  | FilePatchMissingItem
  | HunkHeaderItem
  | DiffLineItem
  | SideBySideRowItem
  | HunkSideBySideHeaderItem
  | ExpandSeparatorItem
  | PaginationRowItem;

export type DiffViewMode = 'unified' | 'side-by-side';

const ITEM_TYPE = {
  Truncation: 'truncation',
  FileHeader: 'file-header',
  FilePatchMissing: 'file-patch-missing',
  HunkHeader: 'hunk-header',
  DiffLine: 'diff-line',
  SideBySideRow: 'side-by-side-row',
  HunkSideBySide: 'hunk-side-by-side',
  ExpandSeparator: 'expand-separator',
  Pagination: 'pagination',
} as const;

export type ExpandSeparatorState =
  | { status: 'idle' }
  | { status: 'loading'; lines: string[]; totalLines?: number }
  | { status: 'partial'; lines: string[]; totalLines?: number }
  | { status: 'error'; lines: string[]; totalLines?: number }
  | { status: 'unavailable' };

export function fileHeaderKey(path: string): string {
  return `file-header:${path}`;
}

export function itemTypeFor(item: ListItem): string {
  switch (item.kind) {
    case 'truncation-banner': {
      return ITEM_TYPE.Truncation;
    }
    case 'file-header': {
      return ITEM_TYPE.FileHeader;
    }
    case 'file-patch-missing': {
      return ITEM_TYPE.FilePatchMissing;
    }
    case 'hunk-header': {
      return ITEM_TYPE.HunkHeader;
    }
    case 'diff-line': {
      return ITEM_TYPE.DiffLine;
    }
    case 'side-by-side-row': {
      return ITEM_TYPE.SideBySideRow;
    }
    case 'hunk-side-by-side': {
      return ITEM_TYPE.HunkSideBySide;
    }
    case 'expand-separator': {
      return ITEM_TYPE.ExpandSeparator;
    }
    case 'pagination-row': {
      return ITEM_TYPE.Pagination;
    }
    default: {
      return ITEM_TYPE.FileHeader;
    }
  }
}

export function buildGithubFileUrl(args: {
  owner: string;
  repo: string;
  number: number;
  path: string;
}): string {
  return `https://github.com/${args.owner}/${args.repo}/pull/${args.number}/files#diff-${encodeURIComponent(args.path)}`;
}

export function addContextLoadState(args: {
  state: Record<string, Record<number, ExpandSeparatorState>>;
  filePath: string;
  gapIndex: number;
  status: 'loading' | 'error' | 'unavailable';
}) {
  const previous = args.state[args.filePath];
  const previousState = previous?.[args.gapIndex];
  if (args.status === 'unavailable') {
    return {
      ...args.state,
      [args.filePath]: {
        ...previous,
        [args.gapIndex]: { status: 'unavailable' },
      },
    } satisfies Record<string, Record<number, ExpandSeparatorState>>;
  }
  const existingLines =
    previousState?.status === 'loading' ||
    previousState?.status === 'partial' ||
    previousState?.status === 'error'
      ? previousState.lines
      : [];
  const nextStatus: ExpandSeparatorState =
    args.status === 'loading'
      ? { status: 'loading', lines: existingLines }
      : { status: 'error', lines: existingLines };
  return {
    ...args.state,
    [args.filePath]: {
      ...previous,
      [args.gapIndex]: nextStatus,
    },
  } satisfies Record<string, Record<number, ExpandSeparatorState>>;
}

export function getCumulativeLines(state: ExpandSeparatorState | undefined): string[] {
  if (state?.status === 'loading' || state?.status === 'partial' || state?.status === 'error') {
    return state.lines;
  }
  return [];
}

export function getTotalLines(state: ExpandSeparatorState | undefined): number | undefined {
  if (state?.status === 'loading' || state?.status === 'partial' || state?.status === 'error') {
    return state.totalLines;
  }
  return undefined;
}

export function setContextLines(args: {
  state: Record<string, Record<number, ExpandSeparatorState>>;
  filePath: string;
  gapIndex: number;
  lines: string[];
  totalLines?: number;
}) {
  const previous = args.state[args.filePath];
  const previousState = previous?.[args.gapIndex];
  const existingLines =
    previousState?.status === 'loading' ||
    previousState?.status === 'partial' ||
    previousState?.status === 'error'
      ? previousState.lines
      : [];
  const nextLines = [...existingLines, ...args.lines];
  const nextStatus: ExpandSeparatorState = {
    status: 'partial',
    lines: nextLines,
    totalLines: args.totalLines,
  };
  return {
    ...args.state,
    [args.filePath]: {
      ...previous,
      [args.gapIndex]: nextStatus,
    },
  } satisfies Record<string, Record<number, ExpandSeparatorState>>;
}

/**
 * Where the listed files come from. A PR diff tracks viewed files, links a
 * missing patch to GitHub, and offers gap expansion read at `headSha`. A
 * session diff is a read-only snapshot with none of those.
 */
export type DiffFileSource =
  | {
      kind: 'pr';
      owner: string;
      repo: string;
      number: number;
      headSha: string;
      expandedContext: Record<string, Record<number, ExpandSeparatorState>>;
      viewed: (path: string) => boolean;
    }
  | { kind: 'session' };

export type DiffFileItemsArgs = {
  files: PrReviewFile[];
  expanded: Record<string, boolean>;
  changedFiles: number;
  /** Unified (default) or side-by-side (tablet only). */
  viewMode?: DiffViewMode;
  source: DiffFileSource;
};

/** The PR review list: its file rows plus the pagination row. */
export type BuildItemsArgs = {
  files: PrReviewFile[];
  expanded: Record<string, boolean>;
  expandedContext: Record<string, Record<number, ExpandSeparatorState>>;
  viewed: (path: string) => boolean;
  headSha: string;
  owner: string;
  repo: string;
  number: number;
  changedFiles: number;
  isLoading: boolean;
  isFetchingNextPage: boolean;
  hasNextPage: boolean;
  laterPageError: boolean;
  fetchToCompletionRunning: boolean;
  fetchToCompletionLoaded: number;
  totalFiles: number | null;
  /** Unified (default) or side-by-side (tablet only). */
  viewMode?: DiffViewMode;
};

export { PR_REVIEW_MAX_LISTED_FILES, shouldShowTruncationBanner, truncationBannerCopy };
