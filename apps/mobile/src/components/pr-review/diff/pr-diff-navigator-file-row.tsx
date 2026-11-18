// A single file row in the PR file navigator sheet. Tap the path/stats
// cluster to open the file in the diff list (sends a
// `requestScrollToFile` request and dismisses the sheet). A separate
// trailing mark-viewed icon toggle flips the per-PR viewed set without
// dismissing — non-nested sibling of the select pressable (AC6).

import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { MarkViewedToggle } from '@/components/pr-review/diff/pr-diff-file-rows';
import { Text } from '@/components/ui/text';
import { isolateLtrBidiText, LTR_ISOLATE_CLOSE, LTR_ISOLATE_OPEN } from '@/lib/bidi';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type PrReviewFile } from '@/lib/pr-review/diff/pr-review-file-types';
import { LTR_TEXT_DIRECTION } from '@/lib/rtl-text';

function splitPath(path: string) {
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
  const { t } = useTranslation();
  const { dir, basename } = splitPath(file.path);
  // The isolate opens with the first run, so a path with no directory still
  // opens it: the marks are text, not styles, because a nested run keeps the
  // paragraph's direction.
  const directoryRun = dir.length > 0 ? `${LTR_ISOLATE_OPEN}${dir}` : null;
  const basenameRun =
    directoryRun === null
      ? `${LTR_ISOLATE_OPEN}${basename}${LTR_ISOLATE_CLOSE}`
      : `${basename}${LTR_ISOLATE_CLOSE}`;
  return (
    <View className="flex-row items-center gap-3 border-b border-hair-soft bg-card px-4 py-2.5">
      <Pressable
        onPress={onSelect}
        accessibilityRole="button"
        accessibilityLabel={
          viewed
            ? t('prReview.fileNavigator.openFileViewed', { path: file.path })
            : t('prReview.fileNavigator.openFile', { path: file.path })
        }
        className="min-h-11 min-w-0 flex-1 flex-row items-center active:opacity-70"
      >
        <View className="min-w-0 flex-1">
          {/* One paragraph for the whole path: sibling `Text`s are layout boxes, so
              an RTL row mirrors them and `src/greeting.ts` paints `greeting.tssrc/`.
              The isolate pins the run's order inside an RTL paragraph, which keeps
              the path on the row's start edge. */}
          <Text className="min-w-0 text-sm" numberOfLines={1} ellipsizeMode="middle">
            {directoryRun === null ? null : (
              <Text
                variant="muted"
                // eslint-disable-next-line react-native/no-inline-styles, react-native/no-color-literals -- dynamic muted color + the path's own base direction
                style={{ color: colors.mutedForeground, ...LTR_TEXT_DIRECTION }}
              >
                {directoryRun}
              </Text>
            )}
            <Text className="text-sm font-medium text-foreground" style={LTR_TEXT_DIRECTION}>
              {basenameRun}
            </Text>
          </Text>
          {/* Each count is its own run, and a sign is a neutral: an RTL
              paragraph would take it and paint `+1` as `1+`. The isolate pins
              the count's order; the row itself still mirrors. */}
          <View className="mt-0.5 flex-row items-center gap-2">
            <Text variant="muted" className="text-xs">
              {isolateLtrBidiText(`+${file.additions}`)}
            </Text>
            <Text variant="muted" className="text-xs">
              {isolateLtrBidiText(`-${file.deletions}`)}
            </Text>
            {file.patchMissing ? (
              <Text variant="muted" className="text-xs">
                {t('prReview.fileNavigator.diffTooLarge')}
              </Text>
            ) : null}
          </View>
        </View>
      </Pressable>
      <View className="shrink-0">
        <MarkViewedToggle path={file.path} viewed={viewed} onToggle={onToggleViewed} />
      </View>
    </View>
  );
}
