// A single file row in the PR file navigator sheet. Tap the path/stats
// cluster to open the file in the diff list (sends a
// `requestScrollToFile` request and dismisses the sheet). A separate
// trailing mark-viewed icon toggle flips the per-PR viewed set without
// dismissing — non-nested sibling of the select pressable (AC6).

import { Pressable, View } from 'react-native';

import { MarkViewedToggle } from '@/components/pr-review/diff/pr-diff-file-rows';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type PrReviewFile } from '@/lib/pr-review/diff/pr-review-file-types';

function splitPath(path: string): { dir: string; basename: string } {
  const slash = path.lastIndexOf('/');
  if (slash === -1) {
    return { dir: '', basename: path };
  }
  return { dir: path.slice(0, slash + 1), basename: path.slice(slash + 1) };
}

export function NavigatorFileRow({
  file,
  viewed,
  onSelect,
  onToggleViewed,
}: {
  file: PrReviewFile;
  viewed: boolean;
  onSelect: () => void;
  onToggleViewed: () => void;
}) {
  const colors = useThemeColors();
  const { dir, basename } = splitPath(file.path);
  return (
    <View className="flex-row items-center border-b border-hair-soft bg-card px-4 py-2.5">
      <Pressable
        onPress={onSelect}
        accessibilityRole="button"
        accessibilityLabel={`Open ${file.path}${viewed ? ' (viewed)' : ''}`}
        className="min-h-11 flex-1 flex-row items-center active:opacity-70"
      >
        <View className="flex-1 pr-3">
          <View className="flex-row items-baseline">
            {dir.length > 0 ? (
              <Text
                variant="muted"
                className="text-sm"
                // eslint-disable-next-line react-native/no-inline-styles, react-native/no-color-literals -- dynamic muted color
                style={{ color: colors.mutedForeground }}
                numberOfLines={1}
              >
                {dir}
              </Text>
            ) : null}
            <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
              {basename}
            </Text>
          </View>
          <View className="mt-0.5 flex-row items-center gap-2">
            <Text variant="muted" className="text-xs">
              +{file.additions}
            </Text>
            <Text variant="muted" className="text-xs">
              -{file.deletions}
            </Text>
            {file.patchMissing ? (
              <Text variant="muted" className="text-xs">
                diff too large
              </Text>
            ) : null}
          </View>
        </View>
      </Pressable>
      <MarkViewedToggle path={file.path} viewed={viewed} onToggle={onToggleViewed} />
    </View>
  );
}
