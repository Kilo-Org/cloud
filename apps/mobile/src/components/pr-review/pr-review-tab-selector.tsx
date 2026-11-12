import { selectionHaptic } from '@/lib/haptics';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { tabEntryA11y } from '@/lib/a11y/tab-entry';
import { formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';

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
 * Horizontal pill row at the top of the PR review surface that picks
 * between the Overview, Files, and Discussion tabs. S5 owns the API;
 * S6b (Files body) and S7b (Discussion body) only ever render their
 * respective tab bodies — the parent screen owns the tab state.
 */
export function PrReviewTabSelector({
  activeTab,
  onChange,
  discussionCount,
  disabledTabs = NO_DISABLED_TABS,
}: PrReviewTabSelectorProps) {
  const { t } = useTranslation();
  return (
    <View accessibilityRole="tablist" className="flex-row gap-1 rounded-lg bg-secondary p-1">
      {TABS.map(tab => {
        const active = tab.id === activeTab;
        const disabled = disabledTabs.includes(tab.id);
        const badge =
          tab.id === 'discussion' && discussionCount && discussionCount > 0
            ? formatNumber(discussionCount, i18n.language)
            : null;
        return (
          <Pressable
            key={tab.id}
            {...tabEntryA11y({ selected: active, disabled })}
            disabled={disabled}
            onPress={() => {
              if (active) {
                return;
              }
              selectionHaptic();
              onChange(tab.id);
            }}
            className={cn(
              'flex-1 items-center justify-center rounded-md py-2 active:opacity-70',
              // Dark paints `bg-card` below the row's `bg-secondary`, so the
              // selected pill takes the palette's elevated neutral fill
              // instead: the same raised-surface step a filled neutral control
              // uses, so the pill stays the neutral raised surface light mode
              // shows rather than a tinted accent that pulls the eye.
              active && 'bg-card shadow-sm shadow-[#0000000D] dark:bg-secondary-fill',
              disabled && 'opacity-60'
            )}
          >
            <View className="flex-row items-center gap-1">
              <Text
                className={cn(
                  'text-sm',
                  active ? 'font-semibold text-foreground' : 'text-muted-foreground dark:text-ink2'
                )}
              >
                {t(tab.labelKey)}
              </Text>
              {badge ? (
                // `muted` equals the row's `secondary` in both palettes, so the
                // badge fills with `muted-soft` to read as a pill at all.
                <View className="min-w-5 items-center justify-center rounded-full bg-muted-soft px-1.5 py-0.5">
                  <Text className="text-center text-[11px] font-medium text-foreground">
                    {badge}
                  </Text>
                </View>
              ) : null}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}
