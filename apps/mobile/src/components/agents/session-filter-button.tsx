import { SlidersHorizontal } from '@/components/ui/icons';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { filterButtonAccessibilityLabel } from '@/components/agents/session-filter-button-label';
import { IconButton } from '@/components/ui/icon-button';
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
    <IconButton
      onPress={onPress}
      // The count is spoken as part of the name, so no new translated string is
      // needed to announce "Filter sessions, 2".
      accessibilityLabel={filterButtonAccessibilityLabel(
        t('agentChat.sessionFilter.title'),
        activeCount
      )}
      testID={testID}
    >
      {/* Anchors the badge to the icon rather than to the 32pt touch box. */}
      <View className="h-[20px] w-[20px] items-center justify-center">
        <SlidersHorizontal
          size={20}
          color={isActive ? colors.foreground : colors.mutedForeground}
        />
        {isActive ? (
          // Overlaps the icon's top-right corner; `pointer-events-none` keeps the
          // whole touch target on the Pressable underneath.
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
    </IconButton>
  );
}
