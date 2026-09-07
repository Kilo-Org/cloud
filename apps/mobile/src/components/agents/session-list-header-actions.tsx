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
          // right slop capped so the expanded targets don't overlap inside the
          // 16px gap; left slop makes up the difference to a 44pt-wide target
          hitSlop={{ top: 11, bottom: 11, left: 14, right: 8 }}
          accessibilityRole="button"
          accessibilityLabel={t('common.newSession')}
          className="active:opacity-70"
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
