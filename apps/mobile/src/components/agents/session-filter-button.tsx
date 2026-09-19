import { SlidersHorizontal } from '@/components/ui/icons';
import { Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { filterButtonAccessibilityLabel } from '@/components/agents/session-filter-button-label';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type SessionFilterButtonProps = {
  /** How many filters are applied. Zero renders the plain muted icon. */
  activeCount: number;
  onPress: () => void;
  testID?: string;
};

/**
 * Filter affordance shared by both session-list pages: the sliders icon, plus
 * a count badge while filters are applied. The count is the point — it tells
 * the user the list is narrowed without making them open the picker.
 *
 * The icon sits in a 30pt visible box so the control itself is big enough to
 * hit; `hitSlop` then lifts the touch target to the 44pt minimum.
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
      // The visible control is an exact 30pt box: Tailwind's rem-scaled h-7
      // paints only 24.5pt here (rem ≈ 14), under the ≥28pt small-control bar.
      // 8pt of slop on every side then reaches the 44pt minimum touch target.
      // The uniform slop stays inside the header's gap, so it never overlaps
      // the sibling control.
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      accessibilityRole="button"
      // The count is spoken as part of the name, so no new translated string is
      // needed to announce "Filter sessions, 2".
      accessibilityLabel={filterButtonAccessibilityLabel(
        t('agentChat.sessionFilter.title'),
        activeCount
      )}
      testID={testID}
      className="h-[30px] w-[30px] items-center justify-center active:opacity-70"
    >
      <SlidersHorizontal size={20} color={isActive ? colors.foreground : colors.mutedForeground} />
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
    </Pressable>
  );
}
