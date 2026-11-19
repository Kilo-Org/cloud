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
 * between the Overview, Files, and Discussion tabs. The parent screen owns the
 * tab state; each tab body only renders itself.
 */
export function PrReviewTabSelector({
  activeTab,
  onChange,
  discussionCount,
  disabledTabs = NO_DISABLED_TABS,
}: PrReviewTabSelectorProps) {
  const { t } = useTranslation();
  const options = TABS.map(tab => ({
    value: tab.id,
    label: t(tab.labelKey),
    disabled: disabledTabs.includes(tab.id),
    badge:
      tab.id === 'discussion' && discussionCount && discussionCount > 0 ? (
        <DiscussionCountBadge count={discussionCount} />
      ) : undefined,
  }));
  return (
    <SegmentedControl
      accessibilityLabel={t('common.prReview')}
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
