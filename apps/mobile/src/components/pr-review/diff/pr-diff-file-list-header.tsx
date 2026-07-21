// Compact header row for the PR Files tab. Shown above the FlashList
// with two responsibilities:
//   1. Navigator entry: "Files · n of m viewed" pressable that opens
//      the file-navigator sheet route. Always visible.
//   2. Tablet layout toggle: unified vs side-by-side. Only on tablets
//      (the `useIsTablet` hook gates it). The selection is local
//      component state — not persisted across mounts.
//
// Phones see the navigator entry only. Tablets see both.

import { type Href, useRouter } from 'expo-router';
import { Columns2, Rows3 } from 'lucide-react-native';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { useIsTablet } from '@/lib/hooks/use-is-tablet';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type DiffViewMode } from '@/lib/pr-review/diff/pr-diff-list-items';
import { cn } from '@/lib/utils';

type PrDiffFileListHeaderProps = {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly viewedCount: number;
  readonly totalListed: number;
  readonly isTruncated: boolean;
  readonly viewMode: DiffViewMode;
  readonly onViewModeChange: (mode: DiffViewMode) => void;
};

const FILE_NAVIGATOR_PATH = '/(app)/pr-review/[owner]/[repo]/[number]/file-navigator' as const;

export function PrDiffFileListHeader({
  owner,
  repo,
  number,
  viewedCount,
  totalListed,
  isTruncated,
  viewMode,
  onViewModeChange,
}: PrDiffFileListHeaderProps) {
  const router = useRouter();
  const isTablet = useIsTablet();
  const colors = useThemeColors();

  const navigatorHref = useMemo<Href>(
    () => ({ pathname: FILE_NAVIGATOR_PATH, params: { owner, repo, number } }),
    [owner, repo, number]
  );

  const handleOpenNavigator = useCallback(() => {
    router.push(navigatorHref);
  }, [router, navigatorHref]);

  return (
    <View className="flex-row items-center justify-between border-b border-hair-soft bg-background px-4 py-2">
      <Pressable
        onPress={handleOpenNavigator}
        accessibilityRole="button"
        accessibilityLabel="Open file navigator"
        className="min-h-9 flex-row items-center gap-1.5 rounded-md px-2 active:opacity-70"
        hitSlop={6}
      >
        <Rows3 size={14} color={colors.mutedForeground} />
        <Text className="text-xs font-medium text-foreground">
          Files · {viewedCount.toLocaleString()} of {totalListed.toLocaleString()} viewed
        </Text>
        {isTruncated ? (
          <Text
            variant="muted"
            className="text-[10px]"
            // eslint-disable-next-line react-native/no-inline-styles, react-native/no-color-literals -- dynamic muted color
            style={{ color: colors.mutedForeground }}
          >
            (listed)
          </Text>
        ) : null}
      </Pressable>
      {isTablet ? <ViewModeToggle viewMode={viewMode} onChange={onViewModeChange} /> : null}
    </View>
  );
}

function ViewModeToggle({
  viewMode,
  onChange,
}: {
  viewMode: DiffViewMode;
  onChange: (mode: DiffViewMode) => void;
}) {
  const colors = useThemeColors();
  return (
    <View
      className="flex-row overflow-hidden rounded-md border border-border bg-card"
      accessibilityRole="radiogroup"
      accessibilityLabel="Diff layout"
    >
      <ViewModeButton
        active={viewMode === 'unified'}
        label="Unified"
        onPress={() => {
          onChange('unified');
        }}
        testId="diff-mode-unified"
        colors={colors}
      />
      <ViewModeButton
        active={viewMode === 'side-by-side'}
        label="Side by side"
        onPress={() => {
          onChange('side-by-side');
        }}
        testId="diff-mode-side-by-side"
        colors={colors}
      />
    </View>
  );
}

function ViewModeButton({
  active,
  label,
  onPress,
  testId,
  colors,
}: {
  active: boolean;
  label: string;
  onPress: () => void;
  testId: string;
  colors: ReturnType<typeof useThemeColors>;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected: active }}
      accessibilityLabel={label}
      testID={testId}
      className={cn(
        'min-h-9 flex-row items-center gap-1.5 px-3 active:opacity-70',
        active && 'bg-secondary'
      )}
    >
      <Columns2 size={12} color={active ? colors.foreground : colors.mutedForeground} />
      <Text
        className={cn(
          'text-xs',
          active ? 'font-semibold text-foreground' : 'text-muted-foreground'
        )}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * Convenience hook for the diff list screen: returns the current view
 * mode plus a setter. Default is `unified`. The toggle is local state
 * (not persisted) per the S6c spec.
 */
export function useDiffViewMode(): {
  viewMode: DiffViewMode;
  setViewMode: (mode: DiffViewMode) => void;
} {
  const [viewMode, setViewMode] = useState<DiffViewMode>('unified');
  return { viewMode, setViewMode };
}
