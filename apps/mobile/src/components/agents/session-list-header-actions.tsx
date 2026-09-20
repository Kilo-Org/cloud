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
          // bar. RN does not mirror hitSlop under RTL, so the horizontal slop
          // is symmetric: the two controls' facing 7pt slops add up to the 14pt
          // `gap-4` gap exactly whichever way the row is laid out, so the touch
          // targets never overlap. The box plus slop reaches the 44pt target.
          hitSlop={{ top: 8, bottom: 8, left: 7, right: 7 }}
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
