import { SlidersHorizontal } from '@/components/ui/icons';
import { Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';

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
      // left slop capped against the 16px gap, right slop reaches 44pt wide
      hitSlop={{ top: 12, bottom: 12, left: 8, right: 16 }}
      accessibilityRole="button"
      accessibilityLabel={t('agentChat.sessionFilter.title')}
      // The count is spoken as the button's value, so no new translated string
      // is needed to announce "Filter sessions, 2".
      accessibilityValue={isActive ? { text: String(activeCount) } : undefined}
      testID={testID}
      className="active:opacity-70"
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
