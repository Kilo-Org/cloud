import { Plus } from '@/components/ui/icons';
import { Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { SessionFilterButton } from '@/components/agents/session-filter-button';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type SessionListHeaderActionsProps = {
  /** How many filters are applied; drives the filter button's count badge. */
  activeFilterCount: number;
  /** Hides the header "New session" button — the empty-state CTA is the only
   * creation affordance while there are no sessions yet. */
  showNewSession: boolean;
  onNewSession: () => void;
  onOpenFilters: () => void;
};

export function SessionListHeaderActions({
  activeFilterCount,
  showNewSession,
  onNewSession,
  onOpenFilters,
}: Readonly<SessionListHeaderActionsProps>) {
  const colors = useThemeColors();
  const { t } = useTranslation();

  return (
    <View className="flex-row items-center gap-4">
      {showNewSession ? (
        <Pressable
          onPress={onNewSession}
          // The visible control is an exact 30pt box: Tailwind's rem-scaled h-7
          // paints only 24.5pt here (rem ≈ 14), under the ≥28pt small-control
          // bar. 8pt of slop on every side then reaches the 44pt minimum touch
          // target without spilling into the gap before the filter button.
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityRole="button"
          accessibilityLabel={t('common.newSession')}
          className="h-[30px] w-[30px] items-center justify-center active:opacity-70"
        >
          <Plus size={22} color={colors.foreground} />
        </Pressable>
      ) : null}
      <SessionFilterButton
        activeCount={activeFilterCount}
        onPress={onOpenFilters}
        testID="agents-open-filters"
      />
    </View>
  );
}
