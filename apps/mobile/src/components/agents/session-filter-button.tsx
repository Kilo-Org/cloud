import { SlidersHorizontal } from '@/components/ui/icons';
import { type Insets, Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { filterButtonAccessibilityLabel } from '@/components/agents/session-filter-button-label';
import { Text } from '@/components/ui/text';
import { COMPACT_CONTROL_HIT_SLOP_DP } from '@/lib/a11y/touch-target';
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
 * Filter affordance shared by both session-list pages: the sliders icon, plus
 * a count badge while filters are applied. The count is the point — it tells
 * the user the list is narrowed without making them open the picker.
 */
export function SessionFilterButton({
  activeCount,
  onPress,
  testID,
  hitSlop = COMPACT_CONTROL_HIT_SLOP_DP,
}: Readonly<SessionFilterButtonProps>) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  const isActive = activeCount > 0;

  return (
    <Pressable
      onPress={onPress}
      // The frame is the tap target the size audit measures, not the 20pt
      // glyph: `h-11 w-11` is 38.5pt on device, and the 3pt slop carries it to
      // the 44pt minimum. It fits the header's own `min-h-11` row, so the
      // header keeps its height.
      hitSlop={hitSlop}
      accessibilityRole="button"
      // The count is spoken as part of the name, so no new translated string is
      // needed to announce "Filter sessions, 2".
      accessibilityLabel={filterButtonAccessibilityLabel(
        t('agentChat.sessionFilter.title'),
        activeCount
      )}
      testID={testID}
      className="h-11 w-11 shrink-0 items-center justify-center active:opacity-70"
    >
      {/* The badge stays pinned to the glyph's corner, not the frame's. */}
      <View>
        <SlidersHorizontal
          size={20}
          color={isActive ? colors.foreground : colors.mutedForeground}
        />
        {isActive ? (
          // Overlaps the icon's top-right corner; `pointer-events-none` keeps the
          // whole 44pt target on the Pressable underneath.
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
