import { IconButton } from '@/components/ui/icon-button';
import { Plus } from '@/components/ui/icons';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { SessionFilterButton } from '@/components/agents/session-filter-button';
import { COMPACT_CONTROL_HIT_SLOP_DP } from '@/lib/a11y/tap-target';
import { COMPACT_CONTROL_HIT_SLOP_DP as FILTER_HIT_SLOP_DP } from '@/lib/a11y/touch-target';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

// The row's `gap-4` compiles to 14pt, not 16pt: NativeWind v5 fixes 1rem at
// 14pt, so `gap-4` (1rem) is 14pt. The filter control sits to the right with
// its own 3pt left slop, so the new-session control caps its right side at 6:
// the two facing slops total 9pt, inside the gap, and 32 + 8 + 6 = 46pt still
// clears `DESIGN.md:364`'s 44pt. The filter's slop is spelled per side too, so
// that meeting can be checked instead of only the smallest of its four sides.
const NEW_SESSION_HIT_SLOP = {
  top: COMPACT_CONTROL_HIT_SLOP_DP,
  bottom: COMPACT_CONTROL_HIT_SLOP_DP,
  left: COMPACT_CONTROL_HIT_SLOP_DP,
  right: 6,
};

const FILTER_HIT_SLOP = {
  top: FILTER_HIT_SLOP_DP,
  bottom: FILTER_HIT_SLOP_DP,
  left: FILTER_HIT_SLOP_DP,
  right: FILTER_HIT_SLOP_DP,
};

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
        <IconButton
          onPress={onNewSession}
          accessibilityLabel={t('common.newSession')}
          hitSlop={NEW_SESSION_HIT_SLOP}
        >
          <Plus size={22} color={colors.foreground} />
        </IconButton>
      ) : null}
      <SessionFilterButton
        activeCount={activeFilterCount}
        hitSlop={FILTER_HIT_SLOP}
        onPress={onOpenFilters}
        testID="agents-open-filters"
      />
    </View>
  );
}
