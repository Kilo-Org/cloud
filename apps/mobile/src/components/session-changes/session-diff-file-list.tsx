// Read-only diff list for a session's changes. Reuses the PR diff builder and
// rows with a `session` source: no viewed toggles, no gap expansion, no line
// selection, and no pagination (the server returns the whole diff at once).

import { FlashList } from '@shopify/flash-list';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  DiffFontMetricsContext,
  useBoundedDiffFontMetrics,
} from '@/components/pr-review/diff/diff-font-metrics';
import { useDiffRenderItem } from '@/components/pr-review/diff/pr-diff-file-list-render';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { formatNumber } from '@/lib/format';
import { useDetailScreenBottomPadding, useSideInsetStyle } from '@/lib/screen-insets';
import { buildFileItems } from '@/lib/pr-review/diff/pr-diff-list-builder';
import { itemTypeFor } from '@/lib/pr-review/diff/pr-diff-list-items';
import { type PrReviewFile } from '@/lib/pr-review/diff/pr-review-file-types';
import { stickyFileHeaderIndices } from '@/lib/pr-review/diff/sticky-file-headers';

/**
 * A list this short opens with every file expanded; a longer one keeps the PR
 * list's default of all files collapsed, so the reader scans paths first.
 */
const AUTO_EXPAND_MAX_FILES = 5;

export function SessionDiffFileList({ files }: Readonly<{ files: PrReviewFile[] }>) {
  const { t } = useTranslation();
  const diffFontMetrics = useBoundedDiffFontMetrics();
  const bottomPadding = useDetailScreenBottomPadding();
  const sideInsetStyle = useSideInsetStyle();
  const insets = useSafeAreaInsets();
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() =>
    files.length <= AUTO_EXPAND_MAX_FILES
      ? Object.fromEntries(files.map(file => [file.path, true]))
      : {}
  );

  const items = useMemo(
    () =>
      buildFileItems({
        files,
        expanded,
        changedFiles: files.length,
        source: { kind: 'session' },
      }),
    [files, expanded]
  );
  const stickyHeaderIndices = useMemo(() => stickyFileHeaderIndices(items), [items]);
  const renderItem = useDiffRenderItem({ source: 'session', setExpanded });
  const contentContainerStyle = useMemo(
    () => ({ paddingBottom: bottomPadding, paddingLeft: insets.left, paddingRight: insets.right }),
    [bottomPadding, insets.left, insets.right]
  );

  const totals = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    for (const file of files) {
      additions += file.additions;
      deletions += file.deletions;
    }
    return { additions, deletions };
  }, [files]);

  return (
    <DiffFontMetricsContext.Provider value={diffFontMetrics}>
      <View className="flex-1">
        <View
          className="flex-row items-center gap-2 border-b border-hair-soft bg-background px-4 py-3"
          testID="session-changes-totals"
        >
          <View className="flex-row items-center gap-2" style={sideInsetStyle}>
            <Text className="text-xs font-medium text-foreground">
              {t('agentChat.toolCard.filesBadge', {
                count: files.length,
                displayCount: formatNumber(files.length, i18n.language),
              })}
            </Text>
            <Text variant="muted" className="text-xs tabular-nums">
              +{formatNumber(totals.additions, i18n.language)}
            </Text>
            <Text variant="muted" className="text-xs tabular-nums">
              -{formatNumber(totals.deletions, i18n.language)}
            </Text>
          </View>
        </View>
        <FlashList
          data={items}
          renderItem={renderItem}
          keyExtractor={item => item.key}
          getItemType={item => itemTypeFor(item)}
          stickyHeaderIndices={stickyHeaderIndices}
          // Expand / collapse above the viewport misfires mVCP and jumps the
          // list, as on the PR diff list.
          maintainVisibleContentPosition={{ disabled: true }}
          // Re-measure rows when the bounded font scale changes.
          extraData={diffFontMetrics.scale}
          contentContainerStyle={contentContainerStyle}
          ItemSeparatorComponent={null}
        />
      </View>
    </DiffFontMetricsContext.Provider>
  );
}
