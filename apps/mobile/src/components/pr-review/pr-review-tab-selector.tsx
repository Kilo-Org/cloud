import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { SegmentedControl } from '@/components/ui/segmented-control';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { formatNumber } from '@/lib/format';

export type PrReviewTabId = 'overview' | 'files' | 'discussion';

const TABS = [
  { id: 'overview', labelKey: 'prReview.tabs.overview' },
  { id: 'files', labelKey: 'prReview.tabs.files' },
  { id: 'discussion', labelKey: 'prReview.tabs.discussion' },
] as const satisfies readonly { id: PrReviewTabId; labelKey: string }[];

type PrReviewTabSelectorProps = {
  activeTab: PrReviewTabId;
  onChange: (tab: PrReviewTabId) => void;
  /**
   * Conversation plus review comments. Rendered as a badge on the Discussion
   * tab so an empty discussion is visible without opening it; omitted (or 0)
   * while the PR query is still loading, which draws no badge.
   */
  discussionCount?: number;
  /**
   * Tabs whose own reads cannot succeed while the request fails to load, so
   * the row keeps its size but those entries stop switching. The caller
   * leaves out the tab that hosts the failure and its recovery, because that
   * entry is the way back to it.
   */
  disabledTabs?: readonly PrReviewTabId[];
};

const NO_DISABLED_TABS: readonly PrReviewTabId[] = [];

/**
 * The shared segmented control at the top of the PR review surface that picks
 * between the Overview, Files, and Discussion tabs. It keeps tab semantics
 * (a `tablist` of tabs), because each option switches the body below it. The
 * parent screen owns the tab state; each tab body only renders itself.
 */
export function PrReviewTabSelector({
  activeTab,
  onChange,
  discussionCount,
  disabledTabs = NO_DISABLED_TABS,
}: PrReviewTabSelectorProps) {
  const { t } = useTranslation();
  const options = TABS.map(tab => {
    const label = t(tab.labelKey);
    const count =
      tab.id === 'discussion' && discussionCount && discussionCount > 0 ? discussionCount : null;
    return {
      value: tab.id,
      label,
      disabled: disabledTabs.includes(tab.id),
      badge: count === null ? undefined : <DiscussionCountBadge count={count} />,
      // The badge is drawn beside the label, so the spoken name carries the
      // count too: a reader hears that the discussion has comments without
      // opening the tab, as a sighted reader sees.
      accessibilityLabel:
        count === null
          ? undefined
          : t('prReview.tabs.discussionAccessibility', {
              title: label,
              count,
              displayCount: formatNumber(count, i18n.language),
            }),
    };
  });
  return (
    <SegmentedControl
      accessibilityLabel={t('common.prReview')}
      semantics="tabs"
      options={options}
      value={activeTab}
      onChange={onChange}
    />
  );
}

function DiscussionCountBadge({ count }: Readonly<{ count: number }>) {
  // `muted` equals the track's `secondary` in both palettes, so the badge
  // fills with `muted-soft` to read as a pill at all.
  return (
    <View className="min-w-5 items-center justify-center rounded-full bg-muted-soft px-1.5 py-0.5">
      <Text className="text-center text-xs font-medium text-foreground">
        {formatNumber(count, i18n.language)}
      </Text>
    </View>
  );
}
