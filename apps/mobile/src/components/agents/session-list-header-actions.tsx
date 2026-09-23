import { IconButton } from '@/components/ui/icon-button';
import { Plus } from '@/components/ui/icons';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { SessionFilterButton } from '@/components/agents/session-filter-button';
import { COMPACT_CONTROL_HIT_SLOP_DP } from '@/lib/a11y/tap-target';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

// The row's `gap-4` compiles to 14pt, not 16pt: NativeWind v5 fixes 1rem at
// 14pt. React Native mirrors the row's flex order under RTL but does not mirror
// `hitSlop` (`screen-header.tsx:165`), so a cap spelled on one physical side
// would meet the gap in one direction and overlap it in the other: the
// new-session control keeps the shared symmetric 8pt compact slop, and the
// wider filter frame absorbs the row's 2pt shortfall on both horizontal sides
// (14 - 8 = 6). Whichever way the row mirrors, the facing pair sums to exactly
// the 14pt gap, so the two touch regions meet at its boundary instead of one
// claiming the later sibling's taps inside an overlap.
// 36 + 6 + 6 = 48pt still clears `DESIGN.md:364`'s 44pt.
const FILTER_HIT_SLOP = {
  top: COMPACT_CONTROL_HIT_SLOP_DP,
  bottom: COMPACT_CONTROL_HIT_SLOP_DP,
  left: 6,
  right: 6,
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
        // No `hitSlop` here: `IconButton`'s default is the symmetric 8pt
        // compact slop, the pair's larger half (see `FILTER_HIT_SLOP` above).
        <IconButton onPress={onNewSession} accessibilityLabel={t('common.newSession')}>
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
