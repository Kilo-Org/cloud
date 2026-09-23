import { SlidersHorizontal } from '@/components/ui/icons';
import { type Insets, Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { filterButtonAccessibilityLabel } from '@/components/agents/session-filter-button-label';
import { Text } from '@/components/ui/text';
import { COMPACT_CONTROL_HIT_SLOP_DP } from '@/lib/a11y/tap-target';
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
 * 36pt square + 8pt slop = 52pt, past the 44pt minimum target `DESIGN.md` asks
 * for. The box is a real layout size, not slop alone: the on-device explorer
 * measures laid-out bounds and `hitSlop` never widens them. `h-[36px]`, not
 * `h-9` — the app's native rem is 14pt, so `h-9` lays out at 31.5pt. The box
 * carries `shrink-0`, so the header row cannot squeeze it under the audit's
 * 28dp floor.
 *
 * The sides are spelled out rather than a single uniform number: the agents
 * header row caps this control's two horizontal sides at its `gap-4` gap (the
 * row mirrors under RTL while `hitSlop` does not, so the cap cannot sit on one
 * physical side) and passes the capped insets in through the prop below. The
 * test that guards that invariant reads the insets.
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
      // glyph; `FILTER_HIT_SLOP` above carries it past the 44pt minimum. A
      // caller sharing a row may state the sides it faces, so the two touch
      // regions can meet inside the row gap instead of overlapping.
      hitSlop={hitSlop}
      accessibilityRole="button"
      // The count is spoken as part of the name, so no new translated string is
      // needed to announce "Filter sessions, 2".
      accessibilityLabel={filterButtonAccessibilityLabel(
        t('agentChat.sessionFilter.title'),
        activeCount
      )}
      testID={testID}
      className="h-[36px] w-[36px] shrink-0 items-center justify-center active:opacity-70"
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
