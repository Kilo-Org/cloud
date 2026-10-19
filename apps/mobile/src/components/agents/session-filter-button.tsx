import { SlidersHorizontal } from '@/components/ui/icons';
import { type Insets, Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { filterButtonAccessibilityLabel } from '@/components/agents/session-filter-button-label';
import { Text } from '@/components/ui/text';
import { COMPACT_CONTROL_HIT_SLOP_DP, ICON_TARGET_BOX_CLASS } from '@/lib/a11y/tap-target';
import { cn } from '@/lib/utils';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type SessionFilterButtonProps = {
  /** How many filters are applied. Zero renders the plain muted icon. */
  activeCount: number;
  onPress: () => void;
  testID?: string;
  /**
   * Per-side reach override. The control's own default is the same slop on
   * every side; a caller that shares a row with another control needs to state
   * the facing sides, so the two touch regions can be checked against the row
   * gap instead of overlapping inside it.
   */
  hitSlop?: number | Insets;
};

/**
 * 48dp square box — Android's minimum touch target, measured by the audit on
 * the node's own rect. The sides are spelled out rather than a single uniform
 * number: the agents header row caps this control's two horizontal sides at
 * its `gap-4` gap (the row mirrors under RTL while `hitSlop` does not, so the
 * cap cannot sit on one physical side) and passes the capped insets in through
 * the prop below. The test that guards that invariant reads the insets. With
 * the 48dp box the slop is reach only; the box alone already meets the target.
 */
const FILTER_HIT_SLOP = {
  top: COMPACT_CONTROL_HIT_SLOP_DP,
  bottom: COMPACT_CONTROL_HIT_SLOP_DP,
  left: COMPACT_CONTROL_HIT_SLOP_DP,
  right: COMPACT_CONTROL_HIT_SLOP_DP,
};

/**
 * Filter affordance shared by both session-list pages: the sliders icon, plus
 * a count badge while filters are applied. The count is the point — it tells
 * the user the list is narrowed without making them open the picker.
 */
export function SessionFilterButton({
  activeCount,
  onPress,
  testID,
  hitSlop = FILTER_HIT_SLOP,
}: Readonly<SessionFilterButtonProps>) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  const isActive = activeCount > 0;

  return (
    <Pressable
      onPress={onPress}
      // The frame is the tap target the size audit measures, not the 20pt
      // glyph; the 48dp box alone meets Android's minimum, and
      // `FILTER_HIT_SLOP` above only extends the reach. A caller sharing a
      // row may state the sides it faces, so the two touch regions can meet
      // inside the row gap instead of overlapping.
      hitSlop={hitSlop}
      accessibilityRole="button"
      // The count is spoken as part of the name, so no new translated string is
      // needed to announce "Filter sessions, 2".
      accessibilityLabel={filterButtonAccessibilityLabel(
        t('agentChat.sessionFilter.title'),
        activeCount
      )}
      testID={testID}
      className={cn(ICON_TARGET_BOX_CLASS, 'shrink-0 active:opacity-70')}
    >
      {/* Anchored to the icon, not the 36pt box, so enlarging the target never
          drifts the badge off the glyph's top-right corner. */}
      <View className="relative">
        <SlidersHorizontal
          size={20}
          color={isActive ? colors.foreground : colors.mutedForeground}
        />
        {isActive ? (
          // Overlaps the icon's top-right corner; `pointer-events-none` keeps the
          // whole target on the Pressable underneath.
          <View
            pointerEvents="none"
            className="absolute -right-1.5 -top-1.5 h-[15px] min-w-[15px] items-center justify-center rounded-full bg-primary px-1"
          >
            <Text
              className="font-mono-medium text-[10px] leading-[normal] text-primary-foreground"
              testID="session-filter-badge"
            >
              {activeCount}
            </Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}
