import { IconButton } from '@/components/ui/icon-button';
import { Plus } from '@/components/ui/icons';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { SessionFilterButton } from '@/components/agents/session-filter-button';
import { COMPACT_CONTROL_HIT_SLOP_DP } from '@/lib/a11y/tap-target';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

// The row's `gap-4` compiles to 14pt, not 16pt: NativeWind v5 fixes 1rem at
// 14pt, so `gap-4` (1rem) is 14pt. The row gives the filter control the same
// 8pt per-side slop as the compact controls, so the shared 8pt right slop would
// overlap its touch region by 2pt; capping the new-session control's right side
// at 14 - 8 leaves the two regions meeting at the gap's boundary.
// 32 + 8 + 6 = 46pt still clears `DESIGN.md:364`'s 44pt.
const NEW_SESSION_HIT_SLOP = {
  top: COMPACT_CONTROL_HIT_SLOP_DP,
  bottom: COMPACT_CONTROL_HIT_SLOP_DP,
  left: COMPACT_CONTROL_HIT_SLOP_DP,
  right: 6,
};

// The filter control sits right of the new-session control, so its left side
// faces that capped slop. Pinning it to the row's 8pt per-side slop keeps the
// facing pair summing to exactly the 14pt gap.
const FILTER_HIT_SLOP = {
  top: COMPACT_CONTROL_HIT_SLOP_DP,
  bottom: COMPACT_CONTROL_HIT_SLOP_DP,
  left: COMPACT_CONTROL_HIT_SLOP_DP,
  right: COMPACT_CONTROL_HIT_SLOP_DP,
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
        onPress={onOpenFilters}
        testID="agents-open-filters"
        hitSlop={FILTER_HIT_SLOP}
      />
    </View>
  );
}
