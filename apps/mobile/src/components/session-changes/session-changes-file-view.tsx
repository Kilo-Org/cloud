// One changed file's saved patch, read from the session's capture. A line tap
// starts a review comment; lines that already carry one keep a marker.

import { FlashList } from '@shopify/flash-list';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { RowsRefreshControl } from '@/components/agents/rows-refresh-control';
import {
  DiffFontMetricsContext,
  useBoundedDiffFontMetrics,
} from '@/components/pr-review/diff/diff-font-metrics';
import { DiffLine } from '@/components/pr-review/diff/diff-line';
import { HunkHeaderRow } from '@/components/pr-review/diff/pr-diff-hunk-rows';
import { PrDiffFileListLoading } from '@/components/pr-review/diff/pr-diff-file-list-loading';
import { QueryError } from '@/components/query-error';
import { EmptyState } from '@/components/empty-state';
import { FileDiff } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { languageForPath } from '@/lib/pr-review/diff/highlight';
import {
  type ParsedDiffLine,
  type ParsedPatch,
  parsePatch,
} from '@/lib/pr-review/diff/parse-patch';
import { useDetailScreenBottomPadding } from '@/lib/screen-insets';
import { type SessionChangesFilePatch } from '@/lib/session-changes-review';
import { type WorktreeReviewComment } from '@kilocode/app-shared/worktree-review';

type FileRow =
  | { kind: 'hunk'; key: string; header: string }
  | {
      kind: 'line';
      key: string;
      line: ParsedDiffLine;
      reviewSide: 'deletions' | 'additions';
      reviewLine: number;
    };

/** The review side and line a diff row anchors to: a deleted line keeps its old number. */
function reviewLineFor(
  line: ParsedDiffLine
): { side: 'deletions' | 'additions'; lineNumber: number } | null {
  if (line.type === 'del') {
    return line.oldLine === undefined ? null : { side: 'deletions', lineNumber: line.oldLine };
  }
  const lineNumber = line.newLine ?? line.oldLine;
  return lineNumber === undefined ? null : { side: 'additions', lineNumber };
}

function reviewLineKey(side: 'deletions' | 'additions', lineNumber: number): string {
  return `${side}:${lineNumber}`;
}

function buildFileRows(parsed: ParsedPatch): FileRow[] {
  const rows: FileRow[] = [];
  for (const [hunkIndex, hunk] of parsed.hunks.entries()) {
    rows.push({ kind: 'hunk', key: `hunk:${hunkIndex}`, header: hunk.header });
    for (const [lineIndex, line] of hunk.lines.entries()) {
      const review = reviewLineFor(line);
      if (review !== null) {
        rows.push({
          kind: 'line',
          key: `line:${hunkIndex}:${lineIndex}`,
          line,
          reviewSide: review.side,
          reviewLine: review.lineNumber,
        });
      }
    }
  }
  return rows;
}

function UnavailableState({
  title,
  description,
  onRetry,
  isRetrying,
  refreshControl,
}: Readonly<{
  title: string;
  description?: string;
  onRetry?: () => void;
  isRetrying?: boolean;
  refreshControl?: React.ReactElement;
}>) {
  if (onRetry) {
    return (
      <QueryError
        variant="server"
        title={title}
        message={description}
        onRetry={onRetry}
        isRetrying={isRetrying}
      />
    );
  }
  return (
    <EmptyState
      icon={FileDiff}
      title={title}
      description={description}
      placement="top"
      refreshControl={refreshControl}
    />
  );
}

/**
 * A review-comment tap target needs a real vertical target: these rows are
 * pressable, unlike the read-only PR diff they mimic, and contiguous diff rows
 * get no vertical hit slop (a vertical slop would mis-route taps to the lower
 * sibling). The bounded row height therefore carries the whole target.
 */
const TAPPABLE_ROW_MIN_HEIGHT = 30;

export function SessionChangesFileView({
  path,
  patchState,
  comments,
  isPending,
  isError,
  refreshing,
  onRefresh,
  onRetry,
  onTapLine,
  commentsDisabledReason,
}: Readonly<{
  path: string;
  patchState: SessionChangesFilePatch | null;
  comments: WorktreeReviewComment[];
  isPending: boolean;
  isError: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  onRetry: () => void;
  onTapLine: (line: { side: 'deletions' | 'additions'; lineNumber: number }) => void;
  commentsDisabledReason: string | undefined;
}>) {
  const { t } = useTranslation();
  const diffFontMetrics = useBoundedDiffFontMetrics();
  const tappableFontMetrics = useMemo(
    () => ({
      ...diffFontMetrics,
      rowMinHeight: Math.max(diffFontMetrics.rowMinHeight, TAPPABLE_ROW_MIN_HEIGHT),
    }),
    [diffFontMetrics]
  );
  const bottomPadding = useDetailScreenBottomPadding();
  const language = useMemo(() => languageForPath(path), [path]);
  const parsed = useMemo(
    () => (patchState?.status === 'available' ? parsePatch(patchState.patch) : null),
    [patchState]
  );
  const rows = useMemo(() => (parsed === null ? [] : buildFileRows(parsed)), [parsed]);
  const commentedLines = useMemo(
    () =>
      new Set(
        comments.map(comment =>
          reviewLineKey(comment.anchor.range.side, comment.anchor.range.startLine)
        )
      ),
    [comments]
  );
  const refreshControl = (
    <RowsRefreshControl
      refreshing={refreshing}
      onRefresh={onRefresh}
      testID="session-changes-file-refresh"
    />
  );

  if (isError) {
    return <QueryError variant="server" onRetry={onRetry} isRetrying={refreshing} />;
  }
  if (isPending || patchState === null) {
    return <PrDiffFileListLoading />;
  }
  if (patchState.status === 'stale') {
    return (
      <UnavailableState
        title={t('agentChat.sessionChanges.staleFile')}
        onRetry={onRetry}
        isRetrying={refreshing}
      />
    );
  }
  if (patchState.status === 'no-longer-listed') {
    return <UnavailableState title={t('agentChat.sessionChanges.fileGone')} />;
  }
  if (patchState.status === 'not-captured') {
    return (
      <UnavailableState
        title={t('agentChat.sessionChanges.notCaptured')}
        onRetry={onRetry}
        isRetrying={refreshing}
      />
    );
  }
  if (patchState.status === 'unavailable') {
    return (
      <UnavailableState
        title={t('agentChat.sessionChanges.fileDiffUnavailable')}
        description={
          patchState.reason === 'binary' ? t('agentChat.sessionChanges.binaryNoDiff') : undefined
        }
      />
    );
  }
  if (rows.length === 0) {
    return (
      <UnavailableState
        title={t('agentChat.sessionChanges.emptyFile')}
        refreshControl={refreshControl}
      />
    );
  }

  return (
    <DiffFontMetricsContext.Provider value={tappableFontMetrics}>
      <View className="flex-1" testID="session-changes-file-view">
        {commentsDisabledReason === undefined ? null : (
          <View className="border-b border-hair-soft bg-secondary px-4 py-2">
            <Text variant="muted" className="text-xs">
              {commentsDisabledReason}
            </Text>
          </View>
        )}
        <FlashList
          data={rows}
          keyExtractor={row => row.key}
          getItemType={row => row.kind}
          extraData={`${diffFontMetrics.scale}:${commentsDisabledReason === undefined ? 'on' : 'off'}:${comments.length}`}
          contentContainerStyle={{ paddingBottom: bottomPadding }}
          refreshControl={refreshControl}
          renderItem={({ item }) => {
            if (item.kind === 'hunk') {
              return <HunkHeaderRow header={item.header} />;
            }
            const disabled = commentsDisabledReason !== undefined;
            return (
              <DiffLine
                line={item.line}
                language={language}
                keyId={item.key}
                isSelected={commentedLines.has(reviewLineKey(item.reviewSide, item.reviewLine))}
                onTap={
                  disabled
                    ? undefined
                    : () => {
                        onTapLine({ side: item.reviewSide, lineNumber: item.reviewLine });
                      }
                }
              />
            );
          }}
          testID="session-changes-file-lines"
        />
      </View>
    </DiffFontMetricsContext.Provider>
  );
}
