import * as Haptics from 'expo-haptics';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
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
};

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
}: PrReviewTabSelectorProps) {
  const { t } = useTranslation();
  return (
    <View accessibilityRole="tablist" className="flex-row gap-1 rounded-lg bg-secondary p-1">
      {TABS.map(tab => {
        const active = tab.id === activeTab;
        const badge =
          tab.id === 'discussion' && discussionCount && discussionCount > 0
            ? formatNumber(discussionCount, i18n.language)
            : null;
        return (
          <Pressable
            key={tab.id}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            onPress={() => {
              if (active) {
                return;
              }
              void Haptics.selectionAsync();
              onChange(tab.id);
            }}
            className={cn(
              'flex-1 items-center justify-center rounded-md py-2 active:opacity-70',
              active && 'bg-card shadow-sm shadow-[#0000000D]'
            )}
          >
            <View className="flex-row items-center gap-1.5">
              <Text
                className={cn(
                  'text-sm',
                  active ? 'font-semibold text-foreground' : 'text-muted-foreground'
                )}
              >
                {t(tab.labelKey)}
              </Text>
              {badge ? (
                <View className="min-w-5 rounded-full bg-muted px-1.5 py-0.5">
                  <Text className="text-center text-[11px] text-muted-foreground">{badge}</Text>
                </View>
              ) : null}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}
