// A single file row in the PR file navigator sheet. Tap to open the
// file in the diff list (sends a `requestScrollToFile` request and
// dismisses the sheet). A separate "Mark viewed" pressable toggles
// the per-PR viewed set without dismissing.
//
// Owns no haptics — the row's tap is a navigation action, the viewed
// toggle is a checkbox, and both flows already play the
// system/keyboard sound the navigator sheet needs (the row tap goes
// through the navigator which dismisses; the toggle is a deliberate
// state change with a visible "Viewed" / "Mark viewed" label).

import { Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { type PrReviewFile } from '@/lib/pr-review/diff/pr-review-file-types';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

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
    <View className="border-b border-hair-soft bg-card">
      <Pressable
        onPress={onSelect}
        accessibilityRole="button"
        accessibilityLabel={`Open ${file.path}${viewed ? ' (viewed)' : ''}`}
        className="min-h-11 flex-row items-center justify-between px-4 py-2.5 active:opacity-70"
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
      <View className="flex-row items-center justify-end px-4 pb-2">
        <Pressable
          onPress={onToggleViewed}
          hitSlop={10}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: viewed }}
          accessibilityLabel={
            viewed ? `Unmark ${file.path} as viewed` : `Mark ${file.path} as viewed`
          }
          className="rounded-md border border-border bg-card px-2 py-1 active:opacity-70"
        >
          <Text className="text-[11px] font-medium text-foreground">
            {viewed ? 'Viewed' : 'Mark viewed'}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
