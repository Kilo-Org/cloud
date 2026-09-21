import { SlidersHorizontal } from '@/components/ui/icons';
import { Pressable, View } from 'react-native';
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
};

/**
 * 36pt square + 8pt slop = 52pt, past the 44pt minimum target `DESIGN.md` asks
 * for. The box is a real layout size, not slop alone: the on-device explorer
 * measures laid-out bounds and `hitSlop` never widens them. `h-[36px]`, not
 * `h-9` — the app's native rem is 14pt, so `h-9` lays out at 31.5pt.
 *
 * The sides are spelled out rather than a single uniform number: the row's
 * sibling control (`session-list-header-actions.tsx`) caps its facing right
 * slop against this control's left slop at the row's 14pt gap, and the test
 * that guards that invariant reads the insets.
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
}: Readonly<SessionFilterButtonProps>) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  const isActive = activeCount > 0;

  return (
    <Pressable
      onPress={onPress}
      hitSlop={FILTER_HIT_SLOP}
      accessibilityRole="button"
      // The count is spoken as part of the name, so no new translated string is
      // needed to announce "Filter sessions, 2".
      accessibilityLabel={filterButtonAccessibilityLabel(
        t('agentChat.sessionFilter.title'),
        activeCount
      )}
      testID={testID}
      className="h-[36px] w-[36px] items-center justify-center active:opacity-70"
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
