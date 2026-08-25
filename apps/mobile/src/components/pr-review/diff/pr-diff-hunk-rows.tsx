// Hunk / expand / pagination / empty-state rows for the PR diff FlashList.

import { Check, ChevronDown, File, GitCommit, X } from '@/components/ui/icons';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useDetailScreenBottomPadding } from '@/lib/screen-insets';
import { type ExpandSeparatorItem } from '@/lib/pr-review/diff/pr-diff-list-items';

const DEFAULT_EXPAND_WINDOW = 20;
const EXPAND_ALL_MAX = 100;

export function HunkHeaderRow({ header }: { header: string }) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  return (
    <View
      className="border-b border-hair-soft bg-secondary px-4 py-1"
      accessibilityLabel={t('prReview.hunkRows.hunkHeader', { header })}
    >
      <Text
        className="font-mono-medium text-[11px]"
        // eslint-disable-next-line react-native/no-inline-styles, react-native/no-color-literals -- dynamic muted color
        style={{ color: colors.mutedForeground }}
        numberOfLines={1}
      >
        {header}
      </Text>
    </View>
  );
}

export function ExpandSeparatorRow({
  item,
  onLoad,
}: {
  item: ExpandSeparatorItem;
  onLoad: (windowSize: number) => void;
}) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  const { startLine, endLine } = item.context;
  const isUnknownEnd = !Number.isFinite(endLine);
  const gapSize = isUnknownEnd ? DEFAULT_EXPAND_WINDOW : endLine - startLine + 1;
  const canExpandAll = !isUnknownEnd && gapSize <= EXPAND_ALL_MAX;
  const isPartial = item.state === 'partial';

  if (item.state === 'unavailable') {
    return (
      <View className="flex-row items-center justify-center gap-2 border-y border-hair-soft bg-secondary px-4 py-2">
        <X size={12} color={colors.mutedForeground} />
        <Text variant="muted" className="text-xs">
          {t('prReview.hunkRows.contextUnavailable')}
        </Text>
      </View>
    );
  }

  if (item.state === 'error') {
    return (
      <Pressable
        onPress={() => {
          onLoad(DEFAULT_EXPAND_WINDOW);
        }}
        className="flex-row items-center justify-center gap-2 border-y border-hair-soft bg-secondary px-4 py-2 active:opacity-70"
        accessibilityRole="button"
        accessibilityLabel={t('prReview.hunkRows.retryLoadingContext')}
      >
        <Text variant="muted" className="text-xs">
          {t('prReview.hunkRows.failedToLoadContext')}
        </Text>
      </Pressable>
    );
  }

  if (item.state === 'loading') {
    return (
      <View className="flex-row items-center justify-center gap-2 border-y border-hair-soft bg-secondary px-4 py-2">
        <GitCommit size={12} color={colors.mutedForeground} />
        <Text variant="muted" className="text-xs">
          {isUnknownEnd
            ? t('prReview.hunkRows.loadingContext')
            : t('prReview.hunkRows.loadingLines', {
                loaded: Math.min(gapSize, DEFAULT_EXPAND_WINDOW),
                total: gapSize,
              })}
        </Text>
      </View>
    );
  }

  const windowEnd = isUnknownEnd
    ? startLine + DEFAULT_EXPAND_WINDOW - 1
    : Math.min(startLine + DEFAULT_EXPAND_WINDOW - 1, endLine);
  const windowSize = Math.min(gapSize, DEFAULT_EXPAND_WINDOW);
  let expandText = isPartial
    ? t('prReview.hunkRows.expandMoreContext')
    : t('prReview.hunkRows.expandContext');
  if (!isUnknownEnd) {
    expandText = isPartial
      ? t('prReview.hunkRows.expandMoreLines', {
          count: windowSize,
          start: startLine,
          end: windowEnd,
        })
      : t('prReview.hunkRows.expandLines', {
          count: windowSize,
          start: startLine,
          end: windowEnd,
        });
  }

  return (
    <View className="flex-row items-center justify-center gap-2 border-y border-hair-soft bg-secondary px-4 py-2">
      <Pressable
        onPress={() => {
          onLoad(DEFAULT_EXPAND_WINDOW);
        }}
        className="flex-row items-center gap-1 active:opacity-70"
        accessibilityRole="button"
        accessibilityLabel={
          isUnknownEnd
            ? t('prReview.hunkRows.expandContext')
            : t('prReview.hunkRows.expandLinesOfContext', { count: DEFAULT_EXPAND_WINDOW })
        }
      >
        <ChevronDown size={12} color={colors.info} />
        {/* eslint-disable-next-line react-native/no-inline-styles, react-native/no-color-literals -- dynamic theme info color */}
        <Text className="text-xs" style={{ color: colors.info }}>
          {expandText}
        </Text>
      </Pressable>
      {canExpandAll ? (
        <Pressable
          onPress={() => {
            onLoad(gapSize);
          }}
          className="ml-3 flex-row items-center gap-1 active:opacity-70"
          accessibilityRole="button"
          accessibilityLabel={t('prReview.hunkRows.expandAllLines', { count: gapSize })}
        >
          <ChevronDown size={12} color={colors.info} />
          {/* eslint-disable-next-line react-native/no-inline-styles, react-native/no-color-literals -- dynamic theme info color */}
          <Text className="text-xs" style={{ color: colors.info }}>
            {t('prReview.hunkRows.expandAll')}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function PaginationRow({
  state,
  loadedFiles,
  totalFiles,
  onRetry,
  onFetchAll,
}: {
  state: 'loading' | 'error' | 'fetch-to-completion' | 'all-loaded' | 'no-pages';
  loadedFiles: number;
  totalFiles: number | null;
  onRetry: () => void;
  onFetchAll: () => void;
}) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  if (state === 'loading') {
    return (
      <View className="flex-row items-center justify-center gap-2 py-4">
        <Text variant="muted" className="text-xs">
          {t('prReview.hunkRows.loadingMoreFiles')}
        </Text>
      </View>
    );
  }
  if (state === 'error') {
    return (
      <Pressable
        onPress={onRetry}
        className="flex-row items-center justify-center gap-2 py-4 active:opacity-70"
        accessibilityRole="button"
        accessibilityLabel={t('prReview.hunkRows.retryLoadingNextPage')}
      >
        {/* eslint-disable-next-line react-native/no-inline-styles, react-native/no-color-literals -- dynamic destructive color */}
        <Text className="text-sm" style={{ color: colors.destructive }}>
          {t('prReview.hunkRows.failedToLoadMoreFiles')}
        </Text>
      </Pressable>
    );
  }
  if (state === 'fetch-to-completion') {
    return (
      <View className="flex-row items-center justify-center gap-2 py-4">
        <Text variant="muted" className="text-xs">
          {totalFiles
            ? t('prReview.hunkRows.loadingAllFilesOf', {
                loaded: loadedFiles.toLocaleString(),
                total: totalFiles.toLocaleString(),
              })
            : t('prReview.hunkRows.loadingAllFiles', { loaded: loadedFiles.toLocaleString() })}
        </Text>
      </View>
    );
  }
  if (state === 'no-pages') {
    return (
      <View className="flex-row items-center justify-center gap-3 py-4">
        <Text variant="muted" className="text-xs">
          {t('prReview.hunkRows.loadedOfTotalFiles', {
            loaded: loadedFiles.toLocaleString(),
            total: totalFiles?.toLocaleString() ?? '?',
          })}
        </Text>
        <Pressable
          onPress={onFetchAll}
          className="rounded-md border border-border bg-card px-3 py-1 active:opacity-70"
          accessibilityRole="button"
          accessibilityLabel={t('prReview.hunkRows.loadAllFiles')}
        >
          <Text className="text-xs font-medium">{t('prReview.hunkRows.loadAll')}</Text>
        </Pressable>
      </View>
    );
  }
  let loadedLabel =
    loadedFiles === 1
      ? t('prReview.hunkRows.fileLoaded', { count: loadedFiles.toLocaleString() })
      : t('prReview.hunkRows.filesLoaded', { count: loadedFiles.toLocaleString() });
  if (totalFiles) {
    loadedLabel =
      loadedFiles === 1
        ? t('prReview.hunkRows.fileLoadedOfTotal', {
            count: loadedFiles.toLocaleString(),
            total: totalFiles.toLocaleString(),
          })
        : t('prReview.hunkRows.filesLoadedOfTotal', {
            count: loadedFiles.toLocaleString(),
            total: totalFiles.toLocaleString(),
          });
  }
  return (
    <View className="flex-row items-center justify-center gap-2 py-4">
      <Check size={12} color={colors.mutedForeground} />
      <Text variant="muted" className="text-xs">
        {loadedLabel}
      </Text>
    </View>
  );
}

export function TabStateMessage({ title, message }: { title: string; message: string }) {
  const bottomPadding = useDetailScreenBottomPadding();
  return (
    <View
      className="flex-1 items-center justify-center gap-2 px-6 py-12"
      style={{ paddingBottom: bottomPadding }}
    >
      <Text className="text-lg font-semibold text-foreground">{title}</Text>
      <Text variant="muted" className="text-center">
        {message}
      </Text>
    </View>
  );
}

export function EmptyFilesView({
  changedFiles,
  onRequestOverview,
}: {
  changedFiles: number;
  onRequestOverview?: () => void;
}) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  const bottomPadding = useDetailScreenBottomPadding();
  return (
    <View
      className="flex-1 items-center justify-center gap-3 px-6 py-16"
      style={{ paddingBottom: bottomPadding }}
    >
      <File size={28} color={colors.mutedForeground} />
      <Text className="text-lg font-semibold text-foreground">{t('prReview.noFilesChanged')}</Text>
      <Text variant="muted" className="text-center">
        {changedFiles === 0
          ? t('prReview.noFilesChangedDescription')
          : t('prReview.hunkRows.filesStillLoading')}
      </Text>
      {onRequestOverview ? (
        <Pressable
          onPress={onRequestOverview}
          className="mt-2 rounded-md border border-border bg-card px-3 py-2 active:opacity-70"
          accessibilityRole="button"
          accessibilityLabel={t('prReview.hunkRows.goToOverviewTab')}
        >
          <Text className="text-sm font-medium">{t('prReview.hunkRows.goToOverview')}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
