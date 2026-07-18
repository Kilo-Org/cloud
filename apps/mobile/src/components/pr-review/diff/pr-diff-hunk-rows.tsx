// Hunk / expand / pagination / empty-state rows for the PR diff FlashList.

import { Check, ChevronDown, File, GitCommit, X } from 'lucide-react-native';
import { Pressable, View, type ViewStyle } from 'react-native';

import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type ExpandSeparatorItem } from '@/lib/pr-review/diff/pr-diff-list-items';

const DEFAULT_EXPAND_WINDOW = 20;
const EXPAND_ALL_MAX = 100;

// Module-level style constants so FlashList content containers avoid
// recreating object literals (and so no-inline-styles is satisfied).
export const LIST_CONTENT_STYLE: ViewStyle = { paddingBottom: 24 };

export function HunkHeaderRow({ header }: { header: string }) {
  const colors = useThemeColors();
  return (
    <View
      className="border-b border-hair-soft bg-secondary px-4 py-1"
      accessibilityLabel={`Hunk header ${header}`}
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
          Context unavailable at this ref
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
        accessibilityLabel="Retry loading context"
      >
        <Text variant="muted" className="text-xs">
          Failed to load context — tap to retry
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
            ? 'Loading context…'
            : `Loading ${Math.min(gapSize, DEFAULT_EXPAND_WINDOW)} of ${gapSize} lines…`}
        </Text>
      </View>
    );
  }

  const windowEnd = isUnknownEnd
    ? startLine + DEFAULT_EXPAND_WINDOW - 1
    : Math.min(startLine + DEFAULT_EXPAND_WINDOW - 1, endLine);
  const expandLabel = isPartial ? 'Expand more' : 'Expand';

  return (
    <View className="flex-row items-center justify-center gap-2 border-y border-hair-soft bg-secondary px-4 py-2">
      <Pressable
        onPress={() => {
          onLoad(DEFAULT_EXPAND_WINDOW);
        }}
        className="flex-row items-center gap-1 active:opacity-70"
        accessibilityRole="button"
        accessibilityLabel={
          isUnknownEnd ? 'Expand context' : `Expand ${DEFAULT_EXPAND_WINDOW} lines of context`
        }
      >
        <ChevronDown size={12} color={colors.info} />
        {/* eslint-disable-next-line react-native/no-inline-styles, react-native/no-color-literals -- dynamic theme info color */}
        <Text className="text-xs" style={{ color: colors.info }}>
          {isUnknownEnd
            ? `${expandLabel} context`
            : `${expandLabel} ${Math.min(gapSize, DEFAULT_EXPAND_WINDOW)} lines (${startLine}–${windowEnd})`}
        </Text>
      </Pressable>
      {canExpandAll ? (
        <Pressable
          onPress={() => {
            onLoad(gapSize);
          }}
          className="ml-3 flex-row items-center gap-1 active:opacity-70"
          accessibilityRole="button"
          accessibilityLabel={`Expand all ${gapSize} lines`}
        >
          <ChevronDown size={12} color={colors.info} />
          {/* eslint-disable-next-line react-native/no-inline-styles, react-native/no-color-literals -- dynamic theme info color */}
          <Text className="text-xs" style={{ color: colors.info }}>
            Expand all
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
  if (state === 'loading') {
    return (
      <View className="flex-row items-center justify-center gap-2 py-4">
        <Text variant="muted" className="text-xs">
          Loading more files…
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
        accessibilityLabel="Retry loading next page"
      >
        {/* eslint-disable-next-line react-native/no-inline-styles, react-native/no-color-literals -- dynamic destructive color */}
        <Text className="text-sm" style={{ color: colors.destructive }}>
          Failed to load more files — tap to retry
        </Text>
      </Pressable>
    );
  }
  if (state === 'fetch-to-completion') {
    return (
      <View className="flex-row items-center justify-center gap-2 py-4">
        <Text variant="muted" className="text-xs">
          Loading all files — {loadedFiles.toLocaleString()}
          {totalFiles ? ` of ${totalFiles.toLocaleString()}` : ''}…
        </Text>
      </View>
    );
  }
  if (state === 'no-pages') {
    return (
      <View className="flex-row items-center justify-center gap-3 py-4">
        <Text variant="muted" className="text-xs">
          {loadedFiles.toLocaleString()} of {totalFiles?.toLocaleString() ?? '?'} files loaded
        </Text>
        <Pressable
          onPress={onFetchAll}
          className="rounded-md border border-border bg-card px-3 py-1 active:opacity-70"
          accessibilityRole="button"
          accessibilityLabel="Load all files"
        >
          <Text className="text-xs font-medium">Load all</Text>
        </Pressable>
      </View>
    );
  }
  return (
    <View className="flex-row items-center justify-center gap-2 py-4">
      <Check size={12} color={colors.mutedForeground} />
      <Text variant="muted" className="text-xs">
        {loadedFiles.toLocaleString()} file{loadedFiles === 1 ? '' : 's'} loaded
        {totalFiles ? ` of ${totalFiles.toLocaleString()}` : ''}
      </Text>
    </View>
  );
}

export function TabStateMessage({ title, message }: { title: string; message: string }) {
  return (
    <View className="flex-1 items-center justify-center gap-2 px-6 py-12">
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
  return (
    <View className="flex-1 items-center justify-center gap-3 px-6 py-16">
      <File size={28} color={colors.mutedForeground} />
      <Text className="text-lg font-semibold text-foreground">No files changed</Text>
      <Text variant="muted" className="text-center">
        {changedFiles === 0
          ? 'This pull request has no file changes.'
          : 'Files are still loading. Pull to refresh.'}
      </Text>
      {onRequestOverview ? (
        <Pressable
          onPress={onRequestOverview}
          className="mt-2 rounded-md border border-border bg-card px-3 py-2 active:opacity-70"
          accessibilityRole="button"
          accessibilityLabel="Go to Overview tab"
        >
          <Text className="text-sm font-medium">Go to Overview</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
