import { Plus, SlidersHorizontal } from 'lucide-react-native';
import { Pressable, View } from 'react-native';

import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type SessionListHeaderActionsProps = {
  hasActiveFilter: boolean;
  onNewSession: () => void;
  onOpenFilters: () => void;
};

export function SessionListHeaderActions({
  hasActiveFilter,
  onNewSession,
  onOpenFilters,
}: Readonly<SessionListHeaderActionsProps>) {
  const colors = useThemeColors();

  return (
    <View className="flex-row items-center gap-4">
      <Pressable
        onPress={onNewSession}
        // right slop capped so the expanded targets don't overlap inside the 16px gap
        hitSlop={{ top: 11, bottom: 11, left: 11, right: 8 }}
        accessibilityRole="button"
        accessibilityLabel="New session"
        className="active:opacity-70"
      >
        <Plus size={22} color={colors.foreground} />
      </Pressable>
      <Pressable
        onPress={onOpenFilters}
        hitSlop={{ top: 12, bottom: 12, left: 8, right: 12 }}
        accessibilityRole="button"
        accessibilityLabel="Filter sessions"
        className="active:opacity-70"
      >
        <SlidersHorizontal
          size={20}
          color={hasActiveFilter ? colors.foreground : colors.mutedForeground}
        />
      </Pressable>
    </View>
  );
}
