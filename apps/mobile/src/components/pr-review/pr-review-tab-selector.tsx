import * as Haptics from 'expo-haptics';
import { Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

export type PrReviewTabId = 'overview' | 'files' | 'discussion';

type PrReviewTab = {
  id: PrReviewTabId;
  label: string;
};

const TABS: readonly PrReviewTab[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'files', label: 'Files' },
  { id: 'discussion', label: 'Discussion' },
];

type PrReviewTabSelectorProps = {
  activeTab: PrReviewTabId;
  onChange: (tab: PrReviewTabId) => void;
};

/**
 * Horizontal pill row at the top of the PR review surface that picks
 * between the Overview, Files, and Discussion tabs. S5 owns the API;
 * S6b (Files body) and S7b (Discussion body) only ever render their
 * respective tab bodies — the parent screen owns the tab state.
 */
export function PrReviewTabSelector({ activeTab, onChange }: PrReviewTabSelectorProps) {
  return (
    <View accessibilityRole="tablist" className="flex-row gap-1 rounded-lg bg-secondary p-1">
      {TABS.map(tab => {
        const active = tab.id === activeTab;
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
              active && 'bg-card shadow-sm shadow-black/5'
            )}
          >
            <Text
              className={cn(
                'text-sm',
                active ? 'font-semibold text-foreground' : 'text-muted-foreground'
              )}
            >
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
